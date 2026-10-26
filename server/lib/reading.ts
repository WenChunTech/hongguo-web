// SPDX-License-Identifier: GPL-3.0-only
// reading 族接口（搜索 / 联想 / 详情元信息 / 相关作品）。
// 移植自 it00021hot/hongguo-desktop 与 sunnysky123/hongguo-web 的实测结论（GPL-3.0）：
// - 搜索/联想要求**持久化稳定的 device_id** 且**不带 iid**，否则 200+0 字节拒答；
// - HTTP 200 + 空 body = 上游风控，按失败处理（看字节数不看状态码）；
// - 上游限频：请求串行化并保持最小间隔；
// - 签名分支 branch==1 不被受理，复用 app-source 的 _rticket 抖动签名器。
import fs from 'node:fs';
import path from 'node:path';
import { signedApiRequest } from './app-source';

const SEARCH_HOST = 'https://api5-normal-sinfonlinea.fqnovel.com';
const SEARCH_PATH = '/reading/bookapi/search/tab/v';
const SUGGEST_PATH = '/reading/bookapi/search/suggest/v';
const META_PATH = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_detail/v1/';
const PLAN_PATH = '/reading/bookapi/plan/v';
const REQUEST_TIMEOUT = 15000;
const THROTTLE_MS = 260;
const RETRY_PAUSE_MS = 500;
const CACHE_TTL = 10 * 60 * 1000;

let dataDir = '';
let deviceIdValue = '';

export function setReadingDataDir(dir: string) {
  dataDir = dir;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'device-id.json'), 'utf8'));
    if (typeof saved.device_id === 'string' && /^\d{10,20}$/.test(saved.device_id)) {
      deviceIdValue = saved.device_id;
      return;
    }
  } catch { /* 首次生成 */ }
  deviceIdValue = String(10n ** 15n + BigInt(Math.floor(Math.random() * 9e15)));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'device-id.json'), JSON.stringify({ device_id: deviceIdValue }), { mode: 0o600 });
  } catch { /* 只读环境退化为进程内稳定标识 */ }
}

// 上游节流：所有签名请求过同一条队列，最小间隔 THROTTLE_MS
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

function throttle<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + THROTTLE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  }).then(job, job);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function signedGet(apiUrl: string, query: Record<string, string>): Promise<any> {
  return throttle(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const signed = signedApiRequest(apiUrl, query, null);
      const res = await fetch(signed.url, { headers: signed.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        // 200 + 0 字节 = 风控/签名拒绝；稍候重签再试一次（立即重试只会撞进同一风控窗口）
        if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS)); continue; }
        throw Object.assign(new Error('接口返回空响应，已尝试签名重试'), { code: 'EMPTY_RESPONSE' });
      }
      const parsed = JSON.parse(buf.toString('utf8'));
      if (Number(parsed.code ?? 0) !== 0) {
        throw Object.assign(new Error(`接口返回 code=${parsed.code} ${parsed.message ?? ''}`.trim()), { code: 'BUSINESS_REJECTED', upstreamCode: parsed.code });
      }
      return parsed;
    }
    throw new Error('unreachable');
  });
}

async function signedPost(apiUrl: string, query: Record<string, string>, body: unknown): Promise<any> {
  return throttle(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const signed = signedApiRequest(apiUrl, query, JSON.stringify(body));
      const res = await fetch(signed.url, {
        method: 'POST', headers: signed.headers, body: new Uint8Array(signed.body!),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS)); continue; }
        throw Object.assign(new Error('接口返回空响应，已尝试签名重试'), { code: 'EMPTY_RESPONSE' });
      }
      const parsed = JSON.parse(buf.toString('utf8'));
      if (Number(parsed.code ?? 0) !== 0) {
        throw Object.assign(new Error(`接口返回 code=${parsed.code} ${parsed.message ?? ''}`.trim()), { code: 'BUSINESS_REJECTED', upstreamCode: parsed.code });
      }
      return parsed;
    }
    throw new Error('unreachable');
  });
}

// ── 搜索 ─────────────────────────────────────────────────────────────────

export interface SearchRow {
  series_id: string; series_title: string; series_intro: string;
  cover: string; episode_cnt: number;
  score?: string; play_cnt?: number; heat?: string;
}

interface SearchCacheEntry { expires: number; pages: Map<number, { rows: SearchRow[]; hasMore: boolean; nextOffset: number; searchId: string }> }
const searchCache = new Map<string, SearchCacheEntry>();

/** video_data 可能是数组也可能是单对象，两种都要平铺。 */
function flatVideoCells(cell: any): any[] {
  if (!cell) return [];
  return Array.isArray(cell.video_data) ? cell.video_data : cell.video_data ? [cell.video_data] : [];
}

function parseSearchPage(payload: any): { rows: SearchRow[]; hasMore: boolean; nextOffset: number; searchId: string } {
  // search_tabs 在顶层（联想类接口才包一层 data）
  const tabs = Array.isArray(payload?.search_tabs) ? payload.search_tabs : Array.isArray(payload?.data?.search_tabs) ? payload.data.search_tabs : [];
  let best: { rows: SearchRow[]; hasMore: boolean; nextOffset: number; searchId: string } | null = null;
  for (const tab of tabs) {
    // tab_type 11=综合（字段最全）；找不到时取第一个有内容的 tab
    const rows: SearchRow[] = [];
    for (const cell of Array.isArray(tab?.data) ? tab.data : []) {
      for (const vd of flatVideoCells(cell)) {
        const sid = String(vd?.series_id ?? cell?.book_id ?? '');
        if (!/^\d{6,}$/.test(sid)) continue; // 无 series_id 的条目（小说/用户等）丢弃
        rows.push({
          series_id: sid,
          series_title: String(vd.series_title || vd.title || cell.name || '').trim(),
          series_intro: String(vd.series_intro ?? '').trim(),
          cover: String(vd.series_cover || vd.cover || '').replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&'),
          episode_cnt: Number(vd.episode_cnt) || 0,
          ...(vd.score ? { score: String(vd.score) } : {}),
          ...(vd.play_cnt ? { play_cnt: Number(vd.play_cnt) } : {}),
          ...(typeof vd.rec_text === 'string' && vd.rec_text.includes('热度') ? { heat: vd.rec_text } : {}),
        });
      }
    }
    const page = {
      rows,
      hasMore: tab.has_more === true,
      nextOffset: Number(tab.next_offset) || 0,
      searchId: String(tab.search_id ?? ''),
    };
    if (rows.length && (!best || Number(tab.tab_type) === 11)) {
      best = page;
      if (Number(tab.tab_type) === 11) break;
    }
  }
  return best ?? { rows: [], hasMore: false, nextOffset: 0, searchId: '' };
}

/** 签名搜索一页。首页 offset=0/searchId=''；翻页原样回传 nextOffset/searchId。 */
export async function searchAppPage(keyword: string, offset = 0, searchId = ''): Promise<{ rows: SearchRow[]; hasMore: boolean; nextOffset: number; searchId: string }> {
  const query: Record<string, string> = {
    query: keyword, tab_name: 'feed', search_source: '1', offset: String(offset), count: '10',
    use_correct: 'true', iid: '', device_id: deviceIdValue,
  };
  if (offset > 0 && searchId) { query.passback = String(offset); query.search_id = searchId; }
  const payload = await signedGet(`${SEARCH_HOST}${SEARCH_PATH}`, query);
  return parseSearchPage(payload);
}

/** 联想接口里带剧集的词条 → 搜索行。签名搜索 0 条/被风控时的兜底数据源。 */
async function suggestSeriesRows(keyword: string): Promise<SearchRow[]> {
  return (await searchSuggest(keyword))
    .filter((row) => row.seriesId && row.seriesTitle)
    .map((row) => ({
      series_id: row.seriesId!, series_title: row.seriesTitle!, series_intro: '',
      cover: row.cover ?? '', episode_cnt: 0,
      ...(row.abstract.includes('热度') ? { heat: row.abstract } : {}),
    }));
}

export async function searchSeries(keyword: string, offset = 0, searchId = '') {
  const clean = String(keyword || '').trim().slice(0, 60);
  if (!clean) return { success: false as const, error: '请输入搜索关键词' };
  const cacheKey = clean;
  let entry = searchCache.get(cacheKey);
  if (!entry || entry.expires < Date.now()) {
    entry = { expires: Date.now() + CACHE_TTL, pages: new Map() };
    searchCache.set(cacheKey, entry);
    while (searchCache.size > 32) searchCache.delete(searchCache.keys().next().value as string);
  }
  try {
    const page = await searchAppPage(clean, offset, searchId);
    entry.pages.set(offset, page);
    // 首页结果过少且还有更多时自动续拉一页（精选条目少，避免用户误以为搜完了）
    if (offset === 0 && page.rows.length < 6 && page.hasMore) {
      const next = await searchAppPage(clean, page.nextOffset, page.searchId);
      entry.pages.set(page.nextOffset, next);
      return { success: true as const, results: [...page.rows, ...next.rows], hasMore: next.hasMore, nextOffset: next.nextOffset, searchId: next.searchId, source: 'app' as const };
    }
    // 综合搜索 0 条但联想命中了剧集：用联想的剧集条目兜底（如「霸总」这类缩略词，
    // 或返回页全是小说/用户卡片被过滤成 0 条的情形）
    if (offset === 0 && page.rows.length === 0) {
      try {
        const rows = await suggestSeriesRows(clean);
        if (rows.length) return { success: true as const, results: rows, hasMore: false, nextOffset: 0, searchId: '', source: 'suggest' as const };
      } catch { /* 联想兜底失败保持 0 条 */ }
    }
    return { success: true as const, results: page.rows, hasMore: page.hasMore, nextOffset: page.nextOffset, searchId: page.searchId, source: 'app' as const };
  } catch (error: any) {
    // 签名搜索失败（风控空响应/超时等）→ 联想接口的剧集条目兜底（联想与搜索是不同
    // 上游端点，搜索被风控时联想往往仍可用）→ 官网 SSR searchList 兜底（已改版，多为空）。
    try {
      const rows = await suggestSeriesRows(clean);
      if (rows.length) {
        return { success: true as const, results: rows, hasMore: false, nextOffset: 0, searchId: '', source: 'suggest' as const };
      }
    } catch { /* 联想也失败，继续官网兜底 */ }
    const fallback = await searchSiteList(clean);
    if (fallback.length) {
      return { success: true as const, results: fallback, hasMore: false, nextOffset: 0, searchId: '', source: 'site' as const };
    }
    return { success: false as const, error: error?.message || '搜索失败', results: [] as SearchRow[] };
  }
}

/** 官网 SSR 搜索页内嵌的 searchList（上游改版后可能拿不到，仅作兜底）。 */
async function searchSiteList(keyword: string): Promise<SearchRow[]> {
  try {
    const res = await fetch(`https://hongguoduanju.com/search/${encodeURIComponent(keyword)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://hongguoduanju.com/',
      },
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const ki = html.indexOf('"searchList"');
    if (ki < 0) return [];
    const bi = html.indexOf('[', ki);
    if (bi < 0) return [];
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let i = bi; i < html.length; i++) {
      const c = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return [];
    const list = JSON.parse(html.substring(bi, end + 1));
    const rows: SearchRow[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const vd = item?.video_data && typeof item.video_data === 'object' ? item.video_data : item;
      const sid = String(vd?.series_id ?? '');
      if (!/^\d{6,}$/.test(sid)) continue;
      rows.push({
        series_id: sid,
        series_title: String(vd?.series_title || item?.name || '').trim(),
        series_intro: String(vd?.series_intro ?? '').trim(),
        cover: String(vd?.series_cover ?? '').replace(/\\u002F/g, '/').replace(/\\u0026/g, '&'),
        episode_cnt: Number(vd?.episode_cnt) || 0,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

// ── 联想 ─────────────────────────────────────────────────────────────────

export interface SuggestRow {
  name: string; keyword: string; abstract: string;
  seriesId?: string; seriesTitle?: string; cover?: string;
}

export async function searchSuggest(q: string): Promise<SuggestRow[]> {
  const clean = String(q || '').trim().slice(0, 40);
  if (clean.length < 2) return [];
  const query: Record<string, string> = {
    q: clean, bookshelf_search_plan: '4', bookstore_tab: '16', count: '0',
    need_personal_recommend: '1', need_preload: 'true', search_source: '1', tab_name: 'feed',
    iid: '', device_id: deviceIdValue,
  };
  const payload = await signedGet(`${SEARCH_HOST}${SUGGEST_PATH}`, query);
  const rows = Array.isArray(payload?.data?.query_result_v2) ? payload.data.query_result_v2 : [];
  const out: SuggestRow[] = [];
  for (const row of rows) {
    if (typeof row?.name !== 'string' || !row.name.trim()) continue;
    const vd = row?.video_data && typeof row.video_data === 'object' ? row.video_data : null;
    out.push({
      name: row.name.trim(),
      keyword: String(row.keyword ?? ''),
      abstract: String(row.sug_abstract ?? '').trim(),
      ...(vd?.series_id ? { seriesId: String(vd.series_id), seriesTitle: String(vd.series_title ?? vd.title ?? row.name), cover: String(vd.cover ?? '') } : {}),
    });
    if (out.length >= 8) break;
  }
  return out;
}

// ── 详情元信息（热度/追剧数/播放量/备案号） ──────────────────────────────

export interface SeriesMeta {
  hot_score?: number; follow_cnt?: number; series_play_cnt?: number;
  record_number?: string; series_intro?: string; creation_status?: number;
}

export async function seriesMeta(seriesId: string): Promise<SeriesMeta | null> {
  if (!/^\d{6,30}$/.test(seriesId)) return null;
  const body = {
    biz_param: {
      caller_scene: 'single_col', detail_page_version: 1, disable_digg_stat: false,
      disable_video_relate_book: false, from_video_id: '', need_all_video_definition: false,
      need_mp4_align: false, screen_width_px: '1078', source: 4, use_os_player: false,
      use_server_dns: false, video_id_type: 1,
    },
    series_id: String(seriesId),
  };
  const payload = await signedPost(META_PATH, { iid: '', device_id: deviceIdValue }, body);
  const vd = payload?.data?.video_data ?? null;
  if (!vd || typeof vd !== 'object') return null;
  return {
    ...(Number.isFinite(Number(vd.hot_score)) ? { hot_score: Number(vd.hot_score) } : {}),
    ...(Number.isFinite(Number(vd.followed_cnt)) ? { follow_cnt: Number(vd.followed_cnt) } : {}),
    ...(Number.isFinite(Number(vd.series_play_cnt)) ? { series_play_cnt: Number(vd.series_play_cnt) } : {}),
    ...(typeof vd.record_info?.record_number === 'string' ? { record_number: vd.record_info.record_number } : {}),
    ...(typeof vd.series_intro === 'string' && vd.series_intro.trim() ? { series_intro: vd.series_intro.trim() } : {}),
    ...(Number.isFinite(Number(vd.creation_status)) ? { creation_status: Number(vd.creation_status) } : {}),
  };
}

// ── 相关作品（同系列各季 + 猜你喜欢） ────────────────────────────────────

export interface RelatedSeries { series_id: string; series_title: string; cover: string; season?: number }

export async function relatedSeries(seriesId: string): Promise<{ related: RelatedSeries[]; recommended: RelatedSeries[] }> {
  if (!/^\d{6,30}$/.test(seriesId)) return { related: [], recommended: [] };
  const query = {
    book_id: String(seriesId), from: 'detail_page_more_related', scene: '10',
    iid: '', device_id: deviceIdValue,
  };
  const payload = await signedGet(`${SEARCH_HOST}${PLAN_PATH}`, query);
  const cells = Array.isArray(payload?.data) ? payload.data : [];
  const related: RelatedSeries[] = [];
  const recommended: RelatedSeries[] = [];
  for (const cell of cells) {
    const items = Array.isArray(cell?.cell_data) ? cell.cell_data : Array.isArray(cell?.items) ? cell.items : [];
    const isRelated = /相关作品/.test(String(cell?.cell_name ?? ''));
    for (const item of items) {
      const sid = String(item?.series_id ?? item?.book_id ?? '');
      if (!/^\d{6,}$/.test(sid) || sid === String(seriesId)) continue;
      const title = String(item?.series_title ?? item?.title ?? '').trim();
      if (!title) continue;
      const season = Number(String(title).match(/第\s*([0-9一二三四五六七八九十]+)\s*[季部]/)?.[1]?.replace(/[一二三四五六七八九十]/g, (c) => String(['一','二','三','四','五','六','七','八','九','十'].indexOf(c) + 1)) ?? NaN);
      const row: RelatedSeries = { series_id: sid, series_title: title, cover: String(item?.series_cover ?? item?.cover ?? ''), ...(Number.isFinite(season) ? { season } : {}) };
      (isRelated ? related : recommended).push(row);
    }
  }
  return { related, recommended };
}

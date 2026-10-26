// SPDX-License-Identifier: GPL-3.0-only
// 红果官网 SSR 数据源 + 旧 App 接口回退 + CENC 解密。
// Ported from hongguo-drama src/native/hongguo.js (GPL-3.0)，axios → Bun/undici fetch。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { normalizeDownloadQuality } from './download-quality';
import { isPublicMediaUrl, assertPublicHost, blockedAddress } from './web-media';
import { readRouterData } from './catalog';
import { normalizeCoverUrl } from './cover';

export const API = 'https://api5-normal-sinfonlineb.fqnovel.com';
export const UA = 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)';
export const VIDEO_REFERER = 'https://novelquickapp.com/';

// ===== 优先使用官网网页版，App 接口保留为回退 =====
export const SITE_ORIGIN = 'https://hongguoduanju.com';
export const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
export const WEB_REFERER = SITE_ORIGIN + '/';

const COMMON_QUERY: Record<string, string> = {
  ...Object.fromEntries([
    ['klink_egdi', process.env.HONGGUO_KLINK_EGDI],
    ['iid', process.env.HONGGUO_IID],
    ['device_id', process.env.HONGGUO_DEVICE_ID],
    ['cdid', process.env.HONGGUO_CDID],
  ].filter(([, value]) => value) as [string, string][]),
  ac: 'wifi',
  channel: 'oppo_8662_64',
  aid: '8662',
  app_name: 'novelread',
  version_code: '71532',
  version_name: '7.1.5.32',
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  device_type: 'SM-N9860',
  device_brand: 'Samsung',
  language: 'zh',
  os_api: '28',
  os_version: '9',
  manifest_version_code: '71532',
  resolution: '900*1600',
  dpi: '320',
  update_version_code: '71532',
  host_abi: 'arm64-v8a',
  dragon_device_type: 'pad',
  pv_player: '71532',
  compliance_status: '0',
  need_personal_recommend: '1',
  player_so_load: '1',
  is_android_pad_screen: '0',
  rom_version: 'PQ3A.190705.10241111+release-keys',
};

const HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'Accept-Encoding': 'gzip',
  'Accept': 'application/json; charset=utf-8,application/x-protobuf',
  'Content-Type': 'application/json; charset=utf-8',
};

const DETAIL_BIZ_PARAM = {
  detail_page_version: 0,
  disable_digg_stat: false,
  image_shrink_datas_str: 'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjcyLCJzaHJpbmtfdHlwZSI6NH1d\n',
  need_all_video_definition: false,
  need_mp4_align: false,
  screen_width_px: '900',
  source: 7,
  use_os_player: false,
  use_server_dns: false,
};

const MODEL_BIZ_PARAM = {
  detail_page_version: 0,
  device_level: 3,
  disable_digg_stat: false,
  need_all_video_definition: true,
  need_mp4_align: false,
  use_os_player: false,
  use_server_dns: false,
  video_platform: 1024,
};

/** API 调用封装（3 次重试、退避 2s、空响应判错）。 */
export async function apiCall(apiPath: string, body: unknown, retries = 3, timeout = 25000) {
  const q = new URLSearchParams({ ...COMMON_QUERY, _rticket: Date.now().toString() });
  const url = `${API}${apiPath}?${q.toString()}`;
  for (let i = 0; i < retries; i++) {
    const signal: { status?: number; logid?: string; bytes?: number } = {};
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      signal.status = res.status;
      signal.logid = res.headers.get('x-tt-logid') ?? undefined;
      const buf = Buffer.from(await res.arrayBuffer());
      signal.bytes = buf.length;
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (buf.length === 0) {
        const err = new Error(`接口返回空响应（HTTP 200，0 字节）${signal.logid ? ' logid=' + signal.logid : ''}`);
        (err as any).emptyResponse = true;
        (err as any).detail = signal;
        throw err;
      }
      const text = buf.toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        const err = new Error(`响应不是合法 JSON（HTTP 200，${buf.length} 字节）: ${text.slice(0, 100)}`);
        (err as any).detail = signal;
        throw err;
      }
    } catch (err: any) {
      if (err?.emptyResponse || i === retries - 1) {
        if ((err as any)?.detail === undefined) (err as any).detail = signal;
        throw err;
      }
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

// ===== 官网网页版数据源实现 =====

const responseCache = new Map<string, { value: unknown; expires: number }>();
const pendingRequests = new Map<string, Promise<unknown>>();
const failedWebMedia = new Map<string, number>();

/** A real media GET failed; keep retries off that episode's web CDN briefly. */
export function markWebMediaFailure(playInfo: { source?: string; vid?: string } | null | undefined) {
  if (playInfo?.source !== 'web' || !playInfo.vid) return;
  failedWebMedia.set(String(playInfo.vid), Date.now() + 5 * 60 * 1000);
  if (failedWebMedia.size > 128) failedWebMedia.delete(failedWebMedia.keys().next().value as string);
}

/** 仅保留短期成功结果；重复点击共享请求，失败后立即允许重试。 */
export async function cachedRequest<T>(key: string, ttl: number, load: () => Promise<T>, options: { force?: boolean } = {}): Promise<T> {
  const cached = responseCache.get(key);
  if (!options.force && cached && cached.expires > Date.now()) return cached.value as T;
  responseCache.delete(key);
  if (!options.force && pendingRequests.has(key)) return pendingRequests.get(key) as Promise<T>;
  const request = Promise.resolve().then(load).then((value) => {
    // A forced lookup owns the cache even if an older request finishes later.
    if (pendingRequests.get(key) === request) {
      responseCache.set(key, { value, expires: Date.now() + ttl });
      if (responseCache.size > 128) responseCache.delete(responseCache.keys().next().value as string);
    }
    return value;
  }).finally(() => {
    if (pendingRequests.get(key) === request) pendingRequests.delete(key);
  }) as Promise<T>;
  pendingRequests.set(key, request);
  return request;
}

/** MP4 直链：去掉 HTML 转义并剥掉 Range 头，让 CDN 回整段 */
export function normalizeVideoUrl(raw: unknown) {
  return String(raw || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/([?&])Range=[^&]*/gi, '$1')
    .replace(/[?&]$/, '');
}

/** 从响应体里安全地取出某个字符串字段 */
function pickJsonString(text: string, key: string) {
  const m = text.match(new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"'));
  return m ? m[1].replace(/\\u002F/g, '/').replace(/\\u0026/g, '&') : '';
}

/** 拉取官网页面 HTML */
export async function fetchSiteHtml(url: string, timeout = 30000) {
  await assertPublicHost(url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': WEB_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': WEB_REFERER,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`官网页面请求失败（HTTP ${res.status}）`);
  return res.text();
}

/**
 * 从官网 player 页内嵌 JSON 取完整分集列表
 * vid_list 按下标即集数顺序（下标 i → 第 i+1 集）
 */
export async function fetchEpisodeListFromWeb(seriesId: string) {
  const html = await fetchSiteHtml(`${SITE_ORIGIN}/player/${encodeURIComponent(seriesId)}`);

  const m = html.match(/"vid_list"\s*:\s*\[([^\]]*)\]/);
  if (!m) throw new Error('官网页面未找到分集数据（vid_list）');

  const vids = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => /^\d+$/.test(s));
  if (!vids.length) throw new Error('官网分集列表为空');

  const seriesTitle = pickJsonString(html, 'series_name') || '未命名短剧';
  const cover = pickJsonString(html, 'series_cover');
  const accessible = html.match(/"accessible_episode_cnt"\s*:\s*(\d+)/);
  const webAccessibleEpisodes = accessible ? Math.min(Number(accessible[1]), vids.length) : null;

  const episodes = vids.map((vid, i) => ({
    vid,
    vid_index: i + 1,
    title: '',
    series_id: String(seriesId),
    series_title: seriesTitle,
    cover,
    web_available: webAccessibleEpisodes === null ? null : i < webAccessibleEpisodes,
  }));

  return {
    series_id: String(seriesId),
    series_title: seriesTitle,
    cover: cover || (episodes[0] && episodes[0].cover) || '',
    total: episodes.length,
    web_accessible_episodes: webAccessibleEpisodes,
    episodes,
    source: 'web',
  };
}

export interface PlayInfo {
  url: string;
  spadeA?: string | null;
  contentKey?: string | null;
  codec?: string;
  source: 'web' | 'app' | 'api';
  vid: string;
  userAgent: string;
  referer?: string;
  variants?: PlayInfo[];
  quality?: string;
  width?: number;
  height?: number;
}

/**
 * 从官网取单集可直接下载的 MP4 直链（明文，无 CENC 加密）。
 * sid 已知时用 /player/{sid}/{vid}；未知时退回 /player/_/{vid} 再自行解析。
 */
export async function fetchPlayUrlFromWeb(vid: string, sid: string, onFailure?: (error: unknown) => void): Promise<PlayInfo | null> {
  const candidates = [];
  if (sid) candidates.push(`${SITE_ORIGIN}/player/${encodeURIComponent(sid)}/${encodeURIComponent(vid)}`);
  candidates.push(`${SITE_ORIGIN}/player/_/${encodeURIComponent(vid)}`);

  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const html = await fetchSiteHtml(url, 8000);
      const router = readRouterData(html);
      const data = router.loaderData?.['player_(series_id)/(vid)/page'];
      const actualSid = String(data?.series_id || '');
      lastErr = { code: !data ? 'MISSING_MODEL' : data.isSuccess === false ? 'BUSINESS_REJECTED'
        : data.publicVideoSeo?.available === false ? 'NO_PLAYABLE_SOURCE' : 'INVALID_RESPONSE' };
      if (!data || data.isSuccess === false || String(data.vid) !== String(vid) || !/^\d+$/.test(actualSid) ||
        (sid && actualSid !== String(sid)) || String(data.seriesDetail?.series_id) !== actualSid ||
        data.publicVideoSeo?.available !== true || String(data.publicVideoSeo.itemId) !== String(vid) ||
        String(data.publicVideoSeo.seriesId) !== actualSid) continue;
      // Protected pages expose a short SEO preview even when metadata claims the full duration.
      if (data.protectedPlayback === true) { lastErr = { code: 'PREVIEW_ONLY' }; break; }
      // Bind media to the current player, never a recommended video's URL elsewhere in the page.
      const matchesPlayer = (value: string, videoUrl: URL) => {
        try {
          const target = new URL(value);
          return target.origin === SITE_ORIGIN && !target.username && !target.password &&
            (target.pathname === `/player/${actualSid}/${String(vid)}` ||
              target.pathname === `/player/${actualSid}` && videoUrl.origin === SITE_ORIGIN &&
                videoUrl.pathname.startsWith(`/video/public/${String(vid)}/`));
        } catch { return false; }
      };
      for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue;
        let video: any;
        try { video = JSON.parse(script[2]); } catch { continue; }
        if (video?.['@type'] !== 'VideoObject') continue;
        let videoUrl: URL;
        try { videoUrl = new URL(normalizeVideoUrl(video.contentUrl)); } catch { continue; }
        if (!matchesPlayer(video.url, videoUrl) || (video['@id'] && !matchesPlayer(video['@id'], videoUrl))) continue;
        if (!isPublicMediaUrl(videoUrl.href)) { lastErr = { code: 'SECURITY_BLOCKED' }; continue; }
        return { url: videoUrl.href, spadeA: null, codec: '', source: 'web', vid: String(vid), userAgent: WEB_UA, referer: WEB_REFERER };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) console.warn('[Web] 取播放直链失败:', sourceFailure('web', lastErr).message);
  onFailure?.(lastErr);
  return null;
}

/**
 * 分享链接 -> series_id
 */
function shareHttpUrl(value: string, base?: string) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) {
    throw new Error('分享链接无效或过长');
  }
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 分享链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) {
    throw new Error('仅支持不含账号密码的 HTTP 或 HTTPS 分享链接');
  }
  return url.href;
}

export async function resolveSeriesId(shareUrl: string) {
  if (typeof shareUrl !== 'string' || shareUrl.length > 8192) throw new Error('分享内容无效或过长');
  const trimmed = shareUrl.trim();
  if (/^\d{1,30}$/.test(trimmed)) return trimmed;
  const link = trimmed.match(/https?:\/\/[^\s<>"'，。！？；、【】（）]+/i)?.[0];
  if (!link) throw new Error('请输入有效的 HTTP 或 HTTPS 分享链接，或剧集 ID');
  let finalUrl = shareHttpUrl(link.replace(/[),.;!]+$/, ''));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let bodyText = '';
  try {
    for (let redirects = 0; ; redirects++) {
      await assertPublicHost(finalUrl);
      const res = await fetch(finalUrl, {
        headers: { 'User-Agent': WEB_UA },
        signal: controller.signal,
        redirect: 'manual',
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (redirects >= 5) throw new Error('分享链接跳转次数过多');
        const location = res.headers.get('location');
        if (!location) throw new Error('分享链接跳转无效');
        finalUrl = shareHttpUrl(location, finalUrl);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bodyText = (await res.text()).slice(0, 2 * 1024 * 1024);
      break;
    }
  } catch {
    throw new Error(controller.signal.aborted ? '分享链接加载超时，请重试' : '分享链接加载失败，请检查链接后重试');
  } finally { clearTimeout(timer); }

  const url = new URL(finalUrl);
  const seriesId = url.searchParams.get('video_series_id');
  if (/^\d{1,30}$/.test(seriesId || '')) return seriesId!;
  const player = url.pathname.match(/^\/player\/(\d{1,30})(?:\/|$)/);
  if (player) return player[1];
  const schemeParams = url.searchParams.get('schemeParams');
  if (schemeParams) {
    try {
      const raw = decodeURIComponent(schemeParams);
      const match = raw.match(/"video_id"\s*:\s*"(\d{1,30})"/);
      if (match) return match[1];
    } catch { /* Malformed optional parameters must not hide valid page data. */ }
  }
  const match = bodyText.match(/video_series_id=(\d{1,30})(?!\d)/)
    || bodyText.match(/"(?:video_id|series_id)"\s*:\s*"(\d{1,30})"/);
  if (match) return match[1];
  throw new Error('无法从分享链接解析剧集 ID');
}

/**
 * 获取全集剧集列表
 */
export async function fetchEpisodeList(seriesId: string) {
  return cachedRequest(`episodes:${seriesId}`, 60000, () => fetchEpisodeListFresh(seriesId));
}

export async function fetchEpisodeListFresh(seriesId: string) {
  let webError: unknown;
  try {
    return await fetchEpisodeListFromWeb(seriesId);
  } catch (error) {
    webError = error;
  }
  const body = {
    biz_param: DETAIL_BIZ_PARAM,
    dr_scene: 'preload',
    series_id: seriesId,
  };
  let j: any;
  try {
    j = await apiCall('/novel/player/multi_video_detail/preload/v1', body);
  } catch (e: any) {
    throw new Error(`获取分集失败：官网数据源（${(webError as Error)?.message}），备用接口（${e?.message}）`);
  }
  if (!j || j.code !== 0) {
    throw new Error('detail API 失败: ' + JSON.stringify(j || {}).slice(0, 200));
  }
  const d = j.data || {};
  const sid = Object.keys(d)[0];
  if (!sid) throw new Error('未获取到剧集数据');
  const vd = d[sid]?.video_data || {};
  const vl = vd.video_list || [];
  const eps = vl.map((item: any) => ({
    vid: String(item.vid),
    vid_index: item.vid_index || 0,
    title: item.title || '',
    series_id: String(item.series_id || sid),
    series_title: vd.series_title || '',
    cover: normalizeCoverUrl(vd.series_cover || vd.cover_url || item.cover_url || ''),
    // 分集时长（秒），来自上游 video_list[].duration，用于选集角标
    ...(Number(item.duration) > 0 ? { duration: Number(item.duration) } : {}),
  }));
  if (!eps.length) throw new Error('备用接口分集列表为空');
  eps.sort((a: any, b: any) => a.vid_index - b.vid_index);
  return {
    series_id: String(sid),
    series_title: vd.series_title || '未命名短剧',
    cover: normalizeCoverUrl(vd.series_cover || vd.cover_url || (eps[0] && eps[0].cover) || ''),
    total: eps.length,
    // 本剧简介：preload 接口下每集 title 常重复存放的是全剧简介，与 series_intro 比对剔除
    ...(typeof vd.series_intro === 'string' && vd.series_intro.trim() ? { series_intro: vd.series_intro.trim() } : {}),
    episodes: eps,
  };
}

/**
 * 单条视频流的清晰度评分
 */
function streamScore(v: any) {
  const meta = v.video_meta || {};
  const defStr = String(meta.definition || '');
  let defNum = 0;
  const m = defStr.match(/(\d+)\s*p/i);
  if (m) {
    defNum = parseInt(m[1], 10);
  } else {
    const map: Record<string, number> = { '4k': 2160, '2k': 1440, 'fhd': 1080, 'fullhd': 1080, 'hd': 720, 'sd': 480, 'ld': 360 };
    defNum = map[defStr.toLowerCase()] || 0;
  }
  const w = parseInt(meta.vwidth, 10) || 0;
  const h = parseInt(meta.vheight, 10) || 0;
  if (w > 0 && h > 0) defNum = Math.min(w, h);
  const bitrate = parseInt(meta.bitrate || meta.real_bitrate, 10) || 0;
  return { defNum, pixels: w * h, bitrate };
}

/**
 * 解析单个 video_model JSON
 * 选流优先级：H.264 兼容性 > 短边分辨率（无尺寸时用标签） > 像素 > 码率
 */
function parseModelVideo(vm: string): [string | null, string | null, string] {
  if (typeof vm !== 'string') return [null, null, ''];
  let vmj: any;
  try {
    vmj = JSON.parse(vm);
  } catch {
    return [null, null, ''];
  }
  const vl = vmj.video_list || {};
  const rank = (codec: string) => {
    if (codec === 'bytevc2') return 2; // 字节私有编码，Chromium 必黑屏
    if (['h264', 'avc', 'avc1'].includes(codec)) return 0;
    if (['h265', 'h265_hvc1', 'hevc', 'hvc1', 'hev1', 'bytevc1'].includes(codec)) return 1;
    return 2;
  };
  const cmp = (a: any, b: any) => {
    if (a.codecRank !== b.codecRank) return b.codecRank - a.codecRank;
    if (a.defNum !== b.defNum) return a.defNum - b.defNum;
    if (a.pixels !== b.pixels) return a.pixels - b.pixels;
    return a.bitrate - b.bitrate;
  };
  let best: [string, string | null, string] | null = null;
  let bestScore: any = null;
  for (const v of Object.values<any>(vl)) {
    let url: string | undefined;
    for (const raw of [v.main_url, v.backup_url]) {
      try {
        const candidate = new URL(normalizeVideoUrl(raw));
        if (['https:', 'http:'].includes(candidate.protocol) && !candidate.username && !candidate.password) {
          url = candidate.href;
          break;
        }
      } catch { /* ignore */ }
    }
    if (!url) continue;
    const codec = String(v.video_meta?.codec_type || '').toLowerCase();
    const ei = v.encrypt_info || {};
    const s = { ...streamScore(v), codecRank: rank(codec) };
    if (!bestScore || cmp(s, bestScore) > 0) {
      bestScore = s;
      best = [url, ei.spade_a || null, codec];
    }
  }
  return best || [null, null, ''];
}

export type PlayUrlResult = Omit<PlayInfo, 'url' | 'source'> & {
  source?: PlayInfo['source'];
  url: string | null; error?: string; code?: string; sources?: { source: string; code: string; message: string }[];
};

/**
 * 获取单集播放直链与 spade_a 加密 key
 */
export async function fetchPlayUrlSingle(vid: string, sid: string, options: { quality?: string; force?: boolean } = {}): Promise<PlayUrlResult> {
  try {
    const quality = normalizeDownloadQuality(options.quality);
    const skipWeb = (failedWebMedia.get(String(vid)) || 0) > Date.now();
    const cacheKey = `play:${sid || ''}:${vid}${quality === 'auto' ? '' : `:${quality}`}${skipWeb ? ':fallback' : ''}`;
    const result = await cachedRequest<PlayInfo>(cacheKey, 30000, () => quality === 'auto'
      ? fetchPlayUrlFresh(vid, sid, skipWeb)
      : import('./app-source').then(({ fetchAppPlayUrl }) => fetchAppPlayUrl(String(vid), { quality }).catch((error) => {
        throw unavailableSources([sourceFailure('app', error)], quality);
      })), options);
    // Last-resort web recovery must not replace App priority during the penalty window.
    if (skipWeb && result.source === 'web' && responseCache.get(cacheKey)?.value === result) responseCache.delete(cacheKey);
    return result;
  } catch (error: any) {
    return { url: null, spadeA: null, codec: '', source: undefined, vid: String(vid), userAgent: '', error: error.message,
      ...(error.code === 'SOURCE_UNAVAILABLE' ? { code: error.code, sources: error.sources } : {}) };
  }
}

export function sourceFailure(source: string, error?: unknown) {
  const message = String((error as any)?.message || '');
  const code = String((error as any)?.code || '');
  const status = Number((error as any)?.status || message.match(/HTTP\s+(\d{3})/)?.[1]);
  if (status >= 300 && status <= 599) return { source, code: `HTTP_${status}`, message: `请求失败（HTTP ${status}）` };
  if (code === 'SECURITY_BLOCKED' || code.startsWith('ERR_WEB_MEDIA_')) return { source, code: 'SECURITY_BLOCKED', message: '片源地址被安全校验阻止' };
  if (['ECONNABORTED', 'ETIMEDOUT', 'TIMEOUT', 'TimeoutError'].includes(code) || /超时|timeout/i.test(message)) return { source, code: 'TIMEOUT', message: '请求超时' };
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_NETWORK', 'ERR_CANCELED'].includes(code)) return { source, code: 'NETWORK_ERROR', message: '网络连接失败，请稍后重试' };
  if (code === 'PREVIEW_ONLY') return { source, code, message: '网页仅提供预览，未作为完整片源' };
  if (code === 'BUSINESS_REJECTED') return { source, code, message: '接口暂时拒绝本次请求' };
  if (code === 'MISSING_MODEL' || /未返回目录数据/.test(message)) return { source, code: 'MISSING_MODEL', message: '接口未返回本集片源模型' };
  if (code === 'INVALID_RESPONSE' || /空响应|有效数据|目录数据不完整|JSON/.test(message)) return { source, code: 'INVALID_RESPONSE', message: '片源数据无法解析' };
  return { source, code: 'NO_PLAYABLE_SOURCE', message: '暂未取得有效片源' };
}

function unavailableSources(sources: { source: string; message: string }[], quality = 'auto') {
  const names: Record<string, string> = { web: '网页', app: 'App', api: '旧接口' };
  const error = new Error(`本集取源失败${quality === 'auto' ? '' : `（所选清晰度 ${quality}，未降级）`}：${sources.map((item) => `${names[item.source]}：${item.message}`).join('；')}。请重试或在官方 App 确认可播情况。`);
  (error as any).code = 'SOURCE_UNAVAILABLE';
  (error as any).sources = sources;
  return error;
}

export async function fetchPlayUrlFresh(vid: string, sid: string, skipWeb = false): Promise<PlayInfo> {
  const sources: { source: string; message: string }[] = [];
  const web = !skipWeb && await fetchPlayUrlFromWeb(vid, sid, (error) => sources.push(sourceFailure('web', error)));
  if (web && web.url) return web;

  try {
    const { fetchAppPlayUrl } = await import('./app-source');
    return await fetchAppPlayUrl(String(vid));
  } catch (error) {
    sources.push(sourceFailure('app', error));
  }

  const body = {
    biz_param: MODEL_BIZ_PARAM,
    dr_scene: 'preload',
    mixed_video_id_map: { '1004': [vid] },
  };
  try {
    const j: any = await apiCall('/novel/player/multi_video_model/preload/v1', body, 1, 6000);
    const item = j?.data?.[vid] || {};
    const [url, spadeA, codec] = parseModelVideo(item.video_model);
    if (url) return { url, spadeA, codec, source: 'api', vid: String(vid), userAgent: UA };
    sources.push(sourceFailure('api'));
  } catch (e) {
    sources.push(sourceFailure('api', e));
  }
  // A transient CDN failure changes priority, not permanent source availability.
  if (skipWeb) {
    const lastWeb = await fetchPlayUrlFromWeb(vid, sid, (error) => sources.push(sourceFailure('web', error)));
    if (lastWeb?.url) return lastWeb;
  }
  throw unavailableSources(sources);
}

/**
 * FFmpeg 兼容 Base64 解码
 */
export function avBase64Decode(s: string) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table: Record<number, number> = {};
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  const dst: number[] = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const vals: number[] = [];
    let ok = true;
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      if (c in table) {
        vals.push(table[c]);
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) {
      let v = 0;
      for (let j2 = 0; j2 < vals.length; j2++) {
        v = (v << 6) | vals[j2];
      }
      if (vals.length === 3) {
        dst.push((v >> 10) & 0xff);
        dst.push((v >> 2) & 0xff);
      } else if (vals.length === 2) {
        dst.push((v >> 4) & 0xff);
      }
      break;
    }
    const v = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    dst.push((v >> 16) & 0xff);
    dst.push((v >> 8) & 0xff);
    dst.push(v & 0xff);
    i += 4;
  }
  return Buffer.from(dst);
}

/**
 * spade_a -> 16 字节 AES Key
 */
export function deriveKey(spadeA: string | null) {
  if (!spadeA) return null;
  const buf = avBase64Decode(spadeA);
  const L = buf.length;
  if (L < 3) return null;

  const key0 = buf[0] ^ buf[1] ^ buf[2];
  const x27 = key0 - 0x30;
  const w22 = L - key0 + 0x2f;
  if (x27 < 2 || w22 < 2 || w22 > L - 1) return null;

  const x21 = Buffer.from(buf.subarray(1, 1 + w22));
  let w11 = 0x55, w12 = 0xfa, w10 = 0xeb;
  for (let i = 0; i < x21.length; i++) {
    const w13 = x21[i];
    const pc = i.toString(2).split('1').length - 1;
    const w14 = (i & 1) === 0 ? w12 : w11;
    if ((i & 1) === 1) {
      w11 = w13;
    } else {
      w12 = w13;
    }
    const w13_xor = w14 ^ x21[i];
    const w14_sub = w10 - pc;
    x21[i] = (w14_sub + w13_xor) & 0xff;
  }

  const c0 = x21[0];
  let hval = 0;
  if (0x30 <= c0 && c0 <= 0x39) {
    hval = c0 - 0x30;
  } else if (0x61 <= c0 && c0 <= 0x7a) {
    hval = c0 - 0x57;
  } else {
    return null;
  }

  const w9 = w22 - hval;
  if (w9 < 2) return null;

  const strA = x21.subarray(1, 1 + w9 - 1).toString('ascii');
  if (strA.length !== 32) return null;

  try {
    return Buffer.from(strA, 'hex');
  } catch {
    return null;
  }
}

/**
 * AES-128-ECB 加密
 */
function aes128EcbEncrypt(key16: Buffer, data: Buffer) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key16, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * CENC-AES-CTR 解密 sample
 */
function decryptSample(key: Buffer, nonce: Buffer, cipher: Buffer) {
  if (!cipher || cipher.length === 0) return Buffer.alloc(0);
  const nblocks = Math.ceil(cipher.length / 16);
  const full = Buffer.alloc(nblocks * 16);
  for (let k = 0; k < nblocks; k++) {
    nonce.copy(full, k * 16, 0, 8);
    full.writeBigUInt64BE(BigInt(k), k * 16 + 8);
  }
  const ks = aes128EcbEncrypt(key, full);
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    plain[i] = cipher[i] ^ ks[i];
  }
  return plain;
}

/**
 * MP4 Box 结构解析
 */
function parseBoxes(data: Buffer, start: number, end: number): { typ: string; off: number; size: number; hdr: number; children: any[] | null }[] {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr || off + size > end) break;
    let children = null;
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta'].includes(typ)) {
      children = parseBoxes(data, off + hdr, off + size);
    }
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  return boxes;
}

/**
 * 重建 moov box（从 stsd 去掉 sinf，encv/enca → avc1/hvc1，并修正 stco）
 */
function rebuildMoov(data: Buffer, moovOff: number, moovSize: number, top: any[]) {
  const moovBox = top.find((b) => b.typ === 'moov');
  if (!moovBox) throw new Error('no moov box');

  function clone(box: any): any {
    return {
      typ: box.typ, off: box.off, size: box.size, hdr: box.hdr,
      children: box.children ? box.children.map(clone) : null,
    };
  }

  function prune(box: any): any {
    if (!box.children) return box;
    const keep = [];
    for (const c of box.children) {
      if (['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].includes(c.typ)) continue;
      keep.push(prune(c));
    }
    box.children = keep;
    return box;
  }

  const tree = prune(clone(moovBox));

  function* walkChildren(box: any): Generator<any> {
    for (const c of (box.children || [])) {
      yield c;
      for (const x of walkChildren(c)) yield x;
    }
  }

  const patches: Record<number, Buffer> = {};
  for (const b of walkChildren(tree)) {
    if (b.typ === 'stsd') {
      const content = b.off + 8;
      const count = data.readUInt32BE(content + 4);
      let p = content + 8;
      const entries: Buffer[] = [];
      for (let i = 0; i < count; i++) {
        let esize = data.readUInt32BE(p);
        const etyp = data.subarray(p + 4, p + 8).toString('latin1');
        if (etyp === 'encv' || etyp === 'enca') {
          const hdrSize = etyp === 'encv' ? 78 : 28;
          const children = parseBoxes(data, p + 8 + hdrSize, p + esize);
          let newType: string | null = 'mp4a';
          if (etyp === 'encv') {
            const sinf = children.find((child) => child.typ === 'sinf');
            const frma = sinf && parseBoxes(data, sinf.off + sinf.hdr, sinf.off + sinf.size).find((child) => child.typ === 'frma');
            const original = frma && frma.size === frma.hdr + 4
              ? data.toString('latin1', frma.off + frma.hdr, frma.off + frma.hdr + 4) : null;
            const avc = children.some((child) => child.typ === 'avcC');
            const hevc = children.some((child) => child.typ === 'hvcC');
            newType = original || (avc && !hevc ? 'avc1' : hevc && !avc ? 'hvc1' : null);
            if (newType === null || !['avc1', 'avc3', 'hvc1', 'hev1'].includes(newType)
              || (newType.startsWith('avc') ? !avc || hevc : !hevc || avc)) {
              throw new Error('无法确定加密视频的原始编码（codec），请更换片源重试。');
            }
          }
          const entry = Buffer.alloc(8 + hdrSize);
          entry.writeUInt32BE(0, 0);
          entry.write(newType, 4, 4, 'latin1');
          data.copy(entry, 8, p + 8, p + 8 + hdrSize);

          const entryExtra = Buffer.concat(children.filter((child) => child.typ !== 'sinf')
            .map((child) => data.subarray(child.off, child.off + child.size)));
          const fullEntry = Buffer.concat([entry, entryExtra]);
          fullEntry.writeUInt32BE(fullEntry.length, 0);
          entries.push(fullEntry);
        } else {
          entries.push(data.subarray(p, p + esize));
        }
        p += esize;
      }
      const stsdHdr = Buffer.alloc(16);
      data.copy(stsdHdr, 0, b.off, content + 8);
      stsdHdr.writeUInt32BE(entries.length, 12);
      const fullStsd = Buffer.concat([stsdHdr, ...entries]);
      fullStsd.writeUInt32BE(fullStsd.length, 0);
      patches[b.off] = fullStsd;
    }
  }

  function serialize(box: any): Buffer {
    if (!box.children) {
      return patches[box.off] || data.subarray(box.off, box.off + box.size);
    }
    const body = Buffer.concat(box.children.map(serialize));
    const hdrb = Buffer.alloc(box.hdr);
    data.copy(hdrb, 0, box.off, box.off + box.hdr);
    if (box.hdr === 8) {
      hdrb.writeUInt32BE(8 + body.length, 0);
    } else {
      hdrb.writeUInt32BE(1, 0);
      hdrb.writeBigUInt64BE(BigInt(16 + body.length), 8);
    }
    return Buffer.concat([hdrb, body]);
  }

  const first = serialize(tree);
  const delta = moovSize - first.length;

  for (const b of walkChildren(tree)) {
    if (b.typ === 'stco') {
      const nc = data.readUInt32BE(b.off + 12);
      for (let i = 0; i < nc; i++) {
        const v = data.readUInt32BE(b.off + 16 + i * 4);
        if (v >= delta) {
          data.writeUInt32BE(v - delta, b.off + 16 + i * 4);
        }
      }
    }
  }

  return serialize(tree);
}

/**
 * 解密 CENC-AES-CTR 加密的 MP4（内存版）
 * 注意：会就地修改传入的 Buffer（调用方应独占它）。
 */
export function decryptMp4Buffer(data: Buffer, key: Buffer) {
  const total = data.length;
  const top = parseBoxes(data, 0, total);
  const moov = top.find((b) => b.typ === 'moov');
  if (!moov) throw new Error('no moov box found in MP4');

  function getBox(boxes: any[], typ: string) {
    return (boxes || []).find((b) => b.typ === typ);
  }

  function* walkBoxes(boxes: any[]): Generator<any> {
    for (const b of boxes) {
      if (b.children) {
        for (const x of walkBoxes(b.children)) yield x;
      }
      yield b;
    }
  }

  const stbls = Array.from(walkBoxes(top)).filter((b) => b.typ === 'stbl');
  const trackInfo: { sizes: number[]; offs: number[]; ivs: Buffer[] }[] = [];
  for (const stbl of stbls) {
    const stsz = getBox(stbl.children, 'stsz');
    const stco = getBox(stbl.children, 'stco');
    const stsc = getBox(stbl.children, 'stsc');
    const senc = getBox(stbl.children, 'senc');
    if (!stsz || !stco || !stsc) continue;

    const ss = data.readUInt32BE(stsz.off + 12);
    const n = data.readUInt32BE(stsz.off + 16);
    let sizes: number[] = [];
    if (ss === 0) {
      for (let i = 0; i < n; i++) {
        sizes.push(data.readUInt32BE(stsz.off + 20 + i * 4));
      }
    } else {
      sizes = new Array(n).fill(ss);
    }

    const nc = data.readUInt32BE(stco.off + 12);
    const chunkOffs: number[] = [];
    for (let i = 0; i < nc; i++) {
      chunkOffs.push(data.readUInt32BE(stco.off + 16 + i * 4));
    }

    const ns = data.readUInt32BE(stsc.off + 12);
    const stscTab: [number, number, number][] = [];
    for (let i = 0; i < ns; i++) {
      stscTab.push([
        data.readUInt32BE(stsc.off + 16 + i * 12),
        data.readUInt32BE(stsc.off + 20 + i * 12),
        data.readUInt32BE(stsc.off + 24 + i * 12),
      ]);
    }

    const ivs: Buffer[] = [];
    if (senc) {
      const sc = data.readUInt32BE(senc.off + 12);
      for (let i = 0; i < sc; i++) {
        ivs.push(data.subarray(senc.off + 16 + i * 8, senc.off + 24 + i * 8));
      }
    }

    const chunkSpc: Record<number, number> = {};
    for (let i = 0; i < stscTab.length; i++) {
      const fc = stscTab[i][0];
      const spc = stscTab[i][1];
      const nxt = (i + 1 < stscTab.length) ? stscTab[i + 1][0] : (nc + 1);
      for (let ci = fc - 1; ci < nxt - 1; ci++) {
        chunkSpc[ci] = spc;
      }
    }

    const sampleOffs: number[] = [];
    let si = 0;
    for (let ci = 0; ci < nc; ci++) {
      let off = chunkOffs[ci];
      const spc = chunkSpc[ci] || 1;
      for (let s = 0; s < spc; s++) {
        if (si >= n) break;
        sampleOffs.push(off);
        off += sizes[si];
        si++;
      }
    }

    trackInfo.push({ sizes, offs: sampleOffs, ivs });
  }

  for (const ti of trackInfo) {
    for (let i = 0; i < ti.offs.length; i++) {
      const off = ti.offs[i];
      const sz = ti.sizes[i];
      if (off + sz > total) continue;
      if (i < ti.ivs.length) {
        const nonce = ti.ivs[i].subarray(0, 8);
        const cipher = data.subarray(off, off + sz);
        const plain = decryptSample(key, nonce, cipher);
        plain.copy(data, off);
      }
    }
  }

  const newMoov = rebuildMoov(data, moov.off, moov.size, top);
  const out: Buffer[] = [];
  let off = 0;
  while (off < total) {
    let size = data.readUInt32BE(off);
    const typ = data.subarray(off + 4, off + 8).toString('latin1');
    let hdr = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = total - off;
    }
    if (typ === 'moov') {
      out.push(newMoov);
    } else {
      out.push(data.subarray(off, off + size));
    }
    off += size;
  }

  return Buffer.concat(out);
}

/**
 * 解密 MP4 文件并保存
 */
export function decryptMp4File(srcPath: string, dstPath: string, key: Buffer) {
  const data = fs.readFileSync(srcPath);
  const finalBuf = decryptMp4Buffer(data, key);
  fs.writeFileSync(dstPath, finalBuf);
}

export { blockedAddress };

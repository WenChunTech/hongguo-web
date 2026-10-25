// SPDX-License-Identifier: GPL-3.0-only
// 红果短剧 Web 版 — Bun 服务器入口。
// 承担桌面端 Electron 主进程的角色：内容 API（/api/*）与视频流代理（/media/*），
// 并在生产模式下托管前端构建产物（dist/）。
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as store from './lib/store';
import * as hongguo from './lib/hongguo';
import * as catalog from './lib/catalog';
import * as registry from './lib/registry';
import * as danmakuMod from './lib/danmaku';
import * as reading from './lib/reading';
import * as downloadMod from './lib/download';
import { fetchEpisodeComments } from './lib/episode-comments';
import { fetchPublicDetails } from './lib/public-details';
import { searchSeries, searchSuggest } from './lib/search';
import * as stream from './lib/stream';

const PORT = Number(process.env.PORT || 8174);
const HOST = process.env.HOST || '127.0.0.1';

const DATA_DIR = process.env.HG_DATA_DIR || path.join(import.meta.dir, 'data');
store.init(path.join(DATA_DIR, 'data.json'));
danmakuMod.setDeviceIdentityFile(path.join(DATA_DIR, 'danmaku-client.json'));
stream.setCacheDir(path.join(DATA_DIR, 'online-cache'));
reading.setReadingDataDir(DATA_DIR);
downloadMod.setDownloadDir(path.join(DATA_DIR, 'downloads'));
downloadMod.cleanupPartials();

const BROWSE_CATEGORIES = [
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
  { slug: 'comic', label: '漫画' },
  { slug: 'hot-drama', label: '综合热播榜', group: 'rank' },
  { slug: 'hot-real-drama', label: '真人热播榜', group: 'rank' },
  { slug: 'hot-comic-drama', label: '漫剧热播榜', group: 'rank' },
  { slug: 'hot-ai-drama', label: 'AI 热播榜', group: 'rank' },
];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  const route = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method.toUpperCase();
  const q = url.searchParams;

  // ── 浏览/搜索/解析 ────────────────────────────────────────────────
  if (route === '/browse-categories' && method === 'GET') {
    return json({ success: true, categories: BROWSE_CATEGORIES });
  }
  if (route === '/browse-list' && method === 'GET') {
    const result = await catalog.browseList({
      category: q.get('category') || undefined,
      genre: q.get('genre') || undefined,
      page: Number(q.get('page')) || 1,
      forceRefresh: q.get('force') === '1',
    });
    return json(result);
  }
  if (route === '/search' && method === 'GET') {
    const offset = Number(q.get('offset')) || 0;
    const searchId = q.get('searchId') || '';
    const result = await searchSeries(q.get('keyword') || '', offset, searchId);
    return json(result);
  }
  if (route === '/search-suggest' && method === 'GET') {
    try {
      const rows = await searchSuggest(q.get('q') || '');
      return json({ success: true, results: rows });
    } catch (error: any) {
      // 联想是纯增强，失败静默降级为空列表
      return json({ success: true, results: [] });
    }
  }
  if (route === '/series-meta' && method === 'GET') {
    try {
      const meta = await reading.seriesMeta(q.get('seriesId') || '');
      return json({ success: true, meta });
    } catch (error: any) {
      return json({ success: false, error: error?.message || '详情信息加载失败' });
    }
  }
  if (route === '/related' && method === 'GET') {
    try {
      const data = await reading.relatedSeries(q.get('seriesId') || '');
      return json({ success: true, ...data });
    } catch (error: any) {
      return json({ success: false, related: [], recommended: [], error: error?.message });
    }
  }
  if (route === '/downloads' && method === 'GET') {
    return json({ success: true, tasks: downloadMod.listTasks() });
  }
  if (route === '/downloads/files' && method === 'GET') {
    return json({ success: true, groups: downloadMod.listDownloadedFiles() });
  }
  if (route === '/downloads/cancel' && method === 'POST') {
    const body = await readJson(request);
    return json(downloadMod.cancelDownloadTask(String(body.id || '')));
  }
  if (route === '/downloads/create' && method === 'POST') {
    const body = await readJson(request);
    try {
      const task = downloadMod.createDownloadTask({
        seriesId: String(body.seriesId || ''),
        range: typeof body.range === 'string' ? body.range : '',
        quality: body.quality,
        id: crypto.randomUUID(),
      });
      return json({ success: true, task });
    } catch (error: any) {
      return json({ success: false, error: error?.message || '创建下载任务失败' });
    }
  }
  if (route === '/resolve' && method === 'POST') {
    const body = await readJson(request);
    try {
      const seriesId = await hongguo.resolveSeriesId(String(body.input || ''));
      return json({ success: true, series_id: seriesId });
    } catch (error: any) {
      return json({ success: false, error: error.message });
    }
  }
  if (route === '/series/register' && method === 'POST') {
    const body = await readJson(request);
    try {
      const entry = await registry.registerSeries(String(body.seriesId || ''));
      return json({ success: true, data: registry.getSeriesEpisodes(entry.series_id).data ?? entry });
    } catch (error: any) {
      return json({ success: false, error: error.message });
    }
  }

  // ── 剧库/播放 ─────────────────────────────────────────────────────
  if (route === '/series-list' && method === 'GET') {
    const list = store.getSeries().map((item) => ({
      series_id: item.series_id, series_title: item.series_title, cover: item.cover,
      total: item.episodes.length || item.total, updatedAt: item.updatedAt,
      resume: store.getPlayback()[item.series_id] || null,
    }));
    return json({ success: true, results: list });
  }
  if (route === '/series-episodes' && method === 'GET') {
    return json(registry.getSeriesEpisodes(q.get('seriesId') || ''));
  }
  if (route === '/series/forget' && method === 'POST') {
    const body = await readJson(request);
    const sid = String(body.seriesId || '');
    store.saveSeries(store.getSeries().filter((item) => item.series_id !== sid));
    return json({ success: true });
  }
  if (route === '/play-prepare' && method === 'POST') {
    const body = await readJson(request);
    const result = await stream.prepareOnlinePlay({
      vid: body.vid, seriesId: body.seriesId, vidIndex: body.vidIndex, requestId: body.requestId,
      quality: body.quality, force: body.force === true, prefetch: body.prefetch === true,
    });
    return json(result);
  }
  if (route === '/play-release' && method === 'POST') {
    const body = await readJson(request);
    return json(stream.releaseOnlinePlay({ streamId: body.streamId, requestId: body.requestId }));
  }
  if (route === '/play-progress' && method === 'GET') {
    return json(stream.onlinePlayProgress(q.get('requestId') || ''));
  }
  if (route === '/playback-position' && method === 'GET') {
    return json(store.getPlayback()[q.get('seriesId') || ''] || null);
  }
  if (route === '/save-position' && method === 'POST') {
    const body = await readJson(request);
    try {
      const sid = String(body.seriesId || '');
      const series = registry.findSeries(sid);
      if (!series) return json({ success: false, error: '未找到短剧档案' });
      const map = store.getPlayback();
      map[sid] = registry.recordPlayback(map[sid], series, Number(body.vidIndex), Number(body.currentTime), Date.now(),
        { duration: Number(body.duration) || undefined, ended: body.ended === true });
      store.savePlayback(map);
      return json({ success: true });
    } catch (error: any) {
      return json({ success: false, error: error.message });
    }
  }
  if (route === '/online-cache-status' && method === 'GET') return json(stream.onlineCacheStatus());
  if (route === '/clear-online-cache' && method === 'POST') return json(stream.clearOnlineCache());

  // ── 观看历史 ──────────────────────────────────────────────────────
  if (route === '/watch-history' && method === 'GET') {
    const results = await registry.refreshHistoryTotals(q.get('force') === '1');
    return json({ success: true, results });
  }
  if (route === '/remove-watch-history' && method === 'POST') {
    const body = await readJson(request);
    return json(registry.removeWatchHistory(String(body.seriesId || '')));
  }
  if (route === '/acknowledge-watch-updates' && method === 'POST') {
    const body = await readJson(request);
    return json(registry.acknowledgeWatchUpdates(String(body.seriesId || ''), body.snapshot));
  }

  // ── 详情/评论/弹幕 ────────────────────────────────────────────────
  if (route === '/public-details' && method === 'GET') {
    return json(await fetchPublicDetails(q.get('seriesId') || '', q.get('vid') || ''));
  }
  if (route === '/episode-comments' && method === 'GET') {
    return json(await fetchEpisodeComments({
      seriesId: q.get('seriesId') || undefined,
      episodeId: q.get('episodeId') || undefined,
      cursor: q.get('cursor') || null,
      limit: Math.min(30, Number(q.get('limit')) || 30),
    }));
  }
  if (route === '/episode-danmaku' && method === 'GET') {
    return json(await danmakuMod.fetchDanmaku({
      seriesId: q.get('seriesId') || undefined,
      vid: q.get('vid') || undefined,
      fresh: q.get('fresh') === '1',
      limit: Number(q.get('limit')) || undefined,
    }));
  }

  // ── 设置 ──────────────────────────────────────────────────────────
  if (route === '/settings' && method === 'GET') {
    return json({ success: true, settings: store.getSettings() });
  }
  if (route === '/settings' && method === 'POST') {
    const body = await readJson(request);
    store.saveSettings(body?.settings && typeof body.settings === 'object' ? body.settings : {});
    return json({ success: true });
  }

  return json({ success: false, error: `未知接口：${method} /api${route}` }, 404);
}

// ── 静态文件（生产模式托管 dist/） ────────────────────────────────────────
const DIST_DIR = path.resolve(import.meta.dir, '../dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

function serveStatic(pathname: string): Response | null {
  const clean = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const candidates = clean === '/' || clean === ''
    ? [path.join(DIST_DIR, 'index.html')]
    : [path.join(DIST_DIR, clean), path.join(DIST_DIR, clean, 'index.html'), path.join(DIST_DIR, 'index.html')];
  for (const file of candidates) {
    if (!file.startsWith(DIST_DIR)) continue;
    if (Bun.file(file).size > 0 && Bun.file(file).size !== undefined) {
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          return new Response(Bun.file(file), { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
        }
      } catch { /* try next */ }
    }
  }
  return null;
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  // 默认 10 秒会把搜索（无头渲染 10-20s）与慢速取源请求掐断；上限 255
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, url);
      if (url.pathname.startsWith('/media/')) {
        const streamId = url.pathname.slice('/media/'.length);
        try {
          return await stream.serveMedia(request, streamId);
        } catch (error: any) {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return new Response(error?.message || '媒体服务失败', { status: 502 });
        }
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const staticResponse = serveStatic(url.pathname);
        if (staticResponse) return staticResponse;
      }
      return json({ success: false, error: 'not found' }, 404);
    } catch (error: any) {
      console.error('[Server]', request.method, url.pathname, error?.message);
      return json({ success: false, error: error?.message || '服务器内部错误' }, 500);
    }
  },
});

console.log(`红果短剧 Web 服务已启动: http://${HOST}:${PORT}（数据目录 ${DATA_DIR}）`);

// SPDX-License-Identifier: GPL-3.0-only
// 在线播放会话：取源 →（明文流式转发 | 加密整集下载解密入盘缓存）→ Range 服务。
// 对应桌面端 main.js 的 prepare-online-play + hongguo-stream:// 协议。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as hongguo from './hongguo';
import { assertPublicHost, isPublicMediaUrl } from './web-media';
import { normalizeDownloadQuality } from './download-quality';

const ONLINE_MAX_BYTES = 300 * 1024 * 1024; // 与桌面端一致的在线缓存上限
let cacheDir: string | null = null;

export function setCacheDir(dir: string) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function getCacheDir() {
  if (!cacheDir) throw new Error('online cache dir 未初始化');
  return cacheDir;
}

export interface Entry {
  quality: string;
  size: number;
  lastUsed: number;
  seriesId: string;
  vidIndex: number;
  vid: string;
  source: string;
  complete: boolean;
  filePath?: string;      // 解密/整集落盘产物
  playInfo?: hongguo.PlayInfo; // 明文流式透传
}

interface Session {
  vid: string; seriesId: string; vidIndex: number; requestId: string;
  entry: Entry | null; createdAt: number; job: Job | null;
}
interface Job {
  key: string; force: boolean; controller: AbortController;
  progress: { received: number; total: number; phase: string };
  promise: Promise<Entry>;
}

const sessions = new Map<string, Session>();
const entries = new Map<string, Entry>();
const preparing = new Map<string, Job>();

export function playbackQuality(value = 'auto') {
  if (!['auto', '720p', '1080p'].includes(value)) throw new Error('在线播放清晰度无效，请选择自动、720p 或 1080p');
  return value;
}
function onlineCacheKey(vid: string, quality = 'auto') {
  return quality === 'auto' ? String(vid) : `${vid}:${quality}`;
}

function trimOnlineCache() {
  let total = 0;
  for (const entry of entries.values()) total += entry.size || 0;
  if (total <= ONLINE_MAX_BYTES) return;
  const ordered = [...entries.values()].filter((e) => e.filePath)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of ordered) {
    if (total <= ONLINE_MAX_BYTES) break;
    const key = onlineCacheKey(entry.vid, entry.quality);
    if ([...preparing.values()].some((job) => job.key === key)) continue;
    if (entry.filePath) { try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ } }
    total -= entry.size || 0;
    entries.delete(key);
  }
}

export function onlineCacheStatus() {
  const items = [...entries.values()].map((e) => ({ vid: e.vid, size: e.size, vidIndex: e.vidIndex, seriesId: e.seriesId }));
  return { success: true, count: items.length, bytes: items.reduce((s, i) => s + i.size, 0), items };
}
export function clearOnlineCache() {
  for (const entry of entries.values()) {
    if (entry.filePath) { try { fs.unlinkSync(entry.filePath); } catch { /* ignore */ } }
  }
  entries.clear();
  try { fs.rmSync(getCacheDir(), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.mkdirSync(getCacheDir(), { recursive: true }); } catch { /* ignore */ }
  return { success: true };
}

function mediaTransferError(message: string) {
  return Object.assign(new Error(message), { code: 'MEDIA_TRANSFER_ERROR', mediaRetryable: true });
}

/** 上游媒体请求：UA/Referer 组装、Range 透传、一次 Referer 切换重试、错误页判定。 */
async function requestMedia(playInfo: hongguo.PlayInfo, range?: string | null, signal?: AbortSignal) {
  const url = new URL(playInfo.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效播放地址');
  if (!isPublicMediaUrl(url.href)) throw Object.assign(new Error('官网片源地址不安全'), { code: 'ERR_WEB_MEDIA_ADDRESS', mediaRetryable: true });
  const web = playInfo.source === 'web';
  const headers: Record<string, string> = {
    'User-Agent': playInfo.userAgent || (web ? hongguo.WEB_UA : hongguo.UA),
    'Accept-Encoding': 'identity',
    ...(playInfo.referer || web ? { Referer: playInfo.referer || hongguo.WEB_REFERER } : {}),
  };
  if (range) headers.Range = range;
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await assertPublicHost(url.href);
      response = await fetch(url.href, { headers, signal, redirect: 'follow' });
      const status = response.status;
      const retryable = web ? [404, 410].includes(status) || (status >= 500 && status <= 599) : status === 403;
      if (!signal?.aborted && attempt === 0 && retryable) {
        if (['app', 'api'].includes(playInfo.source) && headers.Referer) delete headers.Referer;
        else if (['app', 'api'].includes(playInfo.source) && !headers.Referer) headers.Referer = hongguo.VIDEO_REFERER;
        continue;
      }
      if (!signal?.aborted && (retryable || status === 403)) hongguo.markWebMediaFailure(playInfo);
      break;
    } catch (error: any) {
      if (error?.code === 'ERR_WEB_MEDIA_ADDRESS' || error?.mediaRetryable) hongguo.markWebMediaFailure(playInfo);
      throw error;
    }
  }
  if (!response) throw mediaTransferError('片源请求失败，请重新获取片源');
  if ([200, 206].includes(response.status) && /(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) {
    throw mediaTransferError('片源返回了错误页面，请重新获取片源');
  }
  return response;
}

/** Retry the complete operation so a broken body never counts as a success. */
async function withMediaRecovery<T>(vid: string, seriesId: string,
  options: { quality?: string; force?: boolean; signal?: AbortSignal; playInfo?: hongguo.PlayInfo | null },
  consume: (playInfo: hongguo.PlayInfo) => Promise<T>): Promise<T> {
  const cancelled = () => {
    if (options.signal?.aborted) throw Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' });
  };
  const recoverable = (error: any) => error?.mediaRetryable || error?.code === 'SOURCE_UNAVAILABLE'
    || ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'EAI_AGAIN', 'MEDIA_TRANSFER_ERROR'].includes(error?.code);
  const rounds = /^\d{1,30}$/.test(String(vid)) ? 3 : 1;
  let lastError: any;
  for (let round = 0; round < rounds; round++) {
    cancelled();
    if (round) await new Promise((resolve) => setTimeout(resolve, round * 500));
    cancelled();
    let info: hongguo.PlayInfo | null | undefined;
    try {
      info = (!round && options.playInfo) || (await hongguo.fetchPlayUrlSingle(vid, seriesId,
        { quality: options.quality, force: options.force || round > 0 }) as hongguo.PlayInfo);
    } catch (error) {
      cancelled();
      if (!recoverable(error)) throw error;
      lastError = error;
      continue;
    }
    cancelled();
    if (!info?.url) {
      lastError = Object.assign(new Error((info as any)?.error || '未获取到有效播放地址'), { code: (info as any)?.code, sources: (info as any)?.sources });
      if (!recoverable(lastError) || (info as any)?.locked) throw lastError;
      continue;
    }
    const seen = new Set<string>();
    for (const candidate of [info, ...((info as any).variants || [])]) {
      const identity = JSON.stringify([candidate.url, candidate.contentKey, candidate.spadeA, candidate.userAgent, candidate.referer]);
      if (!candidate.url || seen.has(identity)) continue;
      seen.add(identity);
      cancelled();
      try {
        const value = await consume(candidate);
        cancelled();
        return value;
      } catch (error) {
        cancelled();
        if (!recoverable(error)) throw error;
        lastError = error;
        hongguo.markWebMediaFailure(candidate);
      }
    }
  }
  throw lastError;
}

/** 整集下载（带进度），必要时解密，落盘缓存。 */
async function fetchDecryptedEpisode(seriesId: string, playInfo: hongguo.PlayInfo, job: Job): Promise<{ buffer: Buffer; playInfo: hongguo.PlayInfo }> {
  const controller = job.controller;
  const response = await requestMedia(playInfo, null, controller.signal);
  const total = Number(response.headers.get('content-length')) || 0;
  job.progress.total = total;
  job.progress.phase = 'downloading';
  const chunks: Buffer[] = [];
  let received = 0;
  // @ts-ignore Bun/undici 响应体为 web ReadableStream
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (controller.signal.aborted) throw new Error('已取消播放');
    const buf = Buffer.from(chunk);
    received += buf.length;
    job.progress.received = received;
    chunks.push(buf);
    if (received > ONLINE_MAX_BYTES) {
      response.body?.cancel();
      throw mediaTransferError('片源体积超过在线缓存上限，无法播放');
    }
  }
  if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
  let buf = Buffer.concat(chunks);
  if (playInfo.spadeA || playInfo.contentKey) {
    job.progress.phase = 'decrypting';
    let key: Buffer | null = null;
    if (playInfo.spadeA) key = hongguo.deriveKey(playInfo.spadeA);
    else if (playInfo.contentKey) key = Buffer.from(playInfo.contentKey, 'hex');
    if (!key || key.length !== 16) throw new Error('密钥派生失败');
    buf = hongguo.decryptMp4Buffer(buf, key);
  }
  return { buffer: buf, playInfo };
}

export interface PreparePayload {
  vid: string; seriesId?: string; vidIndex?: number; requestId?: string;
  quality?: string; force?: boolean; prefetch?: boolean;
}

export async function prepareOnlinePlay(payload: PreparePayload) {
  const { vid, seriesId = '', vidIndex = 0, requestId = '', prefetch = false, force = false } = payload || {};
  if (!vid) return { success: false as const, error: '缺少 vid' };
  let quality: string;
  try { quality = playbackQuality(payload.quality); } catch (error: any) { return { success: false as const, error: error.message }; }
  const sourceVid = String(vid);
  const key = onlineCacheKey(sourceVid, quality);
  const streamId = crypto.randomUUID();
  const session: Session = { vid: sourceVid, seriesId: String(seriesId), vidIndex: Number(vidIndex), requestId, entry: null, createdAt: Date.now(), job: null };
  sessions.set(streamId, session);
  try {
    if (force) {
      const stale = entries.get(key);
      if (stale?.filePath) { try { fs.unlinkSync(stale.filePath); } catch { /* ignore */ } }
      entries.delete(key);
    }
    let entry = entries.get(key);
    let cached = !!entry;
    if (!entry) {
      let job = preparing.get(key);
      if (!job || (force && !job.force)) {
        const controller = new AbortController();
        job = { key, force, controller, progress: { received: 0, total: 0, phase: 'preparing' }, promise: null as any };
        job.promise = (async () => {
          const prepared = await withMediaRecovery(sourceVid, String(seriesId),
            { quality, force, signal: controller.signal }, async (playInfo) => {
              const next: Entry = { quality, size: 0, lastUsed: Date.now(), seriesId: String(seriesId), vidIndex: Number(vidIndex) || 0, vid: sourceVid, source: 'hongguo', complete: false };
              if (!prefetch && !playInfo.spadeA && !playInfo.contentKey) {
                // 明文片源：流式透传，不落盘
                return { ...next, playInfo, complete: true };
              }
              const { buffer, playInfo: used } = await fetchDecryptedEpisode(String(seriesId), playInfo, job!);
              const filePath = path.join(getCacheDir(), `${sanitize(sourceVid)}_${quality}${Date.now().toString(36)}.mp4`);
              fs.writeFileSync(filePath, buffer);
              next.filePath = filePath;
              next.size = buffer.length;
              next.playInfo = used;
              return { ...next, complete: true };
            });
          prepared.lastUsed = Date.now();
          for (const active of sessions.values()) if (active.job === job) active.entry = { ...prepared };
          if (prepared.complete && preparing.get(key) === job) {
            entries.set(key, prepared);
            trimOnlineCache();
          }
          return prepared;
        })().finally(() => { if (preparing.get(key) === job) preparing.delete(key); });
        preparing.set(key, job);
      }
      session.job = job;
      entry = await job.promise;
    }
    if (!sessions.has(streamId)) throw new Error('已取消播放');
    session.entry = { ...entry };
    entry.lastUsed = Date.now();
    return { success: true as const, url: `/media/${streamId}`, streamId, size: entry.size,
      cached, streaming: !!entry.playInfo && !entry.filePath };
  } catch (error: any) {
    releaseOnlineSession(streamId);
    return { success: false as const, error: error.message, code: error.code };
  }
}

function sanitize(name: string) {
  return String(name).replace(/[^\w.-]+/g, '_').slice(0, 120);
}

export function releaseOnlineSession(streamId: string) {
  const session = sessions.get(streamId);
  if (session?.job) session.job = null; // 共享 job 不单独取消
  sessions.delete(streamId);
}

export function releaseOnlinePlay(payload: { streamId?: string; requestId?: string } = {}) {
  for (const [id, session] of [...sessions]) {
    if ((payload.streamId && id === payload.streamId) || (payload.requestId && session.requestId === payload.requestId)) {
      releaseOnlineSession(id);
    }
  }
  return { success: true };
}

/** 供前端轮询的准备进度。 */
export function onlinePlayProgress(requestId: string) {
  for (const session of sessions.values()) {
    if (session.requestId !== requestId) continue;
    const job = session.job;
    if (!job) return { active: false, phase: '', received: 0, total: 0, percent: 0 };
    const { received, total, phase } = job.progress;
    return { active: true, phase, received, total, percent: total ? Math.floor(received / total * 100) : 0 };
  }
  return { active: false, phase: '', received: 0, total: 0, percent: 0 };
}

// 会话 TTL 清理：2 小时未使用的会话自动释放
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of [...sessions]) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) releaseOnlineSession(id);
  }
}, 10 * 60 * 1000).unref?.();

// ── Range 响应 ────────────────────────────────────────────────────────────

/** Only a single valid byte range is supported; malformed/unsatisfiable => 416. */
export function mediaRange(range: string | null, size: number) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

/** 明文流式转发：Range 透传给上游。上游取源失败时允许重取一次。 */
async function streamingResponse(request: Request, session: Session): Promise<Response> {
  let playInfo = session.entry?.playInfo;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!playInfo) {
      const result = await hongguo.fetchPlayUrlSingle(session.vid, session.seriesId, { force: attempt > 0 });
      if (!result.url) throw new Error(result.error || '未获取到有效播放地址');
      playInfo = result as hongguo.PlayInfo;
      if (session.entry) session.entry.playInfo = playInfo;
    }
    try {
      const upstream = await requestMedia(playInfo, request.headers.get('range'), request.signal);
      const headers = new Headers();
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (!headers.has('content-type')) headers.set('content-type', 'video/mp4');
      if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes');
      headers.set('Cache-Control', 'no-store');
      if (request.method === 'HEAD') return new Response(null, { status: upstream.status, headers });
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error: any) {
      if (request.signal.aborted || error?.code === 'ERR_CANCELED') throw error;
      if (attempt === 1) throw error;
      // 取源重试一次（对齐桌面端 reconnectOnce）
      playInfo = undefined;
      hongguo.markWebMediaFailure(playInfo ?? null);
    }
  }
  throw mediaTransferError('片源连接失败，请重新连接');
}

export async function serveMedia(request: Request, streamId: string): Promise<Response> {
  const session = sessions.get(streamId);
  if (!session) return new Response('stream not found', { status: 404 });
  const entry = session.entry;
  if (!entry) return new Response('stream not ready', { status: 409 });

  if (entry.filePath) {
    // 解密/整集落盘产物：本地 Range 服务（filePath 只在解密完成后设置；
    // playInfo 仅为溯源保留，可能仍带加密标记，不能据此改走透传）
    let size = entry.size;
    try { size = fs.statSync(entry.filePath).size; } catch { /* keep recorded size */ }
    const range = mediaRange(request.headers.get('range'), size);
    if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const { start, end } = range || { start: 0, end: size - 1 };
    const headers: Record<string, string> = {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Cache-Control'] = 'no-store';
    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    const file = Bun.file(entry.filePath);
    const slice = file.slice(start, end + 1);
    return new Response(slice, { status: range ? 206 : 200, headers });
  }

  if (entry.playInfo) return streamingResponse(request, session);
  return new Response('stream not ready', { status: 409 });
}

export function normalizeQuality(value: string | undefined) {
  return normalizeDownloadQuality(value);
}

/**
 * 整集下载解密为 Buffer（供下载任务复用）。
 * 走与在线播放相同的取源恢复链与 CENC 解密流水线。
 */
export async function downloadEpisodeBuffer(
  seriesId: string,
  vid: string,
  quality: string,
  onProgress?: (phase: string, received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const job: Job = {
      key: `download:${vid}:${quality}`, force: false, controller,
      progress: { received: 0, total: 0, phase: 'preparing' },
      promise: null as any,
    };
    return await withMediaRecovery(vid, String(seriesId), { quality, force: false, signal: controller.signal }, async (playInfo) => {
      const { buffer } = await fetchDecryptedEpisode(String(seriesId), playInfo, job);
      return buffer;
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

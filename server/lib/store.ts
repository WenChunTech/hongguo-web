// SPDX-License-Identifier: GPL-3.0-only
// 单 JSON 文件持久化（settings / series / playback）。
// Ported from hongguo-drama src/store.js：临时文件 + fsync + rename 原子替换。
import fs from 'node:fs';
import path from 'node:path';

let dataFile: string | null = null;
let cache: any = null;
let durable = '{}';

export interface SeriesEpisode {
  vid: string; vid_index: number; title: string; cover?: string;
  web_available?: boolean | null; locked?: boolean; duration?: number;
}
export interface SeriesEntry {
  series_id: string; series_title: string; cover: string;
  total: number; web_accessible_episodes?: number | null;
  series_intro?: string;
  episodes: SeriesEpisode[]; updatedAt: number;
}
export interface PlaybackRecord {
  vid_index: number; currentTime: number; updatedAt: number; watched?: boolean;
  completedEpisode?: number; knownTotal?: number; acknowledgedTotal?: number;
  unreadEpisodes?: number; lastCheckedAt?: number; lastCheckError?: string;
  duration?: number;
}

function loadCache() {
  if (!dataFile) throw new Error('store 未初始化');
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new TypeError('Invalid store document');
    for (const key of ['series']) {
      if (key in cache && !Array.isArray(cache[key])) throw new TypeError(`Invalid store ${key}`);
    }
    for (const key of ['settings', 'playback']) {
      if (key in cache && (!cache[key] || typeof cache[key] !== 'object' || Array.isArray(cache[key]))) {
        throw new TypeError(`Invalid store ${key}`);
      }
    }
  } catch (e: any) {
    cache = {};
    if (e.code !== 'ENOENT') console.warn('[Store] 读取本地数据失败，已按空数据继续:', e.message);
  }
  if (!Array.isArray(cache.series)) cache.series = [];
  if (!cache.settings || typeof cache.settings !== 'object') cache.settings = {};
  if (!cache.playback || typeof cache.playback !== 'object') cache.playback = {};
  durable = JSON.stringify(cache);
  return cache;
}

function flush() {
  if (!dataFile) return;
  const temporary = dataFile + '.tmp';
  try {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const serialized = JSON.stringify(cache || {}, null, 2);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, dataFile);
    durable = serialized;
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch { /* ignore */ }
    cache = JSON.parse(durable);
    throw e;
  }
}

export function init(filePath: string) {
  dataFile = filePath;
  cache = null;
  loadCache();
}

export function getSettings(): Record<string, unknown> { return loadCache().settings; }
export function saveSettings(settings: Record<string, unknown>) { loadCache().settings = settings || {}; flush(); }

export function getSeries(): SeriesEntry[] {
  const c = loadCache();
  if (!Array.isArray(c.series)) c.series = [];
  return c.series;
}
export function saveSeries(list: SeriesEntry[]) { loadCache().series = list || []; flush(); }

export function getPlayback(): Record<string, PlaybackRecord> {
  const c = loadCache();
  if (!c.playback || typeof c.playback !== 'object') c.playback = {};
  return c.playback;
}
export function savePlayback(map: Record<string, PlaybackRecord>) { loadCache().playback = map || {}; flush(); }

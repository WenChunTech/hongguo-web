// SPDX-License-Identifier: GPL-3.0-only
// 服务端批量下载任务：区间语法选集（移植桌面端 episodeRange.js）、并发 2、
// 逐集复用在线播放的取源解密流水线，落盘 {剧名}/第N集.mp4（.part 防损改名）。
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store';
import { downloadEpisodeBuffer, playbackQuality } from './stream';

const DOWNLOAD_CONCURRENCY = 2;
let downloadDir = '';

export function setDownloadDir(dir: string) {
  downloadDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/** Match whole tokens; clamp iteration to the actual episode count.（移植桌面端） */
export function parseEpisodeRange(value: string, total: number): Set<number> {
  const parts = String(value || '').trim().split(/[,，]/);
  const selected = new Set<number>();
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)(?:\s*[-~～]\s*(\d+))?$/);
    if (!match) throw new Error('集数格式不正确，请输入 1-30 或 1，5，10；原选择已保留。');
    const a = Number(match[1]);
    const b = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) {
      throw new Error('集数必须是大于 0 的整数；原选择已保留。');
    }
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(total, Math.max(a, b)); n++) selected.add(n);
  }
  if (!selected.size) throw new Error(`集数超出范围，请选择 1-${total} 集；原选择已保留。`);
  return selected;
}

function sanitize(name: string) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || '未命名短剧';
}

export interface DownloadEpisodeState {
  vid: string; vid_index: number; title: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'skipped';
  size: number; path?: string; error?: string;
}
export interface DownloadTask {
  id: string; seriesId: string; seriesTitle: string; quality: string;
  status: 'running' | 'completed' | 'cancelled';
  createdAt: number;
  episodes: DownloadEpisodeState[];
}

const tasks = new Map<string, DownloadTask>();

export function createDownloadTask(payload: { seriesId: string; range?: string; quality?: string; id: string }): DownloadTask {
  const entry = store.getSeries().find((item) => String(item.series_id) === String(payload.seriesId));
  if (!entry) throw new Error('未找到短剧档案，请先在搜索或发现页打开这部剧');
  const quality = playbackQuality(payload.quality);
  const total = entry.episodes.length;
  if (!total) throw new Error('这部剧还没有可下载的分集');
  const rangeSpec = String(payload.range ?? '').trim();
  let indexes: number[];
  if (rangeSpec) {
    const selected = parseEpisodeRange(rangeSpec, total);
    indexes = [...selected];
  } else {
    indexes = entry.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid_index);
  }
  if (!indexes.length) throw new Error('没有可下载的分集（锁定集不可下载）');
  const byIndex = new Map(entry.episodes.map((ep) => [ep.vid_index, ep]));
  const task: DownloadTask = {
    id: payload.id,
    seriesId: entry.series_id,
    seriesTitle: entry.series_title,
    quality,
    status: 'running',
    createdAt: Date.now(),
    episodes: indexes.map((index) => {
      const ep = byIndex.get(index)!;
      return { vid: ep.vid, vid_index: ep.vid_index, title: ep.title || `第 ${ep.vid_index} 集`, status: 'pending' as const, size: 0 };
    }),
  };
  tasks.set(task.id, task);
  void runTask(task);
  return task;
}

async function runTask(task: DownloadTask) {
  const seriesDir = path.join(downloadDir, sanitize(task.seriesTitle));
  fs.mkdirSync(seriesDir, { recursive: true });
  let cursor = 0;
  const worker = async () => {
    while (task.status === 'running') {
      const index = cursor++;
      if (index >= task.episodes.length) return;
      const ep = task.episodes[index];
      if (ep.status !== 'pending') continue;
      ep.status = 'downloading';
      const finalPath = path.join(seriesDir, `第${String(ep.vid_index).padStart(3, '0')}集.mp4`);
      const tmpPath = `${finalPath}.part`;
      try {
        // 已有成品直接跳过（重跑任务幂等）
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
          ep.status = 'completed';
          ep.size = fs.statSync(finalPath).size;
          ep.path = finalPath;
          continue;
        }
        const buffer = await downloadEpisodeBuffer(task.seriesId, ep.vid, task.quality);
        if (task.status !== 'running') { ep.status = 'pending'; return; }
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, finalPath);
        ep.status = 'completed';
        ep.size = buffer.length;
        ep.path = finalPath;
      } catch (error: any) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        ep.status = 'failed';
        ep.error = error?.message || '下载失败';
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker()));
  if (task.status === 'running') task.status = 'completed';
}

export function listTasks(): DownloadTask[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getTask(id: string): DownloadTask | null {
  return tasks.get(id) ?? null;
}

export function cancelDownloadTask(id: string) {
  const task = tasks.get(id);
  if (!task) return { success: false, error: '任务不存在' };
  if (task.status === 'running') task.status = 'cancelled';
  return { success: true };
}

/** 清理 .part 残留（启动时调用）。 */
export function cleanupPartials() {
  try {
    for (const series of fs.readdirSync(downloadDir)) {
      const dir = path.join(downloadDir, series);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.part')) { try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ } }
      }
    }
  } catch { /* ignore */ }
}

export interface DownloadedFile { series: string; file: string; path: string; size: number; mtime: number }

export function listDownloadedFiles(): { series: string; files: DownloadedFile[] }[] {
  const out: { series: string; files: DownloadedFile[] }[] = [];
  try {
    for (const series of fs.readdirSync(downloadDir)) {
      const dir = path.join(downloadDir, series);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files: DownloadedFile[] = [];
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.mp4')) continue;
        try {
          const full = path.join(dir, file);
          const st = fs.statSync(full);
          files.push({ series, file, path: full, size: st.size, mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }
      files.sort((a, b) => a.file.localeCompare(b.file));
      out.push({ series, files });
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => a.series.localeCompare(b.series));
}

// SPDX-License-Identifier: GPL-3.0-only
// 剧集档案（series registry）与观看历史。对应桌面端 main.js 的 seriesRegistry
// 与 src/native/watch-history.js（listHistory/recordPlayback 的简化移植，
// 不含续作探测）。
import * as store from './store';
import * as hongguo from './hongguo';

const REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const REFRESH_BATCH = 20;

export function findSeries(seriesId: string) {
  return store.getSeries().find((item) => String(item.series_id) === String(seriesId)) || null;
}

export function saveSeriesEntry(entry: store.SeriesEntry) {
  const list = store.getSeries();
  const index = list.findIndex((item) => String(item.series_id) === String(entry.series_id));
  entry.updatedAt = Date.now();
  if (index >= 0) list[index] = { ...list[index], ...entry, updatedAt: Date.now() };
  else list.unshift(entry);
  store.saveSeries(list);
  return entry;
}

/** 拉全集并登记档案（对应桌面端 searchResolve / hongguoResolve 的档案部分）。 */
export async function registerSeries(seriesId: string) {
  const detail = await hongguo.fetchEpisodeList(String(seriesId));
  const entry = saveSeriesEntry({
    series_id: String(detail.series_id),
    series_title: detail.series_title,
    cover: detail.cover || '',
    total: detail.total,
    web_accessible_episodes: (detail as any).web_accessible_episodes ?? null,
    series_intro: (detail as any).series_intro || undefined,
    episodes: detail.episodes.map((ep: any) => ({
      vid: String(ep.vid), vid_index: Number(ep.vid_index), title: ep.title || '',
      cover: ep.cover || '', web_available: ep.web_available ?? null, locked: ep.locked === true,
      duration: Number(ep.duration) > 0 ? Number(ep.duration) : undefined,
    })),
    updatedAt: Date.now(),
  });
  // 登记后同步刷新一次该部的已知总集数（新剧追更提示）
  const playback = store.getPlayback();
  const record = playback[entry.series_id];
  if (record) {
    playback[entry.series_id] = applyEpisodeUpdate(record, entry, Date.now());
    store.savePlayback(playback);
  }
  return entry;
}

function totalEpisodes(series: store.SeriesEntry | null) {
  return Math.max(Number(series?.total) || 0, series?.episodes?.length || 0);
}

export function recordPlayback(previous: store.PlaybackRecord | undefined, series: store.SeriesEntry,
  index: number, time: number, now = Date.now(), metadata: { duration?: number; ended?: boolean } = {}): store.PlaybackRecord {
  if (!Number.isInteger(index) || index < 1 || !Number.isFinite(time) || time < 0) throw new Error('无效的播放进度');
  const baseline = previous?.knownTotal ?? totalEpisodes(series);
  const duration = metadata?.duration;
  const completed = metadata?.ended === true && Number.isFinite(duration) && duration! > 0
    && time >= duration! - Math.min(1, duration! * 0.01) && time <= duration! + 1
    && index === Math.max(totalEpisodes(series), baseline);
  return { ...previous, vid_index: index, currentTime: time, updatedAt: now, watched: true,
    ...(completed ? { completedEpisode: Math.max(Number.isInteger(previous?.completedEpisode) ? previous!.completedEpisode! : 0, index) } : {}),
    knownTotal: baseline, acknowledgedTotal: previous?.acknowledgedTotal ?? baseline };
}

export function applyEpisodeUpdate(record: store.PlaybackRecord, freshSeries: store.SeriesEntry, now = Date.now()): store.PlaybackRecord {
  const baseline = record.knownTotal ?? record.vid_index ?? 0;
  const knownTotal = Math.max(baseline, totalEpisodes(freshSeries));
  const acknowledgedTotal = record.acknowledgedTotal ?? baseline;
  return { ...record, knownTotal, acknowledgedTotal,
    unreadEpisodes: Math.max(0, knownTotal - acknowledgedTotal), lastCheckedAt: now, lastCheckError: '' };
}

function isWatched(record?: store.PlaybackRecord | null) {
  return record && (record.watched === true || Number(record.currentTime) > 0)
    && Number.isFinite(record.updatedAt) && Number.isInteger(record.vid_index) && record.vid_index > 0;
}

export function listHistory() {
  const series = store.getSeries();
  const playback = store.getPlayback();
  return series.filter((item) => isWatched(playback[item.series_id])).map((item) => {
    const record = playback[item.series_id];
    const total = Math.max(totalEpisodes(item), record.knownTotal || 0);
    return {
      series_id: item.series_id, series_title: item.series_title, cover: item.cover || '',
      total, completed: total > 0 && typeof record.completedEpisode === 'number' && record.completedEpisode >= total,
      vid_index: record.vid_index, currentTime: record.currentTime, updatedAt: record.updatedAt,
      unreadEpisodes: record.unreadEpisodes || 0,
      hasUpdates: (record.unreadEpisodes || 0) > 0,
      lastCheckedAt: record.lastCheckedAt || 0, lastCheckError: record.lastCheckError || '',
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 观看记录页打开时静默刷新总集数（6 小时一部的节流，单批 ≤20）。 */
export async function refreshHistoryTotals(force = false) {
  const series = store.getSeries();
  const playback = store.getPlayback();
  const now = Date.now();
  const stale = series.filter((item) => {
    if (!isWatched(playback[item.series_id])) return false;
    if (force) return true;
    return now - (playback[item.series_id].lastCheckedAt || 0) > REFRESH_INTERVAL;
  }).slice(0, REFRESH_BATCH);
  let changed = false;
  await Promise.allSettled(stale.map(async (item) => {
    try {
      const fresh = await hongguo.fetchEpisodeList(String(item.series_id));
      const entry: store.SeriesEntry = {
        series_id: item.series_id, series_title: fresh.series_title, cover: fresh.cover || item.cover,
        total: fresh.total, web_accessible_episodes: (fresh as any).web_accessible_episodes ?? item.web_accessible_episodes ?? null,
        episodes: fresh.episodes.map((ep: any) => ({ vid: String(ep.vid), vid_index: Number(ep.vid_index), title: ep.title || '',
          cover: ep.cover || '', web_available: ep.web_available ?? null, locked: ep.locked === true })),
        updatedAt: item.updatedAt,
      };
      saveSeriesEntry(entry);
      const record = playback[item.series_id];
      if (record) {
        playback[item.series_id] = applyEpisodeUpdate(record, entry, Date.now());
        changed = true;
      }
    } catch (error: any) {
      const record = playback[item.series_id];
      if (record) {
        playback[item.series_id] = { ...record, lastCheckedAt: Date.now(), lastCheckError: error?.message || '刷新失败' };
        changed = true;
      }
    }
  }));
  if (changed) store.savePlayback(playback);
  return listHistory();
}

export function acknowledgeWatchUpdates(seriesId: string, snapshot?: { total?: number }) {
  const playback = store.getPlayback();
  const record = playback[String(seriesId)];
  if (!record) return { success: false, error: '未找到播放记录' };
  const knownTotal = record.knownTotal || 0;
  const visibleTotal = snapshot ? Number(snapshot.total) || 0 : knownTotal;
  const acknowledgedTotal = Math.max(record.acknowledgedTotal || 0, Math.min(knownTotal, visibleTotal));
  playback[String(seriesId)] = { ...record, acknowledgedTotal, unreadEpisodes: Math.max(0, knownTotal - acknowledgedTotal) };
  store.savePlayback(playback);
  return { success: true };
}

export function removeWatchHistory(seriesId: string) {
  const playback = store.getPlayback();
  delete playback[String(seriesId)];
  store.savePlayback(playback);
  return { success: true };
}

/** get-series-episodes：档案分集 + 在线可播状态（Web 版没有本地下载）。 */
export function getSeriesEpisodes(seriesId: string) {
  const sid = String(seriesId);
  const entry = findSeries(sid);
  if (!entry) return { success: false as const, error: '未找到短剧档案，请先在搜索或发现页打开这部剧' };
  const playback = store.getPlayback()[sid] || null;
  return {
    success: true as const,
    data: {
      series_id: sid,
      series_title: entry.series_title,
      cover: entry.cover,
      web_accessible_episodes: entry.web_accessible_episodes ?? null,
      total: entry.episodes.length || entry.total,
      episodes: entry.episodes.map((ep) => ({
        vid: ep.vid,
        vid_index: ep.vid_index,
        title: ep.title || '',
        web_available: ep.web_available ?? null,
        locked: ep.locked === true,
        status: 'online' as const,
      })),
      resume: playback ? { vid_index: playback.vid_index, currentTime: playback.currentTime, updatedAt: playback.updatedAt } : null,
    },
  };
}

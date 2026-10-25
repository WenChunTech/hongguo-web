// 前端 → Bun 后端的类型化客户端（对应桌面端 preload.js 的 electronAPI）。

export interface BrowseCategory { slug: string; label: string; group?: string }
export interface CardItem {
  series_id: string; series_title: string; cover: string;
  episode_count: number; tags: string[];
  rank?: number; heat?: string;
  series_intro?: string; score?: string; play_cnt?: number;
  episode_label?: string; completion_status?: string; published_at?: number | null;
  url?: string;
}
export interface SearchPageResult {
  success: boolean; results?: CardItem[]; source?: string;
  hasMore?: boolean; nextOffset?: number; searchId?: string;
  error?: string;
}
export interface SuggestRow {
  name: string; keyword: string; abstract: string;
  seriesId?: string; seriesTitle?: string; cover?: string;
}
export interface SeriesMeta {
  hot_score?: number; follow_cnt?: number; series_play_cnt?: number;
  record_number?: string; series_intro?: string; creation_status?: number;
}
export interface RelatedSeries { series_id: string; series_title: string; cover: string; season?: number }
export interface DownloadTaskInfo {
  id: string; seriesId: string; seriesTitle: string; quality: string;
  status: 'running' | 'completed' | 'cancelled'; createdAt: number;
  episodes: { vid: string; vid_index: number; title: string; status: string; size: number; path?: string; error?: string }[];
}
export interface BrowseListResult {
  success: boolean; results?: CardItem[]; page?: number; total?: number; totalPages?: number;
  genres?: { slug: string; label: string }[]; pageTitle?: string; sourceUrl?: string;
  unsupported?: boolean; emptyMessage?: string; error?: string;
}
export interface EpisodeSummary {
  vid: string; vid_index: number; title: string;
  web_available?: boolean | null; locked?: boolean; status: 'online';
  duration?: number;
}
export interface SeriesDetail {
  series_id: string; series_title: string; cover: string;
  web_accessible_episodes: number | null; total: number;
  series_intro?: string;
  episodes: EpisodeSummary[];
  resume?: { vid_index: number; currentTime: number; updatedAt: number } | null;
}
export interface PrepareResult {
  success: boolean; url?: string; streamId?: string; size?: number;
  cached?: boolean; streaming?: boolean; error?: string; code?: string;
}
export interface DanmakuItem { time: number; text: string; color: string; mode: string }
export interface DanmakuResult {
  success: boolean; source: string; series_id: string; episode_id: string;
  items: DanmakuItem[]; total: number; truncated: boolean; partial: boolean;
  error: string; notice: string;
}
export interface CommentPage {
  success: boolean; series_id?: string; episode_id?: string;
  items?: { id: string; content: string }[];
  next_cursor?: string | null; has_more?: boolean; total?: number | null;
  source_limited?: boolean; notice?: string; error?: string;
}
export interface HistoryRow {
  series_id: string; series_title: string; cover: string;
  total: number; completed: boolean; vid_index: number; currentTime: number;
  updatedAt: number; unreadEpisodes: number; hasUpdates: boolean;
  lastCheckedAt: number; lastCheckError: string;
}
export interface PlaybackRecord {
  vid_index: number; currentTime: number; updatedAt: number; watched?: boolean;
  knownTotal?: number; unreadEpisodes?: number; duration?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch { /* keep default */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  browseCategories: () => request<{ success: boolean; categories: BrowseCategory[] }>('/api/browse-categories'),
  browseList: (params: { category: string; genre?: string; page?: number; force?: boolean }) => {
    const q = new URLSearchParams({ category: params.category, page: String(params.page ?? 1) });
    if (params.genre) q.set('genre', params.genre);
    if (params.force) q.set('force', '1');
    return request<BrowseListResult>(`/api/browse-list?${q}`);
  },
  search: (keyword: string, offset = 0, searchId = '') => request<SearchPageResult>(
    `/api/search?keyword=${encodeURIComponent(keyword)}&offset=${offset}&searchId=${encodeURIComponent(searchId)}`),
  searchSuggest: (q: string) => request<{ success: boolean; results: SuggestRow[] }>(
    `/api/search-suggest?q=${encodeURIComponent(q)}`),
  seriesMeta: (seriesId: string) => request<{ success: boolean; meta?: SeriesMeta; error?: string }>(
    `/api/series-meta?seriesId=${encodeURIComponent(seriesId)}`),
  related: (seriesId: string) => request<{ success: boolean; related: RelatedSeries[]; recommended: RelatedSeries[] }>(
    `/api/related?seriesId=${encodeURIComponent(seriesId)}`),
  downloads: () => request<{ success: boolean; tasks: DownloadTaskInfo[] }>('/api/downloads'),
  downloadFiles: () => request<{ success: boolean; groups: { series: string; files: { file: string; path: string; size: number; mtime: number }[] }[] }>('/api/downloads/files'),
  createDownload: (payload: { seriesId: string; range?: string; quality?: string }) => request<{ success: boolean; task?: DownloadTaskInfo; error?: string }>('/api/downloads/create', {
    method: 'POST', body: JSON.stringify(payload),
  }),
  cancelDownload: (id: string) => request<{ success: boolean }>('/api/downloads/cancel', {
    method: 'POST', body: JSON.stringify({ id }),
  }),
  resolve: (input: string) => request<{ success: boolean; series_id?: string; error?: string }>('/api/resolve', {
    method: 'POST', body: JSON.stringify({ input }),
  }),
  registerSeries: (seriesId: string) => request<{ success: boolean; data?: SeriesDetail; error?: string }>('/api/series/register', {
    method: 'POST', body: JSON.stringify({ seriesId }),
  }),
  seriesList: () => request<{ success: boolean; results: { series_id: string; series_title: string; cover: string; total: number; updatedAt: number; resume: PlaybackRecord | null }[] }>('/api/series-list'),
  seriesEpisodes: (seriesId: string) => request<{ success: boolean; data?: SeriesDetail; error?: string }>(`/api/series-episodes?seriesId=${encodeURIComponent(seriesId)}`),
  forgetSeries: (seriesId: string) => request<{ success: boolean }>('/api/series/forget', {
    method: 'POST', body: JSON.stringify({ seriesId }),
  }),
  playPrepare: (payload: { vid: string; seriesId: string; vidIndex: number; quality: string; requestId: string; force?: boolean; prefetch?: boolean }) =>
    request<PrepareResult>('/api/play-prepare', { method: 'POST', body: JSON.stringify(payload) }),
  playRelease: (payload: { streamId?: string; requestId?: string }) => request<{ success: boolean }>('/api/play-release', {
    method: 'POST', body: JSON.stringify(payload),
  }),
  playProgress: (requestId: string) => request<{ active: boolean; phase: string; received: number; total: number; percent: number }>(
    `/api/play-progress?requestId=${encodeURIComponent(requestId)}`),
  playbackPosition: (seriesId: string) => request<PlaybackRecord | null>(`/api/playback-position?seriesId=${encodeURIComponent(seriesId)}`),
  savePosition: (payload: { seriesId: string; vidIndex: number; currentTime: number; duration?: number; ended?: boolean }) =>
    request<{ success: boolean }>('/api/save-position', { method: 'POST', body: JSON.stringify(payload) }),
  watchHistory: (force = false) => request<{ success: boolean; results: HistoryRow[] }>(`/api/watch-history${force ? '?force=1' : ''}`),
  removeWatchHistory: (seriesId: string) => request<{ success: boolean }>('/api/remove-watch-history', {
    method: 'POST', body: JSON.stringify({ seriesId }),
  }),
  acknowledge: (seriesId: string, snapshot: { total: number }) => request<{ success: boolean }>('/api/acknowledge-watch-updates', {
    method: 'POST', body: JSON.stringify({ seriesId, snapshot }),
  }),
  publicDetails: (seriesId: string, vid?: string) => request<any>(
    `/api/public-details?seriesId=${encodeURIComponent(seriesId)}${vid ? `&vid=${encodeURIComponent(vid)}` : ''}`),
  episodeComments: (seriesId: string, episodeId: string) => request<CommentPage>(
    `/api/episode-comments?seriesId=${encodeURIComponent(seriesId)}&episodeId=${encodeURIComponent(episodeId)}`),
  episodeDanmaku: (seriesId: string, vid: string, fresh = false) => request<DanmakuResult>(
    `/api/episode-danmaku?seriesId=${encodeURIComponent(seriesId)}&vid=${encodeURIComponent(vid)}${fresh ? '&fresh=1' : ''}`),
  onlineCacheStatus: () => request<{ success: boolean; count: number; bytes: number }>('/api/online-cache-status'),
  clearOnlineCache: () => request<{ success: boolean }>('/api/clear-online-cache', { method: 'POST' }),
};

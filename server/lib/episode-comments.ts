// SPDX-License-Identifier: GPL-3.0-only
// 本集公开评论（官方分时弹幕的兜底来源）。Ported from episode-comments.js。
import { createHash } from 'node:crypto';
import { fetchPublicDetails } from './public-details';

const NOTICE = '官网仅提供本集部分评论，暂未提供可用的公开翻页接口；更多评论请到红果短剧 App 查看。';

export async function fetchEpisodeComments(options: { seriesId?: string; episodeId?: string; cursor?: string | null; limit?: number } | undefined) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { success: false as const, error: '评论请求无效' };
  const { seriesId, episodeId, cursor = null, limit = 30 } = options;
  if (typeof seriesId !== 'string' || !/^\d{6,30}$/.test(seriesId) ||
    typeof episodeId !== 'string' || !/^\d{6,30}$/.test(episodeId) ||
    !Number.isInteger(limit) || limit! < 1 || limit! > 30) return { success: false as const, error: '评论请求编号或条数无效' };
  if (cursor !== null) return { success: false as const, source_limited: true, error: NOTICE };
  const details = await fetchPublicDetails(seriesId, episodeId);
  if (!details.success) return details;
  const seen = new Set<string>();
  const items: { id: string; content: string }[] = [];
  for (const review of details.episode_reviews?.items || []) {
    // The public preview has no comment IDs; hash stable fields, excluding changing like counts.
    const id = createHash('sha256').update(JSON.stringify([seriesId, episodeId, review.author, review.created_at, review.content])).digest('hex');
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, content: review.content });
    if (items.length >= limit!) break;
  }
  return { success: true as const, series_id: seriesId, episode_id: episodeId, items, next_cursor: null as string | null,
    has_more: false, total: details.episode_reviews?.total ?? null, source_limited: true, notice: NOTICE };
}

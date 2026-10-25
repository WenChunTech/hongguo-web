// SPDX-License-Identifier: GPL-3.0-only
// 官网公开详情（评分/剧评/收藏数）。Ported from hongguo-drama src/native/public-details.js。
import { readRouterData, publicMetadata, SITE } from './catalog';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const cache = new Map<string, { expires: number; data: any }>();
const pending = new Map<string, Promise<any>>();
const count = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function reviews(value: any) {
  return { total: count(value?.total_count), items: (Array.isArray(value?.reviews) ? value.reviews : [])
    .filter((item: any) => typeof item?.content === 'string' && item.content.trim()).slice(0, 50).map((item: any) => {
      const created = count(item.create_time);
      return { author: typeof item.user_name === 'string' ? item.user_name.slice(0, 200) : '',
        avatar: typeof item.user_avatar === 'string' && /^https?:\/\//i.test(item.user_avatar) ? item.user_avatar.slice(0, 4096) : '',
        content: item.content.slice(0, 20000), created_at: created ? created * (created < 1e12 ? 1000 : 1) : null,
        likes: count(item.digg_count), rating: count(item.rating) };
    }) };
}

export function parsePublicDetails(html: string, seriesId: string, vid = '') {
  const router = readRouterData(html);
  const data = Object.values<any>(router.loaderData || {}).find((value) => value?.seriesDetail && value.isSuccess !== false);
  if (!data) throw new Error('来源页面未返回公开剧集信息');
  if (String(data.seriesDetail.series_id) !== seriesId) throw new Error('来源页面剧集不匹配');
  if (vid && String(data.vid) !== vid) throw new Error('来源页面分集不匹配');
  const social = data.seriesSocialInfo || {};
  return { success: true as const, series_id: seriesId, episode_id: vid || null,
    ...publicMetadata(data.seriesDetail), rating: count(social.rating), rating_count: count(social.rating_count),
    like_count: count(social.series_like_count), favorite_count: count(social.series_favorite_count),
    reviews: reviews(social.reviews), episode_reviews: vid ? reviews(data.episodeSocialInfo?.reviews) : null,
    episode_like_count: vid ? count(data.episodeSocialInfo?.episode_like_count) : null,
    sourceUrl: vid ? `${SITE}/player/${seriesId}/${vid}` : `${SITE}/detail?series_id=${seriesId}` };
}

export async function fetchPublicDetails(seriesId: string, vid = '') {
  seriesId = String(seriesId || '');
  vid = String(vid || '');
  if (!/^\d{6,30}$/.test(seriesId) || (vid && !/^\d{6,30}$/.test(vid))) return { success: false as const, error: '仅支持有效的红果剧集和分集编号' };
  const url = vid ? `${SITE}/player/${seriesId}/${vid}` : `${SITE}/detail?series_id=${seriesId}`;
  if (cache.get(url)?.expires! > Date.now()) return cache.get(url)!.data;
  if (pending.has(url)) return pending.get(url)!;
  const request = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'follow',
        headers: { 'User-Agent': UA, Referer: `${SITE}/` } });
      if (!response.ok) throw Object.assign(new Error(`公开信息加载失败（HTTP ${response.status}）`), { response });
      const data = parsePublicDetails(await response.text(), seriesId, vid);
      cache.set(url, { expires: Date.now() + 30000, data });
      if (cache.size > 64) cache.delete(cache.keys().next().value as string);
      return data;
    } catch (error: any) {
      return { success: false as const, sourceUrl: url, error: ['ECONNABORTED', 'ERR_CANCELED', 'TimeoutError'].includes(error?.name ?? error?.code)
        ? '公开评论加载超时，请重试' : error?.message ?? '公开评论加载失败' };
    } finally { pending.delete(url); }
  })();
  pending.set(url, request);
  return request;
}

// SPDX-License-Identifier: GPL-3.0-only
// 关键词搜索：App 签名接口（可分页、富字段）为主，官网 SSR searchList 兜底。
// 历史上依赖无头 Chrome 渲染搜索页；参考 it00021hot/hongguo-desktop 与
// sunnysky123/hongguo-web 的实测后改为纯 HTTP 签名接口，浏览器依赖已移除。
import * as reading from './reading';

export interface SearchCard {
  series_id: string; series_title: string; cover: string;
  episode_count: number; tags: string[];
  series_intro?: string; score?: string; heat?: string; play_cnt?: number;
  url?: string;
}

export async function searchSeries(keyword: string, offset = 0, searchId = '') {
  const result = await reading.searchSeries(keyword, offset, searchId);
  if (!result.success) return { success: false as const, results: [] as SearchCard[], error: result.error };
  const results: SearchCard[] = result.results.map((row) => ({
    series_id: row.series_id,
    series_title: row.series_title,
    cover: row.cover,
    episode_count: row.episode_cnt,
    tags: [row.score ? `评分 ${row.score}` : '', row.heat ?? (row.play_cnt ? formatPlayCount(row.play_cnt) : '')].filter(Boolean),
    ...(row.series_intro ? { series_intro: row.series_intro } : {}),
    ...(row.score ? { score: row.score } : {}),
    ...(row.heat ? { heat: row.heat } : {}),
    ...(row.play_cnt ? { play_cnt: row.play_cnt } : {}),
    url: `https://hongguoduanju.com/detail?series_id=${row.series_id}`,
  }));
  return { success: true as const, results, hasMore: result.hasMore, nextOffset: result.nextOffset, searchId: result.searchId, source: result.source };
}

export async function searchSuggest(q: string) {
  return reading.searchSuggest(q);
}

function formatPlayCount(count: number) {
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿次播放`;
  if (count >= 10000) return `${(count / 10000).toFixed(count >= 1000000 ? 0 : 1)}万次播放`;
  return `${count}次播放`;
}

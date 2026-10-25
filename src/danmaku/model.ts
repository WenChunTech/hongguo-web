// SPDX-License-Identifier: GPL-3.0-only
// 弹幕视觉模型（车道布局/重排/评论队列）。移植自 hongguo-drama
// src/components/danmakuModel.mjs（GPL-3.0）。
import type { DanmakuItem } from '../api';

export interface DanmakuSettings {
  opacity: number; fontSize: number; speed: number;
  area: 'quarter' | 'half' | 'full';
  density: 'sparse' | 'normal' | 'dense';
  sensitiveFilter: boolean; blockedWords: string;
}

export const DEFAULT_DANMAKU_SETTINGS: Readonly<DanmakuSettings> =
  Object.freeze({ opacity: 80, fontSize: 22, speed: 1, area: 'half', density: 'normal', sensitiveFilter: true, blockedWords: '' });

export function normalizeDanmakuSettings(value: any): DanmakuSettings {
  const number = (key: keyof DanmakuSettings, min: number, max: number): number => typeof value?.[key] === 'number' && Number.isFinite(value[key])
    ? Math.max(min, Math.min(max, value[key])) : DEFAULT_DANMAKU_SETTINGS[key] as number;
  return {
    opacity: number('opacity', 20, 100), fontSize: number('fontSize', 16, 32), speed: number('speed', 0.5, 2),
    area: ['quarter', 'half', 'full'].includes(value?.area) ? value.area : 'half',
    density: ['sparse', 'normal', 'dense'].includes(value?.density) ? value.density : 'normal',
    sensitiveFilter: value?.sensitiveFilter !== false,
    blockedWords: typeof value?.blockedWords === 'string' ? value.blockedWords.slice(0, 10000) : '',
  };
}

const BUILTIN_BLOCKED_WORDS = ['习近平', '習近平', '共产党', '共產黨', '中国共产党', '中共', '国民党', '國民黨', '民进党', '民進黨',
  '毛泽东', '毛澤東', '邓小平', '鄧小平', '江泽民', '江澤民', '胡锦涛', '胡錦濤', '李克强', '李克強', '蔡英文', '赖清德', '賴清德',
  '台独', '台獨', '港独', '港獨', '藏独', '藏獨', '疆独', '疆獨', '六四', '天安门事件', '天安門事件', '法轮功', '法輪功', '反共', '反华', '反華',
  '文革', '文化大革命', '政治局', '颠覆政权', '顛覆政權', '操你妈', '操你媽', '傻逼', '傻屄'];
const comparable = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
const cleanText = (text: string) => text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

export function commentIsBlocked(content: string, settings: DanmakuSettings) {
  const words = (settings.blockedWords || '').split(/[\n,，;；]+/).map(comparable).filter(Boolean);
  if (settings.sensitiveFilter) words.push(...BUILTIN_BLOCKED_WORDS);
  const text = comparable(content);
  return words.some((word) => text.includes(word));
}

export function createCommentFeed(seriesId: string, episodeId: string) {
  return {
    seriesId: String(seriesId), episodeId: String(episodeId), comments: [] as { id: string; content: string }[],
    seen: new Set<string>(), cursors: new Set<string>(), cursor: null as string | null,
    hasMore: true, emptyPages: 0, pages: 0, loading: false, loaded: false, error: '', notice: '', lastRequest: 0,
    sourceLimited: false,
    animation: { items: [] as ActiveItem[], cursor: 0, nextId: 0, cooldown: 0 },
  };
}
export type CommentFeed = ReturnType<typeof createCommentFeed>;

export function appendCommentPage(feed: CommentFeed, data: any, settings: DanmakuSettings) {
  if (!data?.success || String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.episodeId || !Array.isArray(data.items)) {
    throw new Error('Invalid episode comment page');
  }
  let accepted = 0;
  for (const item of data.items) {
    if (typeof item?.content !== 'string') continue;
    const content = cleanText(item.content);
    if (!content) continue;
    const id = item.id == null || item.id === '' ? `text:${content}` : `id:${item.id}`;
    if (feed.seen.has(id)) continue;
    feed.seen.add(id);
    feed.comments.push({ id, content });
    if (!commentIsBlocked(content, settings)) accepted++;
  }
  feed.loaded = true;
  feed.sourceLimited = data.source_limited === true;
  if (feed.sourceLimited) feed.notice = typeof data.notice === 'string' && data.notice ? data.notice : '公开网页仅提供部分评论，暂无可用后续页';
  feed.pages++;
  feed.emptyPages = accepted ? 0 : feed.emptyPages + 1;
  const next = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
  feed.hasMore = data.has_more === true && next !== null && next !== feed.cursor && !feed.cursors.has(next);
  if (data.has_more === true && !feed.hasMore) feed.notice = '评论游标未前进，已停止加载';
  if (feed.hasMore) { feed.cursor = next; feed.cursors.add(next); }
  if (feed.hasMore && feed.emptyPages >= 5) feed.error = '连续多页没有可显示的新评论，可继续加载';
  if (feed.pages >= 500) { feed.hasMore = false; feed.notice = '已达到本次评论加载上限'; }
}

export interface ActiveItem {
  id: number; text: string; content: string;
  entry?: DanmakuItem; color?: string; mode?: string;
  lane: number; x: number; y: number; width: number; age: number;
}
export interface AnimationState {
  items: ActiveItem[]; cursor: number; nextId: number; cooldown: number; lastTime?: number;
  replayQueue?: { entry?: DanmakuItem; content: string }[];
}

export interface LayoutContext {
  width: number; height: number; settings: DanmakuSettings;
  reducedMotion: boolean; bottomInset?: number;
  emitting?: boolean;
}

export function danmakuLayout({ height, settings, reducedMotion, bottomInset = 76 }: LayoutContext) {
  const top = 12;
  const lineHeight = settings.fontSize + 12;
  const bottom = Math.min(height - bottomInset, height * ({ quarter: 0.25, half: 0.5, full: 1 }[settings.area] ?? 0.5));
  return { top, lineHeight, lanes: reducedMotion ? 1 : Math.max(1, Math.floor((bottom - top) / lineHeight)) };
}

export function resizeDanmaku(state: AnimationState, before: { width: number; lanes: number }, after: LayoutContext) {
  if (after.width < 40 || after.height < 60) return false;
  const { top, lineHeight, lanes } = danmakuLayout(after);
  const placed: ActiveItem[] = [];
  for (const item of state.items) {
    const x = after.reducedMotion ? 12 : after.width - (before.width - item.x) / (before.width + item.width) * (after.width + item.width);
    const lane = Array.from({ length: lanes }, (_, offset) => (item.lane + offset) % lanes).find((index) =>
      !placed.some((other) => other.lane === index && x < other.x + other.width + 24 && x + item.width + 24 > other.x));
    if (lane === undefined) continue; // 缩小后放不下的条目才移除，保留时间光标与可见弹幕。
    Object.assign(item, { x, lane, y: top + lane * lineHeight });
    placed.push(item);
  }
  state.items = placed;
  return true;
}

// Only fully departed comments enter the replay queue; active comments are never cloned.
export function retireDanmaku(state: AnimationState, reducedMotion: boolean) {
  state.replayQueue ??= [];
  state.items = state.items.filter((item) => {
    if (reducedMotion ? item.age < 6 : item.x + item.width > 0) return true;
    if (!reducedMotion && !state.replayQueue!.some((old) => old.content === item.content)) state.replayQueue!.push({ entry: item.entry, content: item.content });
    return false;
  });
}

export function takeDanmakuReplay(state: AnimationState, options: LayoutContext, pending = 0, currentTime = Infinity) {
  const { settings, reducedMotion } = options;
  if (reducedMotion) return undefined;
  const { lanes } = danmakuLayout(options);
  const target = { sparse: 1, normal: 3, dense: Math.max(6, lanes * 2) }[settings.density];
  if (state.items.length + pending >= target) return undefined;
  const index = state.replayQueue?.findIndex((item) =>
    (!item.entry || item.entry.time <= currentTime) && !commentIsBlocked(item.content, settings) &&
    !state.items.some((active) => active.content === item.content));
  return index !== undefined && index >= 0 ? state.replayQueue!.splice(index, 1)[0] : undefined;
}

// One comment per lane prevents long comments catching shorter ones; all lanes share one clock.
export function advanceDanmaku(state: AnimationState, comments: { content: string }[], elapsed: number, options: LayoutContext) {
  const { width, height } = options;
  if (!(elapsed > 0) || !comments.length || width < 40 || height < 60) return false;
  const delta = Math.min(elapsed, 0.25);
  const { lineHeight, top, lanes } = danmakuLayout(options);
  const before = state.items.length;
  for (const item of state.items) { item.age += delta; if (!options.reducedMotion) item.x -= 85 * options.settings.speed * delta; }
  retireDanmaku(state, options.reducedMotion);
  let changed = before !== state.items.length;
  state.cooldown = Math.max(0, state.cooldown - delta);
  const lane = Array.from({ length: lanes }, (_, index) => index).find((index) =>
    !state.items.some((item) => item.lane === index || Math.abs(item.y - (top + index * lineHeight)) < lineHeight));
  if (state.cooldown === 0 && lane !== undefined) {
    let content = '';
    while (state.cursor < comments.length) {
      const comment = comments[state.cursor++];
      const full = typeof comment === 'string' ? comment : comment.content;
      if (!commentIsBlocked(full, options.settings)) { content = full; break; }
    }
    if (!content) content = takeDanmakuReplay(state, options)?.content ?? '';
    if (!content) return changed;
    const chars = Array.from(content);
    const text = chars.length > 80 ? chars.slice(0, 79).join('') + '…' : content;
    const textWidth = (Array.from(text).length + 1) * options.settings.fontSize;
    const x = options.reducedMotion ? 12 : state.nextId === 0 ? Math.max(12, width - textWidth - 12) : width;
    state.items.push({ id: state.nextId++, text, content, lane, x, y: top + lane * lineHeight, width: textWidth, age: 0 });
    state.cooldown = options.reducedMotion ? 6 : { sparse: 0.9, normal: 0.5, dense: 0.25 }[options.settings.density];
    changed = true;
  }
  return changed;
}

// 播放器页（我的剧库 + 播放舞台）。行为对齐桌面端 Player.jsx：
// 断点续播、连播、预缓存下一集、清晰度切换保留进度、错误重连、自动隐藏控件、
// 快捷键、画面模式按剧记忆。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type EpisodeSummary, type PlaybackRecord, type SeriesDetail } from '../api';
import { formatTime } from './PlayerControls';
import { PlayerControls, type PlayQuality } from './PlayerControls';
import { DanmakuLayer } from '../danmaku/DanmakuLayer';
import { useDanmakuSettings } from '../danmaku/store';
import { Icon } from './icons';
import {
  ignoresPlaybackShortcut, readShortcuts, subscribeShortcuts, shortcutKey, type ShortcutActionId,
} from '../shortcuts';

const QUALITY_KEY = 'hongguo:online-quality';
const AUTO_NEXT_KEY = 'hongguo:auto-next';
const pictureModeKey = (sid: string) => `hongguo:picture-mode:${sid}`;
/** 本集剩余多少秒时开始预取下一集。 */
const PREFETCH_LEAD_SECONDS = 20;

/** 本集之后最近的可播集（跳过锁定集）；没有则返回 undefined，表示本季已播完。 */
function nextPlayableEpisode(episodes: EpisodeSummary[], from: number): EpisodeSummary | undefined {
  return episodes
    .filter((ep) => ep.vid_index > from && !ep.locked)
    .sort((a, b) => a.vid_index - b.vid_index)[0];
}

/** 从剧名解析季数（第 2 季 / 第二季 / 第十二季）；无法解析时返回 null。 */
function parseSeasonNumber(title: string): number | null {
  const match = String(title).match(/第\s*([0-9零一二三四五六七八九十]+)\s*[季部]/);
  if (!match) return null;
  const raw = match[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (raw.includes('十')) {
    const [tensText, onesText] = raw.split('十');
    const tens = tensText ? digits[tensText] ?? 0 : 1;
    const ones = onesText ? digits[onesText] ?? 0 : 0;
    return tens * 10 + ones;
  }
  return digits[raw] ?? null;
}

export function readQuality(): PlayQuality {
  try {
    const value = JSON.parse(window.localStorage.getItem(QUALITY_KEY) || '');
    if (['auto', '720p', '1080p'].includes(value)) return value;
  } catch { /* fallthrough */ }
  return 'auto';
}

export interface PlayerNavigation {
  seriesId: string;
  vidIndex?: number;
  resume?: boolean;
}

interface PlayerProps {
  /** 播放页是否处于前台；切走时自动暂停（不自动恢复），并停用快捷键。 */
  active?: boolean;
  navigation: PlayerNavigation | null;
  onNavigateHandled(): void;
  onOpenBrowse(): void;
}

interface LibraryItem {
  series_id: string; series_title: string; cover: string; total: number;
  updatedAt: number; resume: PlaybackRecord | null;
}

/** 已就绪的下一集预取流：切集时直接复用，省去再次取源/解密。 */
interface PrefetchedStream {
  url: string; streamId: string; requestId: string;
  quality: PlayQuality; seriesId: string; vidIndex: number;
}

export function Player({ active = true, navigation, onNavigateHandled, onOpenBrowse }: PlayerProps) {
  // ── 剧库视图 ─────────────────────────────────────────────────────
  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [libraryError, setLibraryError] = useState('');

  const loadLibrary = useCallback(async () => {
    try {
      const data = await api.seriesList();
      setLibrary(data.results ?? []);
      setLibraryError('');
    } catch (error: any) {
      setLibraryError(error.message || '剧库加载失败');
    }
  }, []);
  useEffect(() => { if (!navigation) void loadLibrary(); }, [navigation, loadLibrary]);

  // ── 播放状态 ─────────────────────────────────────────────────────
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [videoSrc, setVideoSrc] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [preparePhase, setPreparePhase] = useState('');
  const [preparePercent, setPreparePercent] = useState(0);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [autoNext, setAutoNext] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(AUTO_NEXT_KEY) || 'true') !== false; } catch { return true; }
  });
  const [quality, setQuality] = useState<PlayQuality>(readQuality);
  const [pictureMode, setPictureModeState] = useState<'fit' | 'width'>('fit');
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(readShortcuts);

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const detailRef = useRef<SeriesDetail | null>(null);
  detailRef.current = detail;
  const currentStreamRef = useRef<{ streamId?: string; requestId?: string }>({});
  const prefetchRef = useRef(new Map<string, PrefetchedStream>());
  const prefetchingRef = useRef(new Set<string>());
  const prefetchSeasonRef = useRef('');
  const reconnectRef = useRef('');
  const pendingSeekRef = useRef<number | null>(null);
  const saveTimerRef = useRef(0);
  const resumeRef = useRef<{ time: number; label: string } | null>(null);
  const danmakuSettings = useDanmakuSettings();

  // ── 触摸手势（移动端） ───────────────────────────────────────────
  const [touchMode, setTouchMode] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  const speedRef = useRef(1);
  speedRef.current = speed;
  const brightnessRef = useRef(1);
  const tapTimerRef = useRef(0);
  const overlayTimerRef = useRef(0);
  /** 鼠标单击画面切播放/暂停；双击仍是全屏，故单击动作延迟判定。 */
  const clickTimerRef = useRef(0);
  const mousePressedRef = useRef(false);
  const [gestureOverlay, setGestureOverlay] = useState<null | {
    kind: 'seek' | 'brightness' | 'volume' | 'speed' | 'tapseek';
    delta?: number; target?: number; value?: number; text?: string;
  }>(null);
  interface GestureState {
    pointerId: number; startX: number; startY: number; startTime: number;
    side: 'left' | 'right' | 'center';
    mode: 'none' | 'seek' | 'brightness' | 'volume';
    startVideoTime: number; seekTarget: number | null;
    startValue: number; longPressTimer: number; pressed2x: boolean;
  }
  const gestureRef = useRef<GestureState | null>(null);

  const resetGesture = useCallback(() => {
    const g = gestureRef.current;
    if (g) window.clearTimeout(g.longPressTimer);
    gestureRef.current = null;
    setGestureOverlay(null);
  }, []);

  // 换片源时清理手势状态
  useEffect(() => { setGestureOverlay(null); gestureRef.current = null; }, [videoSrc]);
  const [danmakuEnabled, setDanmakuEnabled] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('hongguo:danmaku-enabled') || 'true') !== false; } catch { return true; }
  });

  useEffect(() => subscribeShortcuts(() => setShortcuts(readShortcuts())), []);
  useEffect(() => { window.localStorage.setItem('hongguo:danmaku-enabled', JSON.stringify(danmakuEnabled)); }, [danmakuEnabled]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((current) => (current === text ? '' : current)), 2600);
  }, []);

  // ── 进度保存（节流 5 秒 + 关键时机强制保存） ────────────────────
  const persistPosition = useCallback((options: { ended?: boolean; force?: boolean } = {}) => {
    const current = detailRef.current;
    const video = videoRef.current;
    if (!current || !video || !video.duration || Number.isNaN(video.currentTime)) return;
    if (options.ended !== true && video.currentTime < 1) return;
    const now = Date.now();
    if (!options.force && now - saveTimerRef.current < 5000) return;
    saveTimerRef.current = now;
    void api.savePosition({
      seriesId: current.series_id,
      vidIndex: currentIndexRef.current,
      currentTime: options.ended ? video.duration : video.currentTime,
      duration: video.duration,
      ended: options.ended === true,
    }).catch(() => {});
  }, []);

  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const activeRef = useRef(active);
  activeRef.current = active;
  const autoNextRef = useRef(autoNext);
  autoNextRef.current = autoNext;
  const qualityRef = useRef(quality);
  qualityRef.current = quality;

  // ── 在线播放 ─────────────────────────────────────────────────────
  const releaseCurrent = useCallback(() => {
    const { streamId, requestId } = currentStreamRef.current;
    if (streamId || requestId) void api.playRelease({ streamId, requestId }).catch(() => {});
    currentStreamRef.current = {};
  }, []);

  // ── 下一集预取（最后 20 秒触发；跨季时预取下一季第 1 集） ──────────
  /** 释放未使用的预取会话；keepSeriesId 用于换季接力时保留即将播放的那一份。 */
  const releasePrefetched = useCallback((keepSeriesId?: string) => {
    for (const [vid, item] of [...prefetchRef.current]) {
      if (keepSeriesId && item.seriesId === keepSeriesId) continue;
      prefetchRef.current.delete(vid);
      void api.playRelease({ streamId: item.streamId }).catch(() => {});
    }
  }, []);

  const prefetchEpisode = useCallback((target: { vid: string; seriesId: string; vidIndex: number }) => {
    if (!target.vid || prefetchRef.current.has(target.vid) || prefetchingRef.current.has(target.vid)) return;
    prefetchingRef.current.add(target.vid);
    const requestId = crypto.randomUUID();
    void api.playPrepare({
      vid: target.vid, seriesId: target.seriesId, vidIndex: target.vidIndex,
      quality, requestId, prefetch: true,
    }).then((result) => {
      if (!result.success || !result.url || !result.streamId) return;
      if (quality !== qualityRef.current) {
        // 清晰度已切换：这份预取作废
        void api.playRelease({ streamId: result.streamId }).catch(() => {});
        return;
      }
      const current = detailRef.current;
      if (current && current.series_id === target.seriesId && currentIndexRef.current === target.vidIndex) {
        // 已经切到该集：当前播放走的是另一次取源，这份预取直接释放
        void api.playRelease({ streamId: result.streamId }).catch(() => {});
        return;
      }
      // 只保留一份待用预取：替换时释放旧会话，避免后台流堆积
      releasePrefetched();
      prefetchRef.current.set(target.vid, {
        url: result.url, streamId: result.streamId, requestId,
        quality, seriesId: target.seriesId, vidIndex: target.vidIndex,
      });
    }).catch(() => {}).finally(() => { prefetchingRef.current.delete(target.vid); });
  }, [quality, releasePrefetched]);

  const startOnlinePlay = useCallback(async (index: number, seekTo?: number, force = false) => {
    const current = detailRef.current;
    if (!current) return;
    const episode = current.episodes.find((ep) => ep.vid_index === index);
    if (!episode) return;
    if (episode.locked) { showToast('该集为付费锁定集，网页端不提供播放'); return; }
    setError('');
    // 命中预取：直接接上已就绪的流，切集无需再等取源/解密
    const prefetched = force ? undefined : prefetchRef.current.get(episode.vid);
    if (prefetched && prefetched.quality === quality) {
      prefetchRef.current.delete(episode.vid);
      releasePrefetched();
      releaseCurrent();
      currentStreamRef.current = { streamId: prefetched.streamId, requestId: prefetched.requestId };
      pendingSeekRef.current = seekTo ?? null;
      setPreparing(false);
      setPreparePhase('');
      setPreparePercent(0);
      setVideoSrc(prefetched.url);
      return;
    }
    releasePrefetched(); // 换了目标集：旧预取作废
    setPreparing(true);
    setPreparePhase('');
    setPreparePercent(0);
    const requestId = crypto.randomUUID();
    releaseCurrent();
    currentStreamRef.current = { requestId };
    const poll = window.setInterval(() => {
      void api.playProgress(requestId).then((progress) => {
        if (currentStreamRef.current.requestId !== requestId) return;
        setPreparePhase(progress.phase);
        setPreparePercent(progress.percent);
      }).catch(() => {});
    }, 700);
    try {
      const result = await api.playPrepare({
        vid: episode.vid, seriesId: current.series_id, vidIndex: index,
        quality, requestId, force,
      });
      if (!result.success || !result.url) throw new Error(result.error || '取源失败');
      if (currentStreamRef.current.requestId !== requestId) return;
      currentStreamRef.current = { streamId: result.streamId, requestId };
      pendingSeekRef.current = seekTo ?? null;
      setVideoSrc(result.url);
    } catch (err: any) {
      if (currentStreamRef.current.requestId !== requestId) return;
      releaseCurrent();
      setVideoSrc('');
      setError(err?.message || '取源失败，请稍后重试');
    } finally {
      window.clearInterval(poll);
      if (currentStreamRef.current.requestId === requestId) setPreparing(false);
    }
  }, [quality, releaseCurrent, releasePrefetched, showToast]);

  // ── 打开剧集 ─────────────────────────────────────────────────────
  const loadSeriesDetail = useCallback(async (seriesId: string, register = true) => {
    const data = await api.seriesEpisodes(seriesId);
    if (data.success && data.data) return data.data;
    // 预取下一季时 register=false：不把还没看的剧提前塞进「我的剧库」
    if (!register) throw new Error(data.error || '读取分集失败');
    // 未建档的剧集（联想「直接播放」、前进/后退或刷新恢复的播放地址）：先建档再读分集
    const registered = await api.registerSeries(seriesId);
    if (registered.success && registered.data) return registered.data;
    throw new Error(registered.error || data.error || '读取分集失败');
  }, []);

  /** 切换到一部剧的指定集（换季接力也走这里，避免重复拉分集）。 */
  const applySeries = useCallback((next: SeriesDetail, index: number, resumeTime?: number) => {
    detailRef.current = next; // startOnlinePlay 读取该 ref；setDetail 要到下次渲染才生效
    setDetail(next);
    setVideoSrc('');
    setError('');
    setCurrentTime(0);
    setDuration(0);
    reconnectRef.current = '';
    releasePrefetched(next.series_id); // 保留本剧的预取（换季时正是下一季第 1 集）
    resumeRef.current = resumeTime != null ? { time: resumeTime, label: formatTime(resumeTime) } : null;
    // 画面模式按剧记忆
    try { setPictureModeState(JSON.parse(window.localStorage.getItem(pictureModeKey(next.series_id)) || '"fit"')); } catch { setPictureModeState('fit'); }
    setCurrentIndex(index);
    void startOnlinePlayRef.current?.(index, resumeTime);
  }, [releasePrefetched]);

  const openSeries = useCallback(async (seriesId: string, vidIndex?: number, resume = false) => {
    try {
      const next = await loadSeriesDetail(seriesId);
      let index = 1;
      let resumeTime: number | undefined;
      if (resume && next.resume && next.resume.vid_index > 0) {
        index = next.resume.vid_index;
        resumeTime = next.resume.currentTime;
      } else if (vidIndex && vidIndex > 0) {
        index = vidIndex;
      }
      applySeries(next, index, resumeTime);
    } catch (err: any) {
      setError(err?.message || '读取分集失败');
      setDetail(null);
    }
  }, [applySeries, loadSeriesDetail]);

  const startOnlinePlayRef = useRef(startOnlinePlay);
  startOnlinePlayRef.current = startOnlinePlay;

  // ── 换季接力：从相关作品里挑「季数更大的最近一季」 ────────────────
  const nextSeasonRef = useRef(new Map<string, { seriesId: string; title: string } | null>());

  const resolveNextSeason = useCallback(async (current: SeriesDetail) => {
    if (nextSeasonRef.current.has(current.series_id)) return nextSeasonRef.current.get(current.series_id) ?? null;
    let resolved: { seriesId: string; title: string } | null = null;
    try {
      const data = await api.related(current.series_id);
      const currentSeason = parseSeasonNumber(current.series_title);
      const next = (data.related ?? [])
        .filter((item) => item.series_id !== current.series_id && typeof item.season === 'number' && item.season > 0)
        .filter((item) => currentSeason == null || (item.season as number) > currentSeason)
        .sort((a, b) => (a.season as number) - (b.season as number))[0];
      if (next) resolved = { seriesId: next.series_id, title: next.series_title };
    } catch {
      return null; // 拉取失败不缓存，下次播完还能再试
    }
    nextSeasonRef.current.set(current.series_id, resolved);
    return resolved;
  }, []);

  /** 本季最后一集的最后 20 秒：提前把下一季第 1 集预取好。 */
  const prefetchNextSeason = useCallback(async (current: SeriesDetail) => {
    const key = `${current.series_id}:${currentIndexRef.current}`;
    if (prefetchSeasonRef.current === key) return; // 每集只解析一次
    prefetchSeasonRef.current = key;
    const target = await resolveNextSeason(current);
    if (!target) return;
    try {
      const nextDetail = await loadSeriesDetail(target.seriesId, false);
      const first = nextDetail.episodes.find((ep) => !ep.locked);
      if (first) prefetchEpisode({ vid: first.vid, seriesId: target.seriesId, vidIndex: first.vid_index });
    } catch { /* 预取失败不影响当前播放 */ }
  }, [loadSeriesDetail, prefetchEpisode, resolveNextSeason]);

  // 处理来自其它页面的播放导航（play-series 等价物）
  useEffect(() => {
    if (!navigation) return;
    void openSeries(navigation.seriesId, navigation.vidIndex, navigation.resume !== false);
    onNavigateHandled();
  }, [navigation, openSeries, onNavigateHandled]);

  useEffect(() => {
    if (!detail) return () => {};
    const handler = () => persistPosition({ force: true });
    window.addEventListener('beforeunload', handler);
    // 移动端没有可靠的 beforeunload：pagehide 与切后台时兜底保存
    window.addEventListener('pagehide', handler);
    const onVisibility = () => { if (document.hidden) handler(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
      document.removeEventListener('visibilitychange', onVisibility);
      persistPosition({ force: true });
      releaseCurrent();
      releasePrefetched();
    };
  }, [detail?.series_id, persistPosition, releaseCurrent, releasePrefetched]);

  // ── 切集 ─────────────────────────────────────────────────────────
  const findEpisode = useCallback((index: number) => detailRef.current?.episodes.find((ep) => ep.vid_index === index), []);

  const goToEpisode = useCallback((index: number, options: { skipLocked?: boolean } = {}) => {
    const current = detailRef.current;
    if (!current) return;
    let target = index;
    const { episodes } = current;
    if (options.skipLocked !== false) {
      // 跳过锁定集（与桌面端 findNext/findPrev 一致）
      const forward = index > currentIndexRef.current;
      while (target >= 1 && target <= episodes.length) {
        const ep = episodes.find((item) => item.vid_index === target);
        if (ep && !ep.locked) break;
        target += forward ? 1 : -1;
      }
    }
    if (!findEpisode(target) || target < 1 || target > episodes.length) return;
    persistPosition({ force: true });
    setCurrentIndex(target);
    setCurrentTime(0);
    reconnectRef.current = '';
    resumeRef.current = null; // 切集不再沿用开剧时的续播点
    void startOnlinePlay(target);
  }, [findEpisode, persistPosition, startOnlinePlay]);

  // ── 事件处理 ─────────────────────────────────────────────────────
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (resumeRef.current && pendingSeekRef.current == null) pendingSeekRef.current = resumeRef.current.time;
    if (pendingSeekRef.current != null && Number.isFinite(video.duration)) {
      const target = Math.min(pendingSeekRef.current, Math.max(0, video.duration - 0.5));
      video.currentTime = target;
      pendingSeekRef.current = null;
      resumeRef.current = null; // 续播点只生效一次
    }
    video.playbackRate = speed;
    // 播放页不在前台时不自动开播：离开后片源才就绪也不会在后台响起
    if (activeRef.current) void video.play().catch(() => {});
  }, [speed]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (video.buffered.length) setBuffered(video.buffered.end(video.buffered.length - 1));
    persistPosition();
    // 最后 20 秒预取下一集；本季最后一集则提前解析并预取下一季第 1 集
    const current = detailRef.current;
    if (!current || !autoNextRef.current) return;
    const total = video.duration;
    if (!Number.isFinite(total) || total <= 0) return;
    const remaining = total - video.currentTime;
    if (remaining > PREFETCH_LEAD_SECONDS || remaining <= 0) return;
    const next = nextPlayableEpisode(current.episodes, currentIndexRef.current);
    if (next) {
      prefetchEpisode({ vid: next.vid, seriesId: current.series_id, vidIndex: next.vid_index });
      return;
    }
    void prefetchNextSeason(current);
  }, [persistPosition, prefetchEpisode, prefetchNextSeason]);

  const handleError = useCallback(() => {
    const current = detailRef.current;
    const video = videoRef.current;
    if (!current || !video?.src) return;
    // 每集允许一次强制重连（对齐桌面端 reconnectOnce）
    if (reconnectRef.current !== `${current.series_id}:${currentIndexRef.current}`) {
      reconnectRef.current = `${current.series_id}:${currentIndexRef.current}`;
      showToast('片源连接中断，正在重新取源…');
      void startOnlinePlay(currentIndexRef.current, video.currentTime, true);
      return;
    }
    setError('播放失败：片源不可用或解码失败。可尝试切换清晰度后重试。');
    setVideoSrc('');
  }, [showToast, startOnlinePlay]);

  const handleEnded = useCallback(() => {
    persistPosition({ ended: true, force: true });
    const current = detailRef.current;
    if (!current || !autoNext) return;
    // 本季还有可播的下一集：直接连播（goToEpisode 会继续跳过锁定集）
    if (nextPlayableEpisode(current.episodes, currentIndexRef.current)) {
      goToEpisode(currentIndexRef.current + 1);
      return;
    }
    // 本季播完：接入相关作品里「季数更大的最近一季」第 1 集（服务端顺序不可信）
    void (async () => {
      const target = await resolveNextSeason(current);
      if (!target) return;
      try {
        const nextDetail = await loadSeriesDetail(target.seriesId);
        const first = nextDetail.episodes.find((ep) => !ep.locked);
        if (!first) return;
        showToast(`本季完结，自动接入《${target.title}》`);
        applySeries(nextDetail, first.vid_index);
      } catch { /* 接力失败静默，保持剧终画面 */ }
    })();
  }, [autoNext, applySeries, goToEpisode, loadSeriesDetail, persistPosition, resolveNextSeason, showToast]);

  const changeQuality = useCallback((next: PlayQuality) => {
    setQuality(next);
    window.localStorage.setItem(QUALITY_KEY, JSON.stringify(next));
    const video = videoRef.current;
    releasePrefetched(); // 旧清晰度的预取作废
    // 切换清晰度保留进度（对齐桌面端 startOnlinePlay(seekTo, force)）
    void startOnlinePlay(currentIndexRef.current, video?.currentTime || undefined, true);
  }, [releasePrefetched, startOnlinePlay]);

  const changeSpeed = useCallback((next: number) => {
    const bounded = Math.max(0.25, Math.min(4, next));
    setSpeedState(bounded);
    const video = videoRef.current;
    if (video) {
      video.playbackRate = bounded;
      video.defaultPlaybackRate = bounded;
    }
  }, []);

  const changePictureMode = useCallback((mode: 'fit' | 'width') => {
    setPictureModeState(mode);
    const current = detailRef.current;
    if (current) window.localStorage.setItem(pictureModeKey(current.series_id), JSON.stringify(mode));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void stage.requestFullscreen().catch(() => showToast('浏览器拒绝了全屏请求'));
  }, [showToast]);

  useEffect(() => {
    const handler = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── 控件自动隐藏（1 秒空闲；screenX/Y 判定真实位移 — 桌面端 3.0 修复） ──
  const idleTimerRef = useRef(0);
  const lastPointerRef = useRef({ x: -1, y: -1 });
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      if (playingRef.current && !menuOpenRef.current) setControlsVisible(false);
    }, 1000);
  }, []);
  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
    revealControls();
  }, [revealControls]);

  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;
  useEffect(() => { if (menuOpen) { setControlsVisible(true); window.clearTimeout(idleTimerRef.current); } }, [menuOpen]);
  useEffect(() => { if (!playing) setControlsVisible(true); }, [playing]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch') return; // 触屏由点按/手势接管，不跟随移动显示
    const { screenX, screenY } = event;
    // 鼠标回入原位置也视为移动（screenX/Y 判定）
    if (screenX === lastPointerRef.current.x && screenY === lastPointerRef.current.y) return;
    lastPointerRef.current = { x: screenX, y: screenY };
    revealControls();
  }, [revealControls]);

  const handlePointerLeave = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'touch') return; // 触屏没有“移出”，交给空闲计时
    mousePressedRef.current = false; // 移出后再松手不算点击
    if (playingRef.current && !menuOpenRef.current) setControlsVisible(false);
  }, []);

  // ── 触摸手势：点按切控件、双击 ±10s、横滑快进退、左半屏亮度/右半屏音量、长按 2x ──
  const handleStagePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') { mousePressedRef.current = true; return; }
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage || !videoSrc) return;
    setTouchMode(true);
    const rect = stage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, startTime: Date.now(),
      side: x < rect.width / 3 ? 'left' : x > (rect.width * 2) / 3 ? 'right' : 'center',
      mode: 'none',
      startVideoTime: video.currentTime, seekTarget: null,
      startValue: 0, pressed2x: false,
      longPressTimer: window.setTimeout(() => {
        const g = gestureRef.current;
        if (!g || g.mode !== 'none' || !videoRef.current) return;
        g.pressed2x = true;
        videoRef.current.playbackRate = 2;
        setGestureOverlay({ kind: 'speed', text: '2 倍速快进中，松手恢复' });
      }, 500),
    };
  }, [videoSrc]);

  const handleStagePointerMove = useCallback((event: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g || event.pointerId !== g.pointerId) return;
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (g.mode === 'none') {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        g.mode = 'seek';
      } else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        g.mode = g.side === 'left' ? 'brightness' : 'volume';
        g.startValue = g.mode === 'brightness' ? brightnessRef.current : video.volume;
      } else {
        return;
      }
      window.clearTimeout(g.longPressTimer);
      if (g.pressed2x) {
        g.pressed2x = false;
        video.playbackRate = speedRef.current;
        setGestureOverlay(null);
      }
    }
    const rect = stage.getBoundingClientRect();
    if (g.mode === 'seek') {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (!duration) return;
      const target = Math.max(0, Math.min(duration, g.startVideoTime + (dx / rect.width) * duration));
      g.seekTarget = target;
      setGestureOverlay({ kind: 'seek', delta: target - g.startVideoTime, target });
    } else if (g.mode === 'brightness') {
      const value = Math.max(0.25, Math.min(2, g.startValue + (-dy / rect.height) * 1.5));
      brightnessRef.current = value;
      video.style.filter = `brightness(${value.toFixed(2)})`;
      setGestureOverlay({ kind: 'brightness', value: value / 2 });
    } else if (g.mode === 'volume') {
      const value = Math.max(0, Math.min(1, g.startValue + (-dy / rect.height) * 1.2));
      video.volume = value;
      video.muted = value === 0;
      setGestureOverlay({ kind: 'volume', value });
    }
  }, []);

  const handleStagePointerUp = useCallback((event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') {
      const pressed = mousePressedRef.current;
      mousePressedRef.current = false;
      if (!pressed || event.button !== 0 || !videoRef.current) return;
      const target = event.target as HTMLElement | null;
      // 控件栏、弹层、按钮上的点击不切换播放
      if (target?.closest('.player-controls, .player-popover, button, input')) return;
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = 0;
        return; // 连击：交给 onDoubleClick 切全屏
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = 0;
        togglePlayPause();
      }, 250);
      return;
    }
    const g = gestureRef.current;
    if (!g || event.pointerId !== g.pointerId) return;
    if (event.pointerType === 'touch') event.preventDefault(); // 抑制合成的 dblclick 等
    window.clearTimeout(g.longPressTimer);
    const video = videoRef.current;
    const moved = Math.hypot(event.clientX - g.startX, event.clientY - g.startY);
    const elapsed = Date.now() - g.startTime;
    gestureRef.current = null;

    if (video && g.pressed2x) {
      video.playbackRate = speedRef.current;
      setGestureOverlay(null);
      return;
    }
    if (g.mode === 'seek' && g.seekTarget != null && video) {
      video.currentTime = g.seekTarget;
      setGestureOverlay(null);
      return;
    }
    if (g.mode !== 'none') { setGestureOverlay(null); return; }

    // 点按 / 双击
    if (video && elapsed < 350 && moved < 12) {
      if (tapTimerRef.current) {
        window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = 0;
        if (g.side === 'left' || g.side === 'right') {
          const delta = g.side === 'left' ? -10 : 10;
          video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
          setGestureOverlay({ kind: 'tapseek', text: delta < 0 ? '快退 10 秒' : '快进 10 秒' });
          window.clearTimeout(overlayTimerRef.current);
          overlayTimerRef.current = window.setTimeout(() => setGestureOverlay(null), 650);
        } else {
          toggleFullscreen();
        }
      } else {
        tapTimerRef.current = window.setTimeout(() => {
          tapTimerRef.current = 0;
          setControlsVisible((prev) => !prev);
        }, 260);
      }
    }
  }, [toggleFullscreen, togglePlayPause]);

  const handleStagePointerCancel = useCallback(() => {
    mousePressedRef.current = false;
    const g = gestureRef.current;
    if (!g) return;
    const video = videoRef.current;
    if (video && g.pressed2x) video.playbackRate = speedRef.current;
    resetGesture();
  }, [resetGesture]);

  // ── 快捷键（capture 阶段，与桌面端一致：仅播放页在前台时响应） ──
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      const key = shortcutKey(event);
      if (!key) return;
      if (ignoresPlaybackShortcut(event.target, key)) return;
      const action = (Object.entries(shortcuts) as [ShortcutActionId, string][]).find(([, value]) => value === key)?.[0];
      if (!action) return;
      const video = videoRef.current;
      const shift = key.startsWith('shift+');
      const plain = key.replace('shift+', '');
      event.preventDefault();
      switch (action) {
        case 'play':
          if (video) { if (video.paused) void video.play().catch(() => {}); else video.pause(); }
          revealControls();
          break;
        case 'backward': if (video) video.currentTime = Math.max(0, video.currentTime - 5); break;
        case 'forward': if (video) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5); break;
        case 'previous': if (currentIndexRef.current > 1) goToEpisode(currentIndexRef.current - 1); break;
        case 'next': if (detailRef.current && currentIndexRef.current < detailRef.current.episodes.length) goToEpisode(currentIndexRef.current + 1); break;
        case 'autoNext': {
          setAutoNext((prev) => {
            window.localStorage.setItem(AUTO_NEXT_KEY, JSON.stringify(!prev));
            showToast(!prev ? '已开启连播' : '已关闭连播');
            return !prev;
          });
          break;
        }
        case 'slower': if (!shift || plain === 's') changeSpeed((video?.playbackRate ?? 1) - 0.25); break;
        case 'faster': if (!shift || plain === 'd') changeSpeed((video?.playbackRate ?? 1) + 0.25); break;
        case 'fullscreen': toggleFullscreen(); break;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [active, shortcuts, goToEpisode, changeSpeed, toggleFullscreen, revealControls, showToast]);

  // 离开播放页自动暂停（不自动恢复，回来手动点播放）；onPause 里会保存进度。
  // 依赖 videoSrc：离开时若还在取源，片源就绪挂载后同样要被暂停住。
  useEffect(() => {
    if (active) return;
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
  }, [active, videoSrc]);

  // ── 渲染 ─────────────────────────────────────────────────────────
  const episodes = detail?.episodes ?? [];
  const hasPrevious = currentIndex > 1;
  const hasNext = detail ? currentIndex < detail.episodes.length : false;
  const videoClassName = `player-video ${pictureMode === 'width' ? 'fill-width' : 'fit-window'}`;

  if (!detail) {
    return (
      <section className="page">
        <header className="page-header"><h1>我的剧库</h1></header>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        {library === null && !libraryError ? <p className="muted">正在加载剧库…</p> : null}
        {libraryError ? (
          <div className="empty-state">
            <p>{libraryError}</p>
            <button className="primary-btn" onClick={() => void loadLibrary()}>重试</button>
          </div>
        ) : null}
        {library && library.length === 0 ? (
          <div className="empty-state">
            <p>剧库还是空的。先去「发现短剧」或「搜索与解析」打开一部剧，这里就会出现完整分集。</p>
            <button className="primary-btn" onClick={onOpenBrowse}>去发现短剧</button>
          </div>
        ) : null}
        {library && library.length > 0 ? (
          <div className="card-grid">
            {library.map((item) => (
              <article key={item.series_id} className="card">
                <button className="poster-btn" onClick={() => void openSeries(item.series_id, undefined, true)}>
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="poster-placeholder" />}
                  <span className="card-title">{item.series_title}</span>
                  {item.resume ? (
                    <span className="resume-badge">看到 {item.resume.vid_index} 集</span>
                  ) : <span className="resume-badge">{item.total} 集</span>}
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="page player-page">
      <div className="player-layout">
        <div
          className={`player-stage${fullscreen ? ' fullscreen' : ''}`}
          ref={stageRef}
          onPointerDown={handleStagePointerDown}
          onPointerMove={(event) => { handlePointerMove(event); handleStagePointerMove(event); }}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handleStagePointerCancel}
          onPointerLeave={handlePointerLeave}
          onDoubleClick={toggleFullscreen}
        >
          {videoSrc ? (
            <video
              ref={videoRef}
              className={videoClassName}
              src={videoSrc}
              crossOrigin="anonymous"
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={() => { setPlaying(true); playingRef.current = true; revealControls(); }}
              onPause={() => { setPlaying(false); playingRef.current = false; setControlsVisible(true); persistPosition({ force: true }); }}
              onEnded={handleEnded}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={(event) => setDuration((event.target as HTMLVideoElement).duration || 0)}
              onError={handleError}
              onVolumeChange={(event) => {
                const video = event.target as HTMLVideoElement;
                setVolume(video.volume); setMuted(video.muted);
              }}
            />
          ) : (
            <div className="player-placeholder">
              {preparing ? <div className="prepare-spinner" aria-hidden="true" /> : null}
              {preparing
                ? (preparePhase === 'decrypting' ? '正在解密片源…' : preparePhase === 'downloading' ? `正在缓冲片源… ${preparePercent}%` : '正在连接片源…')
                : error ? error : '选择一集开始播放'}
              {error ? (
                <div className="error-actions">
                  <button className="primary-btn" onClick={() => void startOnlinePlay(currentIndex, undefined, true)}>重试</button>
                </div>
              ) : null}
            </div>
          )}
          {videoSrc ? <div className="player-error-overlay">{error}</div> : null}
          <DanmakuLayer
            seriesId={detail.series_id}
            vid={episodes.find((ep) => ep.vid_index === currentIndex)?.vid ?? ''}
            videoRef={videoRef}
            playing={playing}
            visible={danmakuEnabled && !!videoSrc}
            settings={danmakuSettings.settings}
            source={danmakuSettings.source}
            bottomInset={fullscreen ? 96 : 88}
          />
          {toast ? <div className="player-toast" role="status">{toast}</div> : null}
          {gestureOverlay ? (
            <div className={`gesture-overlay gesture-${gestureOverlay.kind}`} aria-hidden="true">
              {gestureOverlay.kind === 'seek' ? (
                <div className="gesture-seek-panel">
                  <span className="gesture-seek-dir">{(gestureOverlay.delta ?? 0) >= 0 ? '▶▶ 快进' : '◀◀ 快退'}</span>
                  <span className="gesture-seek-delta">{formatTime(Math.abs(gestureOverlay.delta ?? 0))}</span>
                  <span className="gesture-seek-target">目标 {formatTime(gestureOverlay.target ?? 0)}</span>
                </div>
              ) : gestureOverlay.kind === 'brightness' || gestureOverlay.kind === 'volume' ? (
                <div className="gesture-vertical">
                  <span className="gesture-vertical-icon">{gestureOverlay.kind === 'brightness' ? '☀' : '🔊'}</span>
                  <div className="gesture-bar"><div className="gesture-bar-fill" style={{ height: `${Math.round((gestureOverlay.value ?? 0) * 100)}%` }} /></div>
                  <span className="gesture-vertical-value">{Math.round((gestureOverlay.value ?? 0) * 100)}%</span>
                </div>
              ) : (
                <div className="gesture-pill">{gestureOverlay.text}</div>
              )}
            </div>
          ) : null}
          <PlayerControls
            visible={controlsVisible}
            touchMode={touchMode}
            seriesTitle={detail.series_title}
            currentIndex={currentIndex}
            episodes={episodes}
            playing={playing}
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            volume={volume}
            muted={muted}
            speed={speed}
            autoNext={autoNext}
            quality={quality}
            pictureMode={pictureMode}
            danmakuEnabled={danmakuEnabled}
            danmakuSource={danmakuSettings.source}
            danmakuSettings={danmakuSettings.settings}
            fullscreen={fullscreen}
            hasPrevious={hasPrevious}
            hasNext={hasNext}
            preparing={preparing}
            preparePhase={preparePhase}
            preparePercent={preparePercent}
            shortcuts={shortcuts}
            onMenuChange={setMenuOpen}
            onTogglePlay={() => {
              const video = videoRef.current;
              if (!video) return;
              if (video.paused) void video.play().catch(() => {}); else video.pause();
            }}
            onSeek={(time) => {
              const video = videoRef.current;
              if (video) video.currentTime = time;
              setCurrentTime(time);
            }}
            onSeekBy={(delta) => {
              const video = videoRef.current;
              if (video) video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
            }}
            onVolume={(nextVolume, nextMuted) => {
              const video = videoRef.current;
              if (!video) return;
              video.volume = nextVolume;
              video.muted = nextMuted;
            }}
            onSpeed={changeSpeed}
            onToggleAutoNext={() => {
              setAutoNext((prev) => {
                window.localStorage.setItem(AUTO_NEXT_KEY, JSON.stringify(!prev));
                return !prev;
              });
            }}
            onQuality={changeQuality}
            onPictureMode={changePictureMode}
            onEpisode={(index) => goToEpisode(index)}
            onFullscreen={toggleFullscreen}
            onDanmakuToggle={() => setDanmakuEnabled((prev) => !prev)}
            onDanmakuSource={danmakuSettings.setSource}
            onDanmakuSettings={danmakuSettings.setSettings}
          />
        </div>
        <aside className="player-side">
          <div className="player-side-header">
            <button className="link-btn" onClick={() => { setDetail(null); setVideoSrc(''); releaseCurrent(); }}>
              <Icon name="library" size={16} /> 返回剧库
            </button>
            <h2 title={detail.series_title}>{detail.series_title}</h2>
            <p className="muted">
              共 {detail.total} 集{detail.web_accessible_episodes != null ? ` · 官网开放 ${detail.web_accessible_episodes} 集` : ''}
            </p>
          </div>
          <div className="side-episode-list" role="listbox" aria-label="分集列表">
            {episodes.map((ep) => (
              <button
                key={ep.vid}
                role="option"
                aria-selected={ep.vid_index === currentIndex}
                className={`side-episode${ep.vid_index === currentIndex ? ' current' : ''}${ep.locked ? ' locked' : ''}`}
                onClick={() => goToEpisode(ep.vid_index)}
                disabled={ep.locked}
              >
                <span className="side-episode-index">{ep.vid_index}</span>
                <span className="side-episode-title">{ep.title || `第 ${ep.vid_index} 集`}</span>
                {ep.locked ? <span className="side-episode-flag">锁定</span>
                  : ep.web_available === false ? <span className="side-episode-flag">未开放</span> : null}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

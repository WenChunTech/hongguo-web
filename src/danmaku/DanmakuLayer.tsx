// 弹幕图层：官方时间轴弹幕 + 本集评论兜底，共用视觉设置与车道布局。
// 官方源一次拉全并按 currentTime 对齐发射（rAF）；评论源分页轮询依次滚动。
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DanmakuItem } from '../api';
import {
  advanceDanmaku, appendCommentPage, createCommentFeed, danmakuLayout, resizeDanmaku,
  type CommentFeed, type DanmakuSettings,
} from './model';
import { advanceTimedDanmaku, appendOfficialPage, createOfficialFeed, resolveDanmakuStatus, type DanmakuSource, type OfficialFeed } from './official';

interface DanmakuLayerProps {
  seriesId: string;
  vid: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playing: boolean;
  visible: boolean;
  settings: DanmakuSettings;
  source: DanmakuSource;
  bottomInset: number;
}

export function DanmakuLayer({ seriesId, vid, videoRef, playing, visible, settings, source, bottomInset }: DanmakuLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const officialRef = useRef<OfficialFeed | null>(null);
  const commentRef = useRef<CommentFeed | null>(null);
  const nodeRefs = useRef(new Map<number, HTMLSpanElement>());
  const [status, setStatus] = useState('');
  const [danmakuVersion, setDanmakuVersion] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const supported = /^\d{6,30}$/.test(String(seriesId)) && /^\d{6,30}$/.test(String(vid));

  // 官方弹幕：每集拉取一次（fresh=false 命中服务端 5 分钟缓存）
  useEffect(() => {
    officialRef.current = null;
    setDanmakuVersion((v) => v + 1);
    if (!supported || sourceRef.current !== 'official') return;
    const feed = createOfficialFeed(seriesId, vid);
    officialRef.current = feed;
    feed.loading = true;
    let cancelled = false;
    api.episodeDanmaku(seriesId, vid).then((data) => {
      if (cancelled || officialRef.current !== feed) return;
      feed.loading = false;
      try { appendOfficialPage(feed, data); } catch { feed.error = '弹幕数据无效'; }
      setDanmakuVersion((v) => v + 1);
    }).catch((error) => {
      if (cancelled || officialRef.current !== feed) return;
      feed.loading = false;
      feed.error = error?.message || '弹幕加载失败';
      setDanmakuVersion((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [seriesId, vid, supported, source]);

  // 评论兜底：分页轮询（缓冲少于 10 条时每 1.5s 拉一页）
  useEffect(() => {
    commentRef.current = null;
    setDanmakuVersion((v) => v + 1);
    if (!supported || sourceRef.current !== 'comments') return;
    const feed = createCommentFeed(seriesId, vid);
    commentRef.current = feed;
    let cancelled = false;
    const pull = async () => {
      if (cancelled || !feed.hasMore || feed.loading) return;
      feed.loading = true;
      try {
        const data = await api.episodeComments(feed.seriesId, feed.episodeId);
        if (!cancelled) appendCommentPage(feed, data, settingsRef.current);
      } catch (error: any) {
        if (!cancelled) feed.error = error?.message || '评论加载失败';
      } finally {
        feed.loading = false;
      }
    };
    const timer = setInterval(() => {
      if (playingRef.current && feed.animation.items.length < 10) void pull();
    }, 1500);
    void pull();
    return () => { cancelled = true; clearInterval(timer); };
  }, [seriesId, vid, supported, source]);

  // rAF 投放循环：直接改 DOM transform，避免 React 重渲染每帧弹幕
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastWidth = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const container = containerRef.current;
      const video = videoRef.current;
      if (!container) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      const now = performance.now();
      const wallElapsed = (now - last) / 1000;
      last = now;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const settingsNow = settingsRef.current;

      if (width !== lastWidth && lastWidth > 0) {
        // 窗口重排：按旧宽度比例重排所有在屏弹幕
        const before = { width: lastWidth, lanes: danmakuLayout({ width: lastWidth, height, settings: settingsNow, reducedMotion, bottomInset }).lanes };
        const state = sourceRef.current === 'official' ? officialRef.current?.animation : commentRef.current?.animation;
        if (state) resizeDanmaku(state, before, { width, height, settings: settingsNow, reducedMotion, bottomInset });
      }
      lastWidth = width;

      let changed = false;
      const videoTime = video?.currentTime ?? 0;
      if (sourceRef.current === 'official' && officialRef.current && video) {
        const feed = officialRef.current;
        // 媒体时间增量（已含倍速），暂停时不投放
        const mediaElapsed = playingRef.current && !video.paused ? wallElapsed * (video.playbackRate || 1) : 0;
        changed = advanceTimedDanmaku(feed.animation, feed.danmaku, videoTime, mediaElapsed,
          { width, height, settings: settingsNow, reducedMotion, bottomInset, emitting: playingRef.current });
      } else if (sourceRef.current === 'comments' && commentRef.current) {
        const feed = commentRef.current;
        const mediaElapsed = playingRef.current ? wallElapsed : 0;
        changed = advanceDanmaku(feed.animation, feed.comments, mediaElapsed,
          { width, height, settings: settingsNow, reducedMotion, bottomInset });
      }

      if (changed) {
        const state = sourceRef.current === 'official' ? officialRef.current?.animation : commentRef.current?.animation;
        if (state) {
          const alive = new Set<number>();
          for (const item of state.items) {
            alive.add(item.id);
            let node = nodeRefs.current.get(item.id);
            if (!node) {
              node = document.createElement('span');
              node.className = 'danmaku-item';
              node.textContent = item.text;
              if (item.color && item.color.toUpperCase() !== '#FFFFFF') node.style.color = item.color;
              if (item.mode === 'top') node.classList.add('danmaku-top');
              if (item.mode === 'bottom') node.classList.add('danmaku-bottom');
              node.style.fontSize = `${settingsNow.fontSize}px`;
              container.appendChild(node);
              nodeRefs.current.set(item.id, node);
            }
            node.style.transform = `translateX(${Math.round(item.x)}px)`;
            node.style.top = `${item.y}px`;
            node.style.opacity = String(settingsNow.opacity / 100);
          }
          for (const [id, node] of [...nodeRefs.current]) {
            if (!alive.has(id)) {
              node.remove();
              nodeRefs.current.delete(id);
            }
          }
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, bottomInset]);

  // 弹幕字体尺寸变化时同步在屏节点
  useEffect(() => {
    for (const node of nodeRefs.current.values()) {
      node.style.fontSize = `${settings.fontSize}px`;
      node.style.opacity = String(settings.opacity / 100);
    }
  }, [settings.fontSize, settings.opacity]);

  // 清理在屏节点（切集/切源/隐藏）
  useEffect(() => {
    for (const node of nodeRefs.current.values()) node.remove();
    nodeRefs.current.clear();
  }, [seriesId, vid, source, visible]);

  // 状态文案
  const stateVersion = danmakuVersion;
  useEffect(() => {
    const feedOfficial = officialRef.current;
    const feedComments = commentRef.current;
    const text = resolveDanmakuStatus({
      source,
      supported,
      enabled: true,
      active: !!vid,
      visible,
      error: source === 'official' ? feedOfficial?.error ?? '' : feedComments?.error ?? '',
      loading: source === 'official' ? !!feedOfficial?.loading : !!feedComments?.loading,
      notice: source === 'official' ? feedOfficial?.notice ?? '' : feedComments?.notice ?? '',
      loaded: source === 'official' ? !!feedOfficial?.loaded : !!feedComments?.loaded,
      // 「已载入 N 条」用已加载总数；在屏数量只反映当前画面
      count: source === 'official' ? feedOfficial?.danmaku.length ?? 0 : feedComments?.comments.length ?? 0,
    });
    setStatus(text);
  }, [stateVersion, source, supported, vid, visible]);

  const hidden = !visible || !playing && false;
  return (
    <div className={`danmaku-layer${hidden ? ' danmaku-hidden' : ''}`} ref={containerRef} aria-hidden="true">
      {status && visible ? <div className="danmaku-status">{status}</div> : null}
    </div>
  );
}

/** 弹幕设置面板（桌面端 DanmakuSettings 的移植）。 */
export function DanmakuSettingsPanel({ settings, source, onChange, onSourceChange, danmakuEnabled, onEnabledChange }: {
  settings: DanmakuSettings;
  source: DanmakuSource;
  onChange: (settings: DanmakuSettings) => void;
  onSourceChange: (source: DanmakuSource) => void;
  danmakuEnabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const blockedCount = useMemo(() => settings.blockedWords.split(/[\n,，;；]+/).filter(Boolean).length, [settings.blockedWords]);
  return (
    <div className="danmaku-settings" role="dialog" aria-label="弹幕设置" data-player-menu>
      <label className="field-row">
        <span>来源</span>
        <select value={source} onChange={(event) => onSourceChange(event.target.value as DanmakuSource)}>
          <option value="official">时间轴弹幕（官方）</option>
          <option value="comments">本集评论</option>
        </select>
      </label>
      <label className="field-row">
        <span className="checkbox-row">
          <input type="checkbox" checked={danmakuEnabled} onChange={(event) => onEnabledChange(event.target.checked)} />
          显示弹幕
        </span>
      </label>
      <label className="field-row">
        <span>不透明度 {settings.opacity}%</span>
        <input type="range" min={20} max={100} step={5} value={settings.opacity}
          onChange={(event) => onChange({ ...settings, opacity: Number(event.target.value) })} />
      </label>
      <label className="field-row">
        <span>字号 {settings.fontSize}px</span>
        <input type="range" min={16} max={32} step={1} value={settings.fontSize}
          onChange={(event) => onChange({ ...settings, fontSize: Number(event.target.value) })} />
      </label>
      <label className="field-row">
        <span>速度 {settings.speed.toFixed(1)}x</span>
        <input type="range" min={0.5} max={2} step={0.1} value={settings.speed}
          onChange={(event) => onChange({ ...settings, speed: Number(event.target.value) })} />
      </label>
      <label className="field-row">
        <span>显示区域</span>
        <select value={settings.area} onChange={(event) => onChange({ ...settings, area: event.target.value as DanmakuSettings['area'] })}>
          <option value="quarter">1/4 屏</option>
          <option value="half">1/2 屏</option>
          <option value="full">全屏</option>
        </select>
      </label>
      <label className="field-row">
        <span>密度</span>
        <select value={settings.density} onChange={(event) => onChange({ ...settings, density: event.target.value as DanmakuSettings['density'] })}>
          <option value="sparse">稀疏</option>
          <option value="normal">适中</option>
          <option value="dense">密集</option>
        </select>
      </label>
      <label className="field-row">
        <span className="checkbox-row">
          <input type="checkbox" checked={settings.sensitiveFilter}
            onChange={(event) => onChange({ ...settings, sensitiveFilter: event.target.checked })} />
          内置敏感词过滤
        </span>
      </label>
      <label className="field-column">
        <span>屏蔽词（换行或逗号分隔，{blockedCount} 个）</span>
        <textarea rows={3} value={settings.blockedWords}
          onChange={(event) => onChange({ ...settings, blockedWords: event.target.value })}
          placeholder="每行一个关键词" />
      </label>
      <p className="danmaku-hint">弹幕来自非公开接口，加载失败时可在上方切换为「本集评论」。</p>
    </div>
  );
}

// 播放控件栏。行为对齐桌面端 PlayerControls.jsx：1 秒空闲自动隐藏、
// 点击倍速 +0.25 循环、选集/清晰度/弹幕设置 popover、三点菜单。
import { useEffect, useRef, useState } from 'react';
import type { EpisodeSummary } from '../api';
import { formatShortcut, type ShortcutActionId } from '../shortcuts';
import { SOURCE_LABELS } from '../danmaku/official';
import { DanmakuSettingsPanel } from '../danmaku/DanmakuLayer';
import type { DanmakuSettings } from '../danmaku/model';
import type { DanmakuSource } from '../danmaku/official';
import { Icon } from './icons';

export const QUALITIES = ['auto', '720p', '1080p'] as const;
export type PlayQuality = (typeof QUALITIES)[number];
export const QUALITY_LABELS: Record<PlayQuality, string> = { auto: '自动', '720p': '720P', '1080p': '1080P' };

export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

interface PlayerControlsProps {
  visible: boolean;
  /** 触屏模式：隐藏音量滑杆（改用手势）、放大点击区域 */
  touchMode?: boolean;
  seriesTitle: string;
  currentIndex: number;
  episodes: EpisodeSummary[];
  playing: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  speed: number;
  autoNext: boolean;
  quality: PlayQuality;
  pictureMode: 'fit' | 'width';
  danmakuEnabled: boolean;
  danmakuSource: DanmakuSource;
  danmakuSettings: DanmakuSettings;
  fullscreen: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  preparing: boolean;
  preparePhase: string;
  preparePercent: number;
  shortcuts: Record<ShortcutActionId, string>;
  onMenuChange?(open: boolean): void;
  onTogglePlay(): void;
  onSeek(time: number): void;
  onSeekBy(delta: number): void;
  onVolume(volume: number, muted: boolean): void;
  onSpeed(speed: number): void;
  onToggleAutoNext(): void;
  onQuality(quality: PlayQuality): void;
  onPictureMode(mode: 'fit' | 'width'): void;
  onEpisode(index: number): void;
  onFullscreen(): void;
  onDanmakuToggle(): void;
  onDanmakuSource(source: DanmakuSource): void;
  onDanmakuSettings(settings: DanmakuSettings): void;
}

const FINE_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4];

export function PlayerControls(props: PlayerControlsProps) {
  const [menu, setMenu] = useState<'none' | 'episodes' | 'quality' | 'danmaku' | 'more' | 'speed'>('none');
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    playing, currentTime, duration, buffered, volume, muted, speed, autoNext, quality, pictureMode,
    danmakuEnabled, fullscreen, hasPrevious, hasNext, preparing, preparePhase, preparePercent,
  } = props;

  // 点击组件外部时关闭 popover；菜单开关同步给父级用于控件常显
  useEffect(() => {
    props.onMenuChange?.(menu !== 'none');
  }, [menu]);
  useEffect(() => {
    if (menu === 'none') return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu('none');
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [menu]);

  const cycleSpeed = () => {
    const next = Math.min(4, Math.round((speed + 0.25) * 100) / 100);
    props.onSpeed(next >= 4 && speed >= 3.75 ? 1 : next);
  };

  const popover = (name: typeof menu, content: React.ReactNode) =>
    menu === name ? <div className="player-popover" role="menu" data-player-menu onClick={(event) => event.stopPropagation()}>{content}</div> : null;

  const activeEpisode = props.episodes.find((ep) => ep.vid_index === props.currentIndex);

  return (
    <div className={`player-controls${props.visible || menu !== 'none' || !playing ? '' : ' hidden'}${props.touchMode ? ' touch-mode' : ''}`} ref={rootRef}
      onPointerDown={(event) => event.stopPropagation()}>
      {preparing ? (
        <div className="prepare-tip" role="status">
          {preparePhase === 'decrypting' ? '正在解密片源…' : preparePhase === 'downloading'
            ? `正在缓冲片源… ${preparePercent}%` : '正在连接片源…'}
        </div>
      ) : null}
      <div className="progress-row">
        <input
          type="range" className="progress-range" min={0} max={Math.max(duration, 0.1)} step={0.1}
          value={Math.min(currentTime, duration || 0)}
          style={{ '--progress': `${duration ? (currentTime / duration) * 100 : 0}%`, '--buffered': `${duration ? (buffered / duration) * 100 : 0}%` } as React.CSSProperties}
          aria-label="播放进度"
          onChange={(event) => props.onSeek(Number(event.target.value))}
        />
      </div>
      <div className="buttons-row">
        <button className="ctrl-btn" onClick={props.onTogglePlay} aria-label={playing ? '暂停' : '播放'} title={playing ? '暂停' : '播放'}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="ctrl-btn desktop-only" onClick={() => props.onSeekBy(-5)} aria-label="快退 5 秒" title="快退 5 秒"><Icon name="backward" /></button>
        <button className="ctrl-btn desktop-only" onClick={() => props.onSeekBy(5)} aria-label="快进 5 秒" title="快进 5 秒"><Icon name="forward" /></button>
        <span className="time-label">{formatTime(currentTime)} / {formatTime(duration)}</span>

        <span className="flex-spacer" />

        <button className={`ctrl-btn${danmakuEnabled ? ' active' : ''}`} onClick={props.onDanmakuToggle}
          aria-label="弹幕开关" title="弹幕开关"><Icon name="danmaku" /></button>
        <button className={`ctrl-btn${menu === 'danmaku' ? ' active' : ''}`} onClick={() => setMenu(menu === 'danmaku' ? 'none' : 'danmaku')}
          aria-label="弹幕设置" aria-expanded={menu === 'danmaku'} title={`弹幕设置（${SOURCE_LABELS[props.danmakuSource]}）`}><Icon name="settings" /></button>
        {popover('danmaku', (
          <DanmakuSettingsPanel settings={props.danmakuSettings} source={props.danmakuSource}
            onChange={props.onDanmakuSettings} onSourceChange={props.onDanmakuSource}
            danmakuEnabled={danmakuEnabled} onEnabledChange={props.onDanmakuToggle} />
        ))}

        <button className="ctrl-btn" onClick={() => props.onVolume(volume, !muted)} aria-label={muted ? '取消静音' : '静音'}
          title={muted ? '取消静音' : '静音'}><Icon name={muted || volume === 0 ? 'mute' : 'volume'} /></button>
        <input
          type="range" className="volume-range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
          style={{ '--progress': `${muted ? 0 : volume * 100}%` } as React.CSSProperties}
          aria-label="音量"
          onChange={(event) => props.onVolume(Number(event.target.value), false)}
        />

        <button className={`ctrl-btn${autoNext ? ' active' : ''}`} onClick={props.onToggleAutoNext}
          aria-label="连播" aria-pressed={autoNext} title={`连播（${formatShortcut(props.shortcuts.autoNext)}）`}><Icon name="autoNext" /></button>

        <button className={`ctrl-btn${menu === 'episodes' ? ' active' : ''}`} onClick={() => setMenu(menu === 'episodes' ? 'none' : 'episodes')}
          aria-label="选集" aria-expanded={menu === 'episodes'} title="选集">
          <Icon name="list" />
          <span className="btn-text">{props.currentIndex}集</span>
        </button>
        {popover('episodes', (
          <div className="episode-grid" role="listbox" aria-label="选集">
            {props.episodes.map((ep) => (
              <button
                key={ep.vid}
                role="option"
                aria-selected={ep.vid_index === props.currentIndex}
                className={`episode-cell${ep.vid_index === props.currentIndex ? ' current' : ''}${ep.locked ? ' locked' : ''}${ep.web_available === false ? ' web-locked' : ''}`}
                onClick={() => { setMenu('none'); props.onEpisode(ep.vid_index); }}
                title={ep.locked ? '付费锁定集，网页端不提供播放' : ep.web_available === false ? '官网未开放该集，取源可能失败' : `第 ${ep.vid_index} 集`}
              >
                {ep.vid_index}
              </button>
            ))}
          </div>
        ))}

        <button className={`ctrl-btn${menu === 'quality' ? ' active' : ''}`} onClick={() => setMenu(menu === 'quality' ? 'none' : 'quality')}
          aria-label="清晰度" aria-expanded={menu === 'quality'} title="清晰度">
          <span className="btn-text">{QUALITY_LABELS[quality]}</span>
        </button>
        {popover('quality', (
          <div className="menu-list" role="menu">
            {QUALITIES.map((item) => (
              <button key={item} role="menuitemradio" aria-checked={item === quality} className="menu-item"
                onClick={() => { setMenu('none'); props.onQuality(item); }}>
                {QUALITY_LABELS[item]}{item === quality ? ' ✓' : ''}
              </button>
            ))}
          </div>
        ))}

        <button className="ctrl-btn" onClick={props.onFullscreen} aria-label="全屏" title={`全屏（${formatShortcut(props.shortcuts.fullscreen)}）`}>
          <Icon name={fullscreen ? 'shrink' : 'expand'} />
        </button>

        <button className="ctrl-btn desktop-only" onClick={cycleSpeed} aria-label="倍速" title="点击调整倍速（+0.25x）">
          <span className="btn-text">{speed.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}x</span>
        </button>

        <button className={`ctrl-btn${menu === 'more' ? ' active' : ''}`} onClick={() => setMenu(menu === 'more' ? 'none' : 'more')}
          aria-label="更多" aria-expanded={menu === 'more'} title="更多"><Icon name="more" /></button>
        {popover('more', (
          <div className="menu-list" role="menu">
            <button role="menuitem" className="menu-item" onClick={() => setMenu('speed')}>倍速（当前 {speed.toFixed(2)}x）</button>
            <button role="menuitemradio" aria-checked={pictureMode === 'fit'} className="menu-item"
              onClick={() => { props.onPictureMode('fit'); setMenu('none'); }}>画面适应窗口{pictureMode === 'fit' ? ' ✓' : ''}</button>
            <button role="menuitemradio" aria-checked={pictureMode === 'width'} className="menu-item"
              onClick={() => { props.onPictureMode('width'); setMenu('none'); }}>画面填满宽度{pictureMode === 'width' ? ' ✓' : ''}</button>
            <div className="menu-divider" />
            <div className="shortcut-list" data-shortcut-settings>
              {(['play', 'backward', 'forward', 'previous', 'next', 'autoNext', 'slower', 'faster', 'fullscreen'] as ShortcutActionId[]).map((id) => (
                <div key={id} className="shortcut-row"><span>{labelOf(id)}</span><kbd>{formatShortcut(props.shortcuts[id])}</kbd></div>
              ))}
            </div>
          </div>
        ))}
        {popover('speed', (
          <div className="menu-list" role="menu">
            <button role="menuitem" className="menu-item back-item" onClick={() => setMenu('more')}>‹ 返回</button>
            {FINE_SPEEDS.map((item) => (
              <button key={item} role="menuitemradio" aria-checked={item === speed} className="menu-item"
                onClick={() => { props.onSpeed(item); setMenu('none'); }}>
                {item.toFixed(2)}x{item === speed ? ' ✓' : ''}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="meta-row">
        <span className="series-title" title={props.seriesTitle}>{props.seriesTitle}</span>
        {activeEpisode ? <span className="episode-title">第 {activeEpisode.vid_index} 集</span> : null}
        {hasPrevious && <button className="link-btn" onClick={() => props.onEpisode(props.currentIndex - 1)}>上一集</button>}
        {hasNext && <button className="link-btn" onClick={() => props.onEpisode(props.currentIndex + 1)}>下一集</button>}
      </div>
    </div>
  );
}

function labelOf(id: ShortcutActionId) {
  const labels: Record<ShortcutActionId, string> = {
    play: '播放 / 暂停', backward: '快退 5 秒', forward: '快进 5 秒', previous: '上一集', next: '下一集',
    autoNext: '切换连播', slower: '减速 0.25 倍', faster: '加速 0.25 倍', fullscreen: '切换全屏',
  };
  return labels[id];
}

// 设置：外观、播放默认项、弹幕设置、快捷键、服务端缓存维护。
import { useEffect, useState } from 'react';
import { api } from '../api';
import { DanmakuSettingsPanel } from '../danmaku/DanmakuLayer';
import { useDanmakuSettings } from '../danmaku/store';
import { DEFAULT_SHORTCUTS, formatShortcut, SHORTCUT_ACTIONS, saveShortcuts, type ShortcutActionId } from '../shortcuts';
import { readTheme, saveTheme, subscribeSystemTheme, type ThemeName } from '../theme';
import { readQuality } from './Player';

export function SettingsPage() {
  const [theme, setThemeState] = useState<ThemeName>(readTheme);
  const [quality, setQualityState] = useState<'auto' | '720p' | '1080p'>(readQuality);
  const [cache, setCache] = useState<{ count: number; bytes: number } | null>(null);
  const [cacheMessage, setCacheMessage] = useState('');
  const [shortcutDraft, setShortcutDraft] = useState<Record<ShortcutActionId, string>>({ ...DEFAULT_SHORTCUTS } as any);
  const [shortcutError, setShortcutError] = useState('');
  const [shortcutTarget, setShortcutTarget] = useState<ShortcutActionId | null>(null);
  const danmakuSettings = useDanmakuSettings();
  const [danmakuEnabled, setDanmakuEnabled] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('hongguo:danmaku-enabled') || 'true') !== false; } catch { return true; }
  });

  useEffect(() => subscribeSystemTheme(() => { if (readTheme() === 'system') setThemeState('system'); }), []);
  useEffect(() => {
    void api.onlineCacheStatus().then((data) => setCache({ count: data.count, bytes: data.bytes })).catch(() => {});
  }, []);
  useEffect(() => {
    try { setShortcutDraft(JSON.parse(window.localStorage.getItem('hongguo:preview:playback-shortcuts:v1') || 'null') ?? DEFAULT_SHORTCUTS); }
    catch { setShortcutDraft(DEFAULT_SHORTCUTS as any); }
  }, []);

  useEffect(() => {
    if (!shortcutTarget) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      const key = event.key === ' ' ? 'space' : event.key.toLowerCase().replace('arrow', '');
      if (key === 'escape') { setShortcutTarget(null); return; }
      const next = { ...shortcutDraft, [shortcutTarget]: key };
      try {
        saveShortcuts(next as any);
        setShortcutDraft(next);
        setShortcutError('');
      } catch (err: any) { setShortcutError(err.message); }
      setShortcutTarget(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [shortcutTarget, shortcutDraft]);

  const formatBytes = (bytes: number) => bytes > 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes > 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

  return (
    <section className="page">
      <header className="page-header"><h1>设置</h1></header>

      <h2 className="block-title">外观</h2>
      <div className="field-row">
        <label htmlFor="theme-select">主题</label>
        <select id="theme-select" value={theme} onChange={(event) => {
          const next = event.target.value as ThemeName;
          setThemeState(next);
          saveTheme(next);
        }}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>

      <h2 className="block-title">播放</h2>
      <div className="field-row">
        <label htmlFor="quality-select">默认清晰度</label>
        <select id="quality-select" value={quality} onChange={(event) => {
          const next = event.target.value as 'auto' | '720p' | '1080p';
          setQualityState(next);
          window.localStorage.setItem('hongguo:online-quality', JSON.stringify(next));
        }}>
          <option value="auto">自动</option>
          <option value="720p">720P</option>
          <option value="1080p">1080P</option>
        </select>
      </div>
      <p className="muted">清晰度由片源实际提供；所选清晰度不存在时不会静默降级，会提示改用自动。</p>

      <h2 className="block-title">弹幕</h2>
      <DanmakuSettingsPanel settings={danmakuSettings.settings} source={danmakuSettings.source}
        onChange={danmakuSettings.setSettings} onSourceChange={danmakuSettings.setSource}
        danmakuEnabled={danmakuEnabled} onEnabledChange={(enabled) => {
          setDanmakuEnabled(enabled);
          window.localStorage.setItem('hongguo:danmaku-enabled', JSON.stringify(enabled));
        }} />

      <h2 className="block-title">快捷键</h2>
      {shortcutError ? <p className="form-error" role="alert">{shortcutError}</p> : null}
      <div className="shortcut-list" data-shortcut-settings>
        {SHORTCUT_ACTIONS.map((action) => (
          <div key={action.id} className="shortcut-row">
            <span>{action.label}</span>
            <button className="secondary-btn" onClick={() => setShortcutTarget(action.id)}>
              {shortcutTarget === action.id ? '按下新按键…' : formatShortcut(shortcutDraft[action.id as ShortcutActionId] ?? action.key)}
            </button>
          </div>
        ))}
      </div>
      <button className="link-btn" onClick={() => {
        saveShortcuts({ ...DEFAULT_SHORTCUTS } as any);
        setShortcutDraft(DEFAULT_SHORTCUTS as any);
        setShortcutError('');
      }}>恢复默认快捷键</button>

      <h2 className="block-title">数据</h2>
      <p className="muted">
        服务端在线缓存：{cache ? `${cache.count} 个条目，约 ${formatBytes(cache.bytes)}` : '加载中…'}
        （加密片源解密后会暂存在服务端，上限 300MB）
      </p>
      <div className="field-row">
        <button className="danger-btn" onClick={async () => {
          await api.clearOnlineCache().catch(() => {});
          setCacheMessage('已清空在线缓存');
          const data = await api.onlineCacheStatus().catch(() => null);
          if (data) setCache({ count: data.count, bytes: data.bytes });
        }}>清空服务端在线缓存</button>
        {cacheMessage ? <span className="muted">{cacheMessage}</span> : null}
      </div>

      <h2 className="block-title">关于</h2>
      <p className="muted">
        红果短剧 Web 播放器（独立开源实现，GPL-3.0）。播放与弹幕数据来自红果短剧公开网页与
        非公开接口的移植实现，随时可能失效；仅供学习交流，请支持官方 App。
      </p>
    </section>
  );
}

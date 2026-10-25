// 弹幕设置存储与来源切换（与桌面端同存储键）。
import { useEffect, useState } from 'react';
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, type DanmakuSettings } from './model';
import { DEFAULT_DANMAKU_SOURCE, normalizeDanmakuSource, type DanmakuSource } from './official';

const SETTINGS_KEY = 'hongguo:comment-danmaku:v1';
const SOURCE_KEY = 'hongguo:danmaku-source:v1';

export function readDanmakuSettings(): DanmakuSettings {
  try { return normalizeDanmakuSettings(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch { return { ...DEFAULT_DANMAKU_SETTINGS }; }
}

export function saveDanmakuSettings(settings: DanmakuSettings) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event('hongguo:danmaku-settings-changed'));
}

export function readDanmakuSource(): DanmakuSource {
  try { return normalizeDanmakuSource(JSON.parse(window.localStorage.getItem(SOURCE_KEY) || '')); }
  catch { return DEFAULT_DANMAKU_SOURCE; }
}

export function saveDanmakuSource(source: DanmakuSource) {
  window.localStorage.setItem(SOURCE_KEY, JSON.stringify(source));
  window.dispatchEvent(new Event('hongguo:danmaku-settings-changed'));
}

export function useDanmakuSettings() {
  const [settings, setSettings] = useState(readDanmakuSettings);
  const [source, setSource] = useState(readDanmakuSource);
  useEffect(() => {
    const update = () => { setSettings(readDanmakuSettings()); setSource(readDanmakuSource()); };
    window.addEventListener('hongguo:danmaku-settings-changed', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('hongguo:danmaku-settings-changed', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return { settings, source, setSettings: saveDanmakuSettings, setSource: saveDanmakuSource };
}

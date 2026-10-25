// 主题（浅色/深色/跟随系统）— 与桌面端 src/theme.js 同一套行为与存储键。
const STORAGE_KEY = 'hongguo:theme';
export type ThemeName = 'light' | 'dark' | 'system';

export function readTheme(): ThemeName {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '');
    if (['light', 'dark', 'system'].includes(value)) return value;
  } catch { /* fallthrough */ }
  return 'system';
}

export function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function effectiveTheme(theme: ThemeName): 'light' | 'dark' {
  return theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = effectiveTheme(theme);
}

export function saveTheme(theme: ThemeName) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  applyTheme(theme);
}

export function subscribeSystemTheme(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

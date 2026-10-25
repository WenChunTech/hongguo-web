// 播放快捷键 — 移植桌面端 src/shortcuts.js（同键位、同存储键、同校验）。
export const SHORTCUT_STORAGE_KEY = 'hongguo:preview:playback-shortcuts:v1';
export const SHORTCUT_EVENT = 'hongguo:playback-shortcuts-changed';
export const SHORTCUT_ACTIONS = [
  { id: 'play', label: '播放 / 暂停', key: 'space' },
  { id: 'backward', label: '快退 5 秒', key: 'arrowleft', repeat: true },
  { id: 'forward', label: '快进 5 秒', key: 'arrowright', repeat: true },
  { id: 'previous', label: '上一集', key: 'arrowup' },
  { id: 'next', label: '下一集', key: 'arrowdown' },
  { id: 'autoNext', label: '切换连播', key: 'a' },
  { id: 'slower', label: '减速 0.25 倍', key: 's', repeat: true },
  { id: 'faster', label: '加速 0.25 倍', key: 'd', repeat: true },
  { id: 'fullscreen', label: '切换全屏', key: 'f' },
] as const;
export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id'];
export const DEFAULT_SHORTCUTS: Record<ShortcutActionId, string> =
  Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, action.key])) as Record<ShortcutActionId, string>;
const KEY_PATTERN = /^(shift\+)?([a-z0-9]|space|arrowleft|arrowright|arrowup|arrowdown)$/;

export function shortcutKey(event: KeyboardEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
  let key = String(event.key || '').toLowerCase();
  if (event.code === 'Space' || key === ' ') key = 'space';
  else if (/^Key[A-Z]$/.test(event.code || '')) key = event.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(event.code || '')) key = event.code.slice(5);
  const value = `${event.shiftKey ? 'shift+' : ''}${key}`;
  return KEY_PATTERN.test(value) && value !== 'shift+space' ? value : null;
}

export function formatShortcut(value: string) {
  const names: Record<string, string> = { space: '空格', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' };
  return value.split('+').map((key) => names[key] || (key === 'shift' ? 'Shift' : key.toUpperCase())).join(' + ');
}

export function validateShortcuts(bindings: Record<string, string> | null | undefined): string {
  const seen = new Map<string, string>();
  for (const action of SHORTCUT_ACTIONS) {
    const key = bindings?.[action.id];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key === 'shift+space') return `${action.label}的按键不可用`;
    if (seen.has(key)) return `与「${seen.get(key)}」冲突，请换一个按键`;
    seen.set(key, action.label);
  }
  return '';
}

export function readShortcuts(): Record<ShortcutActionId, string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE_KEY) || '');
    if (!validateShortcuts(stored)) {
      return Object.fromEntries(SHORTCUT_ACTIONS.map(({ id }) => [id, stored[id]])) as Record<ShortcutActionId, string>;
    }
  } catch { /* Missing or damaged preferences use the complete default map. */ }
  return { ...DEFAULT_SHORTCUTS };
}

export function saveShortcuts(bindings: Record<ShortcutActionId, string>) {
  const error = validateShortcuts(bindings);
  if (error) throw new Error(error);
  window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  window.dispatchEvent(new Event(SHORTCUT_EVENT));
}

export function subscribeShortcuts(onChange: () => void) {
  const update = (event: Event) => {
    if (event.type !== 'storage' || (event as StorageEvent).key === SHORTCUT_STORAGE_KEY || (event as StorageEvent).key === null) onChange();
  };
  window.addEventListener(SHORTCUT_EVENT, update);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(SHORTCUT_EVENT, update);
    window.removeEventListener('storage', update);
  };
}

export function ignoresPlaybackShortcut(target: EventTarget | null, key: string | null) {
  const element = target as HTMLElement | null;
  if (!element?.closest) return false;
  if (element.isContentEditable || element.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [data-shortcut-settings], [role="dialog"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="listbox"]')) return true;
  if (element.closest('[data-player-menu]')) {
    // Escape/selection returns focus to the trigger; a closed menu must not keep swallowing playback keys.
    const closedTrigger = element.closest('button[aria-haspopup][aria-expanded="false"]') && element.closest('.player-container');
    if (!closedTrigger || !key || key === ' ' || key === 'Enter') return true;
  }
  return !!(element.closest('button, a') && !element.closest('.player-container'));
}

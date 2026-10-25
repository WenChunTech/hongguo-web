// 搜索历史（与桌面端同一存储键）。
const STORAGE_KEY = 'hongguo-experience-preview:search-history';
const MAX_ITEMS = 12;

export function readSearchHistory(): string[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(stored)) return stored.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_ITEMS);
  } catch { /* fallthrough */ }
  return [];
}

export function rememberSearch(keyword: string) {
  const clean = keyword.trim();
  if (!clean) return;
  const next = [clean, ...readSearchHistory().filter((item) => item !== clean)].slice(0, MAX_ITEMS);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function clearSearchHistory() {
  window.localStorage.removeItem(STORAGE_KEY);
}

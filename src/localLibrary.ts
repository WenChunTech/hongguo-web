// 收藏（本机 localStorage，与桌面端 ReleaseCalendar 同一存储键与结构）。
export interface LibraryEntry {
  id: string; title: string; cover: string;
  published_at: number | null; favorite: boolean; addedAt?: number;
}
const STORAGE_KEY = 'hongguo:public-library:v1';
const LIBRARY_EVENT = 'hongguo:public-library-changed';

export function readLibrary(): LibraryEntry[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(stored)) return stored.filter((item) => item && typeof item.id === 'string');
  } catch { /* fallthrough */ }
  return [];
}

function writeLibrary(entries: LibraryEntry[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  window.dispatchEvent(new Event(LIBRARY_EVENT));
}

export function subscribeLibrary(onChange: () => void) {
  const update = (event: Event) => {
    if (event.type !== 'storage' || (event as StorageEvent).key === STORAGE_KEY || (event as StorageEvent).key === null) onChange();
  };
  window.addEventListener(LIBRARY_EVENT, update);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(LIBRARY_EVENT, update);
    window.removeEventListener('storage', update);
  };
}

export function isFavorite(id: string) {
  return readLibrary().some((item) => item.id === id && item.favorite);
}

export function setFavorite(entry: { id: string; title: string; cover: string; published_at?: number | null }, favorite: boolean) {
  const entries = readLibrary();
  const index = entries.findIndex((item) => item.id === entry.id);
  const next: LibraryEntry = {
    id: entry.id,
    title: entry.title,
    cover: entry.cover,
    published_at: entry.published_at ?? null,
    favorite,
    addedAt: index >= 0 ? entries[index].addedAt : Date.now(),
  };
  if (index >= 0) entries[index] = next;
  else entries.unshift(next);
  writeLibrary(entries);
}

export function removeEntry(id: string) {
  writeLibrary(readLibrary().filter((item) => item.id !== id));
}

export function favorites() {
  return readLibrary().filter((item) => item.favorite);
}

// 应用外壳：侧栏 + 页面容器。与桌面端 App.jsx 相同的「保留已访问页面 DOM」
// 策略（hidden 切换），保证切页后播放不中断。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Browse } from './components/Browse';
import { SearchPage } from './components/SearchPage';
import { Player, type PlayerNavigation } from './components/Player';
import { WatchHistory } from './components/WatchHistory';
import { FavoritesPage } from './components/FavoritesPage';
import { DownloadManager } from './components/DownloadManager';
import { SettingsPage } from './components/SettingsPage';
import { Icon } from './components/icons';
import { applyTheme, readTheme } from './theme';

const MENU = [
  { id: 'browse', label: '发现短剧', icon: 'home' },
  { id: 'search', label: '搜索与解析', icon: 'search' },
  { id: 'player', label: '我的剧库', icon: 'library' },
  { id: 'history', label: '观看记录', icon: 'history' },
  { id: 'calendar', label: '收藏与上新', icon: 'star' },
  { id: 'downloads', label: '下载管理', icon: 'download' },
  { id: 'settings', label: '设置', icon: 'gear' },
] as const;
type PageId = (typeof MENU)[number]['id'];

const PAGE_IDS = new Set<string>(MENU.map((item) => item.id));

/** hash ↔ 路由：#/页ID；播放页 #/player/剧集ID[/集序号]。刷新与前进/后退均可恢复。 */
function parseHash(hash: string): { page: PageId; navigation: PlayerNavigation | null } {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = PAGE_IDS.has(parts[0] ?? '') ? (parts[0] as PageId) : 'browse';
  const seriesId = parts[1] ?? '';
  if (page === 'player' && /^\d{1,30}$/.test(seriesId)) {
    const vidIndex = /^\d+$/.test(parts[2] ?? '') ? Number(parts[2]) : undefined;
    return { page, navigation: { seriesId, vidIndex, resume: true } };
  }
  return { page, navigation: null };
}

function hashFor(page: PageId, navigation: PlayerNavigation | null): string {
  if (page === 'player' && navigation) {
    return `#/player/${navigation.seriesId}${navigation.vidIndex !== undefined ? `/${navigation.vidIndex}` : ''}`;
  }
  return `#/${page}`;
}

export default function App() {
  const [initialRoute] = useState(() => parseHash(window.location.hash));
  const [page, setPage] = useState<PageId>(initialRoute.page);
  const [visited, setVisited] = useState<Set<PageId>>(() => new Set<PageId>([initialRoute.page]));
  const [navigation, setNavigation] = useState<PlayerNavigation | null>(initialRoute.navigation);
  const visitedRef = useRef(visited);
  visitedRef.current = visited;
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => { applyTheme(readTheme()); }, []);

  const applyRoute = useCallback((next: PageId, nav: PlayerNavigation | null) => {
    setPage(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    if (next === 'player') setNavigation(nav);
  }, []);

  // hash 是页面状态的唯一来源：侧栏点击写入新历史条目，浏览器前进/后退、刷新
  // 与深链都经 hashchange 恢复；页面 DOM 保持挂载（hidden 切换），播放不中断。
  useEffect(() => {
    const onHashChange = () => {
      const { page: parsed, navigation: nav } = parseHash(window.location.hash);
      applyRoute(parsed, nav);
    };
    window.addEventListener('hashchange', onHashChange);
    // 初始加载：无效或缺失的 hash 归一化（replaceState 不产生历史条目）
    if (!PAGE_IDS.has(window.location.hash.replace(/^#\/?/, '').split('/')[0] ?? '')) {
      history.replaceState(null, '', hashFor(initialRoute.page, initialRoute.navigation));
    }
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [applyRoute, initialRoute]);

  const navigate = useCallback((next: PageId, nav: PlayerNavigation | null) => {
    const target = hashFor(next, nav);
    if (window.location.hash === target) {
      applyRoute(next, nav); // 地址未变化时不会触发 hashchange：直接应用，不重复压栈
    } else {
      window.location.hash = target;
    }
  }, [applyRoute]);

  const goto = useCallback((next: PageId) => {
    if (pageRef.current === next) return; // 重复点击当前页不产生历史条目
    navigate(next, null);
  }, [navigate]);

  const playSeries = useCallback((seriesId: string, vidIndex?: number) => {
    navigate('player', { seriesId: String(seriesId), vidIndex, resume: true });
  }, [navigate]);

  const onNavigateHandled = useCallback(() => setNavigation(null), []);

  return (
    <div className={`app-shell${page === 'player' ? ' player-active' : ''}`}>
      <nav className="sidebar" aria-label="主导航">
        <div className="sidebar-brand">红果短剧<span className="brand-web">Web</span></div>
        <ul>
          {MENU.map((item) => (
            <li key={item.id}>
              <button
                className={`nav-item${page === item.id ? ' selected' : ''}`}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => goto(item.id)}
              >
                <Icon name={item.icon} size={17} />
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="sidebar-foot">GPL-3.0 开源实现<br />仅供学习交流</p>
      </nav>
      <main className="content">
        {visited.has('browse') ? <div hidden={page !== 'browse'}><Browse onPlay={playSeries} /></div> : null}
        {visited.has('search') ? <div hidden={page !== 'search'}><SearchPage onPlay={playSeries} /></div> : null}
        {visited.has('player') ? (
          <div hidden={page !== 'player'}>
            <Player active={page === 'player'} navigation={navigation} onNavigateHandled={onNavigateHandled} onOpenBrowse={() => goto('browse')} />
          </div>
        ) : null}
        {visited.has('history') ? <div hidden={page !== 'history'}><WatchHistory onPlay={playSeries} /></div> : null}
        {visited.has('calendar') ? <div hidden={page !== 'calendar'}><FavoritesPage onPlay={playSeries} /></div> : null}
        {visited.has('downloads') ? <div hidden={page !== 'downloads'}><DownloadManager onPlay={playSeries} /></div> : null}
        {visited.has('settings') ? <div hidden={page !== 'settings'}><SettingsPage /></div> : null}
      </main>
      {/* 移动端底部导航（桌面端由 CSS 隐藏，播放页沉浸时也隐藏） */}
      <nav className="bottom-nav" aria-label="底部导航">
        {MENU.map((item) => (
          <button
            key={item.id}
            className={`bottom-nav-item${page === item.id ? ' selected' : ''}`}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => goto(item.id)}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

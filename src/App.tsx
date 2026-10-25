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

export default function App() {
  const [page, setPage] = useState<PageId>('browse');
  const [visited, setVisited] = useState<Set<PageId>>(() => new Set<PageId>(['browse']));
  const [navigation, setNavigation] = useState<PlayerNavigation | null>(null);
  const visitedRef = useRef(visited);
  visitedRef.current = visited;

  useEffect(() => { applyTheme(readTheme()); }, []);

  const goto = useCallback((next: PageId) => {
    setPage(next);
    setVisited((prev) => new Set(prev).add(next));
  }, []);

  const playSeries = useCallback((seriesId: string, vidIndex?: number) => {
    setNavigation({ seriesId: String(seriesId), vidIndex, resume: true });
    goto('player');
  }, [goto]);

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

// 搜索与解析：关键词搜索（App 签名接口，可分页）+ 输入联想（命中剧集可直接播放）
// + 分享链接/ID 解析。搜索不再依赖无头浏览器。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CardItem, type SuggestRow } from '../api';
import { clearSearchHistory, readSearchHistory, rememberSearch } from '../searchHistory';
import { SeriesDetailDrawer, SeriesCard } from './Browse';
import { Icon } from './icons';

export function SearchPage({ onPlay }: { onPlay(seriesId: string, vidIndex?: number): void }) {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<CardItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<{ hasMore: boolean; nextOffset: number; searchId: string }>({ hasMore: false, nextOffset: 0, searchId: '' });
  const [history, setHistory] = useState(readSearchHistory);
  const [drawerId, setDrawerId] = useState('');
  const [linkInput, setLinkInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');

  // ── 联想（≥2 字、300ms 防抖、键盘导航、IME 组合保护） ──
  const [suggests, setSuggests] = useState<SuggestRow[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [composing, setComposing] = useState(false);
  const debounceRef = useRef(0);
  const searchBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (composing) return;
    const clean = keyword.trim();
    if (clean.length < 2) { setSuggests([]); setSuggestOpen(false); return; }
    debounceRef.current = window.setTimeout(async () => {
      try {
        const data = await api.searchSuggest(clean);
        setSuggests(data.results ?? []);
        setSuggestOpen((data.results ?? []).length > 0);
        setSuggestIndex(-1);
      } catch { setSuggests([]); }
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [keyword, composing]);

  useEffect(() => {
    if (!suggestOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!searchBoxRef.current?.contains(event.target as Node)) setSuggestOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [suggestOpen]);

  const doSearch = useCallback(async (value: string) => {
    const clean = value.trim();
    if (!clean || searching) return;
    setSearching(true);
    setError('');
    setResults(null);
    setSuggestOpen(false);
    setSuggests([]); // 结果出来后不要让联想下拉盖住结果
    try {
      const data = await api.search(clean);
      if (!data.success) throw new Error(data.error || '搜索失败');
      setResults(data.results ?? []);
      setPage({ hasMore: data.hasMore === true, nextOffset: data.nextOffset ?? 0, searchId: data.searchId ?? '' });
      rememberSearch(clean);
      setHistory(readSearchHistory());
    } catch (err: any) {
      setError(err.message || '搜索失败');
    } finally {
      setSearching(false);
    }
  }, [searching]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !page.hasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.search(keyword.trim(), page.nextOffset, page.searchId);
      if (data.success) {
        setResults((prev) => [...(prev ?? []), ...(data.results ?? [])]);
        setPage({ hasMore: data.hasMore === true, nextOffset: data.nextOffset ?? 0, searchId: data.searchId ?? '' });
      }
    } catch { /* 分页失败静默，保留已加载结果 */ }
    finally { setLoadingMore(false); }
  }, [keyword, page, loadingMore]);

  const pickSuggest = useCallback((row: SuggestRow) => {
    setSuggestOpen(false);
    if (row.seriesId) {
      onPlay(row.seriesId); // 命中剧集词条：直接进播放器
    } else {
      setKeyword(row.name);
      void doSearch(row.name);
    }
  }, [doSearch, onPlay]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing || event.nativeEvent.isComposing) return; // 输入法组合中不抢键
    if (suggestOpen && suggests.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSuggestIndex((i) => (i + 1) % suggests.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSuggestIndex((i) => (i - 1 + suggests.length) % suggests.length); return; }
      if (event.key === 'Escape') { setSuggestOpen(false); return; }
      if (event.key === 'Enter' && suggestIndex >= 0) {
        event.preventDefault();
        pickSuggest(suggests[suggestIndex]);
        return;
      }
    }
    if (event.key === 'Enter') void doSearch(keyword);
  };

  const doResolve = useCallback(async () => {
    const clean = linkInput.trim();
    if (!clean || resolving) return;
    setResolving(true);
    setResolveError('');
    try {
      const data = await api.resolve(clean);
      if (!data.success || !data.series_id) throw new Error(data.error || '解析失败');
      const detail = await api.registerSeries(data.series_id);
      if (!detail.success || !detail.data) throw new Error(detail.error || '读取分集失败');
      setDrawerId(data.series_id);
    } catch (err: any) {
      setResolveError(err.message || '解析失败');
    } finally {
      setResolving(false);
    }
  }, [linkInput, resolving]);

  return (
    <section className="page">
      <header className="page-header"><h1>搜索与解析</h1></header>
      <div className="segmented" role="tablist" aria-label="搜索方式">
        <div className="search-block">
          <h2 className="block-title">关键词搜索</h2>
          <div className="search-row" ref={searchBoxRef} style={{ position: 'relative' }}>
            <input
              id="search-input"
              type="search"
              value={keyword}
              placeholder="输入剧名关键词（输入时自动联想）"
              autoComplete="off"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={onSearchKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => { setComposing(false); }}
              onFocus={() => { if (suggests.length) setSuggestOpen(true); }}
            />
            <button className="primary-btn" disabled={!keyword.trim() || searching} onClick={() => void doSearch(keyword)}>
              {searching ? '搜索中…' : '搜索'}
            </button>
            {suggestOpen && suggests.length ? (
              <div className="suggest-dropdown" role="listbox" aria-label="搜索联想">
                {suggests.map((row, index) => (
                  <button
                    key={`${row.keyword}-${row.name}`}
                    role="option"
                    aria-selected={index === suggestIndex}
                    className={`suggest-row${index === suggestIndex ? ' active' : ''}`}
                    onMouseDown={(event) => { event.preventDefault(); pickSuggest(row); }}
                    onMouseEnter={() => setSuggestIndex(index)}
                  >
                    {row.cover ? <img src={row.cover} alt="" loading="lazy" /> : <span className="suggest-icon"><Icon name="search" size={14} /></span>}
                    <span className="suggest-text">
                      <span className="suggest-name">{row.name}</span>
                      {row.abstract ? <span className="suggest-abstract">{row.abstract}</span> : null}
                    </span>
                    {row.seriesId ? <span className="suggest-play">直接播放</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {history.length ? (
            <div className="chip-row small">
              {history.map((item) => (
                <button key={item} className="chip" onClick={() => { setKeyword(item); void doSearch(item); }}>{item}</button>
              ))}
              <button className="link-btn" onClick={() => { clearSearchHistory(); setHistory([]); }}>清空历史</button>
            </div>
          ) : null}
          {searching ? <p className="muted">正在搜索…</p> : null}
          {error ? <div className="empty-state"><p role="alert">{error}</p></div> : null}
          {results && results.length === 0 ? <div className="empty-state"><p>没有找到相关剧集，换个关键词试试。</p></div> : null}
          {results && results.length > 0 ? (
            <>
              <div className="card-grid">{results.map((item) => <SeriesCard key={item.series_id} item={item} onOpen={(card) => setDrawerId(card.series_id)} />)}</div>
              {page.hasMore ? (
                <div className="load-more-row">
                  <button className="secondary-btn" disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="search-block">
          <h2 className="block-title">分享链接 / 剧集 ID</h2>
          <p className="muted">粘贴红果 App 的分享口令链接，或直接输入剧集数字 ID。</p>
          <div className="search-row">
            <input
              type="text"
              value={linkInput}
              placeholder="https://v.douyin.com/... 或 7301234567890123456"
              onChange={(event) => setLinkInput(event.target.value)}
            />
            <button className="primary-btn" disabled={!linkInput.trim() || resolving} onClick={() => void doResolve()}>
              {resolving ? '解析中…' : '解析并打开'}
            </button>
          </div>
          {resolveError ? <p className="form-error" role="alert">{resolveError}</p> : null}
        </div>
      </div>
      {drawerId ? (
        <SeriesDetailDrawer seriesId={drawerId} onClose={() => setDrawerId('')}
          onPlay={(sid, vidIndex) => { setDrawerId(''); onPlay(sid, vidIndex); }} />
      ) : null}
    </section>
  );
}

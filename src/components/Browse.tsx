// 发现短剧：分类/榜单/题材筛选/分页 + 详情抽屉（元信息、选集、相关作品、下载、收藏）。
import { useCallback, useEffect, useState } from 'react';
import { api, type BrowseCategory, type CardItem, type RelatedSeries, type SeriesDetail, type SeriesMeta } from '../api';
import { isFavorite, setFavorite } from '../localLibrary';
import { Icon } from './icons';

export function formatPublished(timestamp: number | null | undefined) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 万/亿一位小数、整数省小数点（对齐桌面端 formatCountPrecise 口径）。 */
export function formatCount(value: number | null | undefined) {
  if (!Number.isFinite(Number(value)) || !value) return '';
  if (value >= 100000000) return `${(value / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(value);
}

export function formatDuration(seconds: number | null | undefined) {
  if (!Number.isFinite(Number(seconds)) || seconds! <= 0) return '';
  const total = Math.round(seconds!);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function SeriesCard({ item, onOpen }: { item: CardItem; onOpen(item: CardItem): void }) {
  return (
    <article className="card">
      <button className="poster-btn" onClick={() => onOpen(item)}>
        {item.cover ? <img src={item.cover} alt={item.series_title} loading="lazy" /> : <div className="poster-placeholder" />}
        {item.rank ? <span className="rank-badge">{item.rank}</span> : null}
        {item.episode_count > 0 ? <span className="episode-badge">全{item.episode_count}集</span> : null}
        <span className="card-title">{item.series_title}</span>
      </button>
      {item.heat ? <p className="card-heat">{item.heat}</p> : null}
      {item.episode_label ? <p className="card-meta">{item.episode_label}</p> : null}
      {item.tags?.length ? <p className="card-tags">{item.tags.join(' · ')}</p> : null}
    </article>
  );
}

export function SeriesDetailDrawer({ seriesId, onClose, onPlay, externalDetail, onSwitchSeries }: {
  seriesId: string;
  onClose(): void;
  onPlay(seriesId: string, vidIndex?: number): void;
  externalDetail?: SeriesDetail | null;
  onSwitchSeries?(seriesId: string): void;
}) {
  const [detail, setDetail] = useState<SeriesDetail | null>(externalDetail ?? null);
  const [loading, setLoading] = useState(!externalDetail);
  const [error, setError] = useState('');
  const [showAllEpisodes, setShowAllEpisodes] = useState(false);
  const [meta, setMeta] = useState<any>(null);
  const [appMeta, setAppMeta] = useState<SeriesMeta | null>(null);
  const [related, setRelated] = useState<RelatedSeries[]>([]);
  const [favorite, setFavoriteState] = useState(isFavorite(seriesId));
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadRange, setDownloadRange] = useState('');
  const [downloadQuality, setDownloadQuality] = useState('auto');
  const [downloadMessage, setDownloadMessage] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(externalDetail ?? null);
    setLoading(!externalDetail);
    setError('');
    setShowAllEpisodes(false);
    setAppMeta(null);
    setRelated([]);
    setDownloadOpen(false);
    setDownloadMessage('');
    if (externalDetail) return () => { cancelled = true; };
    api.registerSeries(seriesId).then((data) => {
      if (cancelled) return;
      if (data.success && data.data) setDetail(data.data);
      else setError(data.error || '打开剧集失败');
      setLoading(false);
    }).catch((err) => {
      if (!cancelled) { setError(err.message || '打开剧集失败'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [seriesId, externalDetail]);

  useEffect(() => {
    let cancelled = false;
    api.publicDetails(seriesId).then((data) => { if (!cancelled && data?.success) setMeta(data); }).catch(() => {});
    api.seriesMeta(seriesId).then((data) => { if (!cancelled && data?.success && data.meta) setAppMeta(data.meta); }).catch(() => {});
    api.related(seriesId).then((data) => { if (!cancelled && data?.success) setRelated(data.related ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [seriesId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const episodes = detail?.episodes ?? [];
  const visibleEpisodes = showAllEpisodes ? episodes : episodes.slice(0, 24);
  const intro = appMeta?.series_intro || detail?.series_intro || '';
  const hotText = appMeta?.hot_score ? `${formatCount(appMeta.hot_score)}热度` : '';

  const createDownload = async () => {
    if (!detail || downloading) return;
    setDownloading(true);
    setDownloadMessage('');
    try {
      const data = await api.createDownload({
        seriesId: detail.series_id,
        range: downloadRange.trim(),
        quality: downloadQuality,
      });
      if (!data.success) throw new Error(data.error || '创建下载任务失败');
      const done = data.task?.episodes.length ?? 0;
      setDownloadMessage(`已创建下载任务（${done} 集），可在「下载管理」页查看进度`);
    } catch (err: any) {
      setDownloadMessage(err.message || '创建下载任务失败');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="drawer" role="dialog" aria-modal="true" aria-label="剧集详情" onClick={(event) => event.stopPropagation()}>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">✕</button>
        <div className="drawer-hero">
          {detail?.cover ? <img src={detail.cover} alt="" /> : <div className="poster-placeholder large" />}
          <div className="drawer-info">
            <h2>{detail?.series_title || (loading ? '加载中…' : '打开失败')}</h2>
            <div className="meta-badges">
              {meta?.rating ? <span className="meta-badge rating">评分 {Number(meta.rating).toFixed(1)}</span> : null}
              {hotText ? <span className="meta-badge">{hotText}</span> : null}
              {appMeta?.follow_cnt ? <span className="meta-badge">{formatCount(appMeta.follow_cnt)}追剧</span> : null}
              {appMeta?.series_play_cnt ? <span className="meta-badge">{formatCount(appMeta.series_play_cnt)}播放</span> : null}
            </div>
            {detail ? <p className="muted">共 {detail.total} 集{detail.web_accessible_episodes != null ? ` · 官网开放 ${detail.web_accessible_episodes} 集` : ''}</p> : null}
            {meta?.episode_label ? <p className="muted">{meta.episode_label}</p> : null}
            {meta?.published_at ? <p className="muted">首次公开 {formatPublished(meta.published_at)}</p> : null}
            {appMeta?.record_number ? <p className="muted small-text">备案号 {appMeta.record_number}</p> : null}
            {intro ? <p className="drawer-intro">{intro}</p> : null}
            <div className="drawer-actions">
              <button className="primary-btn" disabled={!detail || loading}
                onClick={() => detail && onPlay(detail.series_id, detail.resume?.vid_index || 1)}>
                {detail?.resume ? `继续播放（第 ${detail.resume.vid_index} 集）` : '立即播放'}
              </button>
              <button className={`secondary-btn${favorite ? ' active' : ''}`}
                onClick={() => {
                  if (!detail) return;
                  const next = !favorite;
                  setFavorite({ id: detail.series_id, title: detail.series_title, cover: detail.cover,
                    published_at: meta?.published_at ?? null }, next);
                  setFavoriteState(next);
                }}>
                <Icon name="star" size={16} /> {favorite ? '已收藏' : '收藏'}
              </button>
              <button className={`secondary-btn${downloadOpen ? ' active' : ''}`} disabled={!detail}
                onClick={() => setDownloadOpen((prev) => !prev)}>
                ⤓ 下载
              </button>
            </div>
            {downloadOpen && detail ? (
              <div className="download-form" data-shortcut-settings>
                <div className="field-row">
                  <label htmlFor="dl-range">选集区间</label>
                  <input id="dl-range" type="text" value={downloadRange}
                    placeholder={`留空下载全部未锁定集（1-${detail.total}）`}
                    onChange={(event) => setDownloadRange(event.target.value)} />
                </div>
                <div className="field-row">
                  <label htmlFor="dl-quality">清晰度</label>
                  <select id="dl-quality" value={downloadQuality} onChange={(event) => setDownloadQuality(event.target.value)}>
                    <option value="auto">自动</option>
                    <option value="1080p">1080P</option>
                    <option value="720p">720P</option>
                  </select>
                </div>
                <div className="field-row">
                  <button className="primary-btn" disabled={downloading} onClick={() => void createDownload()}>
                    {downloading ? '创建中…' : '创建下载任务'}
                  </button>
                  {downloadMessage ? <span className="muted">{downloadMessage}</span> : null}
                </div>
                <p className="muted small-text">支持区间语法：1-30,5,8（服务端逐集下载并解密，进度见「下载管理」页）</p>
              </div>
            ) : null}
            {error ? <p className="form-error" role="alert">{error}</p> : null}
          </div>
        </div>
        {detail ? (
          <>
            <h3 className="drawer-section">选集</h3>
            <div className="drawer-episodes">
              {visibleEpisodes.map((ep) => (
                <button key={ep.vid} className={`episode-cell${ep.locked ? ' locked' : ''}`}
                  disabled={ep.locked}
                  title={ep.locked ? '付费锁定集，网页端不提供播放' : `第 ${ep.vid_index} 集${ep.duration ? ` · ${formatDuration(ep.duration)}` : ''}`}
                  onClick={() => onPlay(detail.series_id, ep.vid_index)}>
                  {ep.vid_index}
                  {ep.duration ? <span className="episode-duration">{formatDuration(ep.duration)}</span> : null}
                </button>
              ))}
            </div>
            {episodes.length > 24 ? (
              <button className="link-btn" onClick={() => setShowAllEpisodes((prev) => !prev)}>
                {showAllEpisodes ? '收起' : `展开全部 ${episodes.length} 集`}
              </button>
            ) : null}
          </>
        ) : null}
        {related.length ? (
          <>
            <h3 className="drawer-section">相关作品</h3>
            <div className="related-row">
              {related.slice(0, 10).map((item) => (
                <button key={item.series_id} className="related-card"
                  onClick={() => (onSwitchSeries ? onSwitchSeries(item.series_id) : onPlay(item.series_id))}>
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="poster-placeholder small" />}
                  <span className="related-title">{item.season ? `第${item.season}季 ` : ''}{item.series_title}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

export function Browse({ onPlay }: { onPlay(seriesId: string, vidIndex?: number): void }) {
  const [categories, setCategories] = useState<BrowseCategory[]>([]);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.browseList>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drawerId, setDrawerId] = useState('');

  useEffect(() => {
    void api.browseCategories().then((res) => setCategories(res.categories ?? [])).catch(() => {});
  }, []);

  const load = useCallback(async (opts: { category: string; genre: string; page: number; force?: boolean }) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.browseList({ category: opts.category, genre: opts.genre || undefined, page: opts.page, force: opts.force });
      setData(result);
    } catch (err: any) {
      setError(err.message || '目录加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load({ category, genre, page }); }, [category, genre, page, load]);

  const total = data?.totalPages ?? 0;
  return (
    <section className="page">
      <header className="page-header"><h1>发现短剧</h1></header>
      <div className="chip-row" role="tablist" aria-label="分类">
        {categories.map((item) => (
          <button
            key={item.slug}
            role="tab"
            aria-selected={category === item.slug}
            className={`chip${category === item.slug ? ' selected' : ''}${item.group === 'rank' ? ' rank-chip' : ''}`}
            onClick={() => { setCategory(item.slug); setGenre(''); setPage(1); }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {data?.genres?.length ? (
        <div className="chip-row small" role="tablist" aria-label="题材">
          <button className={`chip${genre === '' ? ' selected' : ''}`} onClick={() => { setGenre(''); setPage(1); }}>全部</button>
          {data.genres.map((item) => (
            <button key={item.slug} role="tab" aria-selected={genre === item.slug}
              className={`chip${genre === item.slug ? ' selected' : ''}`}
              onClick={() => { setGenre(item.slug); setPage(1); }}>{item.label}</button>
          ))}
        </div>
      ) : null}
      {loading ? <div className="grid-skeleton" aria-label="加载中">{Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton-poster" />)}</div> : null}
      {!loading && error ? (
        <div className="empty-state">
          <p role="alert">{error}</p>
          <button className="primary-btn" onClick={() => void load({ category, genre, page, force: true })}>重试</button>
        </div>
      ) : null}
      {!loading && data && data.success === false ? <div className="empty-state"><p role="alert">{data.error}</p></div> : null}
      {!loading && data?.unsupported ? <div className="empty-state"><p>{data.emptyMessage}</p></div> : null}
      {!loading && data?.results?.length === 0 ? (
        <div className="empty-state">
          <p>{data.emptyMessage || '本页暂无内容'}</p>
          <button className="primary-btn" onClick={() => void load({ category, genre, page, force: true })}>重新加载</button>
        </div>
      ) : null}
      {!loading && data?.results?.length ? (
        <>
          <div className="card-grid">
            {data.results.map((item) => <SeriesCard key={item.series_id} item={item} onOpen={(card) => setDrawerId(card.series_id)} />)}
          </div>
          {total > 1 ? (
            <nav className="pagination" aria-label="分页">
              <button className="secondary-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span className="muted">第 {data.page ?? page} / {total} 页</span>
              <button className="secondary-btn" disabled={page >= total} onClick={() => setPage(page + 1)}>下一页</button>
            </nav>
          ) : null}
        </>
      ) : null}
      {drawerId ? (
        <SeriesDetailDrawer seriesId={drawerId} onClose={() => setDrawerId('')}
          onSwitchSeries={(sid) => setDrawerId(sid)}
          onPlay={(sid, vidIndex) => { setDrawerId(''); onPlay(sid, vidIndex); }} />
      ) : null}
    </section>
  );
}

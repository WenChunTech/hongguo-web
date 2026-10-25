// 观看记录：续播入口 + 更新提示 + 删除记录。打开时服务端自动静默刷新总集数。
import { useCallback, useEffect, useState } from 'react';
import { api, type HistoryRow } from '../api';
import { formatPublished } from './Browse';
import { SeriesDetailDrawer } from './Browse';

export function formatPlaybackTime(seconds: number) {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function WatchHistory({ onPlay }: { onPlay(seriesId: string, vidIndex?: number): void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState('');
  const [drawerId, setDrawerId] = useState('');

  const load = useCallback(async (force = false) => {
    try {
      const data = await api.watchHistory(force);
      setRows(data.results ?? []);
      setError('');
    } catch (err: any) {
      setError(err.message || '观看记录加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="page">
      <header className="page-header">
        <h1>观看记录</h1>
        <button className="secondary-btn" onClick={() => void load(true)}><span>↻ 刷新更新</span></button>
      </header>
      {error ? <div className="empty-state"><p role="alert">{error}</p></div> : null}
      {rows === null && !error ? <p className="muted">正在加载…</p> : null}
      {rows && rows.length === 0 ? (
        <div className="empty-state"><p>还没有观看记录。播放任意一集后这里会出现续播入口。</p></div>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="history-list">
          {rows.map((row) => (
            <li key={row.series_id} className="history-row">
              <button className="history-main" onClick={() => onPlay(row.series_id, row.vid_index)}>
                {row.cover ? <img src={row.cover} alt="" loading="lazy" /> : <div className="poster-placeholder small" />}
                <span className="history-text">
                  <span className="history-title">
                    {row.series_title}
                    {row.hasUpdates ? <span className="update-badge">有更新</span> : null}
                    {row.completed ? <span className="done-badge">已看完</span> : null}
                  </span>
                  <span className="muted">
                    看到 {row.vid_index} 集 · {formatPlaybackTime(row.currentTime)}
                    {row.total ? ` · 共 ${row.total} 集` : ''}
                    {row.unreadEpisodes > 0 ? ` · ${row.unreadEpisodes} 集未看` : ''}
                  </span>
                  {row.lastCheckError ? <span className="muted small-text">刷新失败：{row.lastCheckError}</span> : null}
                </span>
                <span className="history-time">{formatPublished(row.updatedAt)}</span>
              </button>
              <div className="history-actions">
                <button className="secondary-btn" onClick={() => setDrawerId(row.series_id)}>选集</button>
                <button className="danger-btn" onClick={async () => {
                  await api.removeWatchHistory(row.series_id).catch(() => {});
                  setRows((prev) => (prev ? prev.filter((item) => item.series_id !== row.series_id) : prev));
                }}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {drawerId ? <SeriesDetailDrawer seriesId={drawerId} onClose={() => setDrawerId('')} onPlay={(sid, idx) => { setDrawerId(''); onPlay(sid, idx); }} /> : null}
    </section>
  );
}

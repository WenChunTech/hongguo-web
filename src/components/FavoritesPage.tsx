// 收藏与上新：本机收藏 + 按首次公开时间排序的「上新」分组。
import { useEffect, useState } from 'react';
import { readLibrary, setFavorite, subscribeLibrary, type LibraryEntry } from '../localLibrary';
import { formatPublished } from './Browse';

export function FavoritesPage({ onPlay }: { onPlay(seriesId: string, vidIndex?: number): void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>(readLibrary);

  useEffect(() => subscribeLibrary(() => setEntries(readLibrary())), []);

  const favorites = entries.filter((item) => item.favorite);
  const byNew = [...favorites].sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));

  return (
    <section className="page">
      <header className="page-header"><h1>收藏与上新</h1></header>
      {favorites.length === 0 ? (
        <div className="empty-state">
          <p>还没有收藏。在「发现短剧」或「搜索」的详情抽屉里点「收藏」，这里就会出现。</p>
        </div>
      ) : (
        <>
          <h2 className="block-title">上新（按首次公开时间）</h2>
          <ul className="release-list">
            {byNew.slice(0, 8).map((item) => (
              <li key={item.id} className="history-row">
                <button className="history-main" onClick={() => onPlay(item.id)}>
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="poster-placeholder small" />}
                  <span className="history-text">
                    <span className="history-title">{item.title}</span>
                    <span className="muted">{item.published_at ? `首次公开 ${formatPublished(item.published_at)}` : '公开时间未知'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <h2 className="block-title">全部收藏（{favorites.length}）</h2>
          <div className="card-grid">
            {favorites.map((item) => (
              <article key={item.id} className="card">
                <button className="poster-btn" onClick={() => onPlay(item.id)}>
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="poster-placeholder" />}
                  <span className="card-title">{item.title}</span>
                </button>
                <button className="link-btn remove-btn" onClick={() => setFavorite({
                  id: item.id, title: item.title, cover: item.cover, published_at: item.published_at,
                }, false)}>取消收藏</button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

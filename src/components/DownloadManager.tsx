// 下载管理：任务进度（轮询）+ 取消 + 已下载文件浏览（按剧分组）。
import { useCallback, useEffect, useState } from 'react';
import { api, type DownloadTaskInfo } from '../api';

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '排队中', downloading: '下载中', completed: '已完成', failed: '失败', skipped: '已存在',
};

export function DownloadManager({ onPlay }: { onPlay(seriesId: string, vidIndex?: number): void }) {
  const [tasks, setTasks] = useState<DownloadTaskInfo[]>([]);
  const [groups, setGroups] = useState<{ series: string; files: { file: string; path: string; size: number; mtime: number }[] }[]>([]);
  const [error, setError] = useState('');
  const hasRunning = tasks.some((task) => task.status === 'running');

  const load = useCallback(async () => {
    try {
      const [taskData, fileData] = await Promise.all([api.downloads(), api.downloadFiles()]);
      setTasks(taskData.tasks ?? []);
      setGroups(fileData.groups ?? []);
      setError('');
    } catch (err: any) {
      setError(err.message || '下载信息加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有进行中的任务时 1.5s 轮询（对齐参考项目）
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [hasRunning, load]);

  return (
    <section className="page">
      <header className="page-header"><h1>下载管理</h1></header>
      {error ? <div className="empty-state"><p role="alert">{error}</p></div> : null}
      {tasks.length === 0 && groups.length === 0 && !error ? (
        <div className="empty-state">
          <p>还没有下载任务。在剧集详情抽屉里点「下载」创建任务（支持 1-30,5 这样的区间语法）。</p>
        </div>
      ) : null}
      {tasks.length ? (
        <>
          <h2 className="block-title">任务</h2>
          <ul className="download-task-list">
            {tasks.map((task) => {
              const completed = task.episodes.filter((ep) => ep.status === 'completed' || ep.status === 'skipped').length;
              const failed = task.episodes.filter((ep) => ep.status === 'failed').length;
              const percent = Math.round((completed / Math.max(1, task.episodes.length)) * 100);
              const current = task.episodes.find((ep) => ep.status === 'downloading');
              return (
                <li key={task.id} className="download-task">
                  <div className="download-task-head">
                    <button className="link-btn" onClick={() => onPlay(task.seriesId)}>
                      {task.seriesTitle}
                    </button>
                    <span className="muted">
                      {task.status === 'running' ? `下载中 ${completed}/${task.episodes.length} 集`
                        : task.status === 'completed' ? `已完成 ${completed} 集${failed ? ` · 失败 ${failed}` : ''}`
                        : '已取消'}
                      {current ? ` · 正在第 ${current.vid_index} 集` : ''}
                    </span>
                    {task.status === 'running' ? (
                      <button className="danger-btn" onClick={async () => { await api.cancelDownload(task.id).catch(() => {}); void load(); }}>取消</button>
                    ) : null}
                  </div>
                  <div className="download-progress"><div className="download-progress-fill" style={{ width: `${percent}%` }} /></div>
                  {failed ? (
                    <p className="muted small-text">
                      失败集：{task.episodes.filter((ep) => ep.status === 'failed').map((ep) => ep.vid_index).join('、')}
                      （可重新创建任务补齐，已完成的集会自动跳过）
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {groups.length ? (
        <>
          <h2 className="block-title">已下载（server/data/downloads/）</h2>
          <ul className="downloaded-groups">
            {groups.map((group) => (
              <li key={group.series} className="downloaded-group">
                <h3 className="downloaded-series">{group.series}</h3>
                <div className="downloaded-files">
                  {group.files.map((file) => (
                    <span key={file.file} className="downloaded-file" title={file.path}>
                      {file.file} · {formatSize(file.size)}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

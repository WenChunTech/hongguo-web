// 线性图标集合（与桌面端 icons.jsx 同风格的简化移植）。
const paths: Record<string, React.ReactNode> = {
  play: <path d="M8 5.5v13l11-6.5z" />,
  pause: <path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" />,
  backward: <path d="M11 6v12L3.5 12zM20 6v12l-7.5-6z" />,
  forward: <path d="M4 6l7.5 6L4 18zM13 6l7.5 6L13 18z" />,
  danmaku: <path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm3 4h10v1.6H7zm0 4h6.5v1.6H7z" />,
  settings: <path d="M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6zm8.4 3.4c0-.6-.1-1.2-.2-1.7l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-3-1.7L14.5 2h-5l-.4 2.7a7.6 7.6 0 0 0-3 1.7l-2.3-1-2 3.4 2 1.5a8 8 0 0 0 0 3.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 3 1.7l.4 2.7h5l.4-2.7a7.6 7.6 0 0 0 3-1.7l2.3 1 2-3.4-2-1.5c.1-.5.2-1.1.2-1.7z" opacity=".9" />,
  list: <path d="M4 6h16v1.8H4zm0 5h16v1.8H4zm0 5h16v1.8H4z" />,
  autoNext: <path d="M4 6l8 6-8 6zM13 6l6.5 4.9V6H21v12h-1.5v-4.9L13 18z" />,
  expand: <path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 0h2v5h-5v-2h3z" />,
  shrink: <path d="M9 4v5H4V7h3V4zm6 0h2v3h3v2h-5zM4 15h5v5H7v-3H4zm11 0h5v2h-3v3h-2z" />,
  more: <path d="M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />,
  volume: <path d="M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />,
  mute: <path d="M4 9v6h4l5 4V5L8 9zm16.2-1.2-1.4-1.4L16 9.2l-2.8-2.8-1.4 1.4L14.6 11l-2.8 2.8 1.4 1.4L16 12.4l2.8 2.8 1.4-1.4L17.4 11z" />,
  heart: <path d="M12 20.3-1.2-9.3C-2.6 9.7-2 6.6.4 5.2c2.3-1.4 5.2-.6 6.6 1.7L8 8.6l1-1.7C10.4 4.6 13.3 3.8 15.6 5.2c2.4 1.4 3 4.5 1.6 5.8z" style={{ display: 'none' }} />,
  search: <path d="M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm4.8 9.7 5 5-1.4 1.4-5-5z" />,
  refresh: <path d="M12 4a8 8 0 1 1-7.7 10.2l1.9-.5A6 6 0 1 0 12 6v3L7.5 5.5 12 2z" />,
  trash: <path d="M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z" />,
  home: <path d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z" />,
  library: <path d="M5 4h4v16H5zm5.5 0h4v16h-4zM16.4 4.6l3.8 1-4.1 15.5-3.8-1z" />,
  history: <path d="M12 4a8 8 0 1 1-7.4 11l1.9-.6A6 6 0 1 0 12 6c-1.8 0-3.4.8-4.5 2H10v2H4V4h2v2.4A8 8 0 0 1 12 4zm-.7 4h1.6v4.3l3.3 2-.9 1.5-4-2.4z" />,
  star: <path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z" />,
  gear: <path d="M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6zm8.4 3.4c0-.6-.1-1.2-.2-1.7l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-3-1.7L14.5 2h-5l-.4 2.7a7.6 7.6 0 0 0-3 1.7l-2.3-1-2 3.4 2 1.5a8 8 0 0 0 0 3.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 3 1.7l.4 2.7h5l.4-2.7a7.6 7.6 0 0 0 3-1.7l2.3 1 2-3.4-2-1.5c.1-.5.2-1.1.2-1.7z" />,
  download: <path d="M11 3h2v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L11 12.2zM4 19h16v2H4z" />,
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      {paths[name] ?? null}
    </svg>
  );
}

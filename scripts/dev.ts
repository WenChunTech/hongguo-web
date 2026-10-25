// SPDX-License-Identifier: GPL-3.0-only
// 开发模式：同时启动 Bun 后端（8174）与 Vite 前端（5173，/api 与 /media 反代到后端）。
// 对应桌面端 scripts/dev.js 的双进程模型。
const SERVER_PORT = Number(process.env.PORT || 8174);
const children: ReturnType<typeof Bun.spawn>[] = [];

function spawnChild(name: string, cmd: string[], color: string) {
  const child = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PORT: String(SERVER_PORT) },
  });
  children.push(child);
  console.log(`${color}[${name}] pid=${child.pid}`);
  return child;
}

function shutdown() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

spawnChild('server', ['bun', 'run', 'server/index.ts'], '\x1b[36m');
spawnChild('vite', ['bunx', 'vite', '--port', '5173'], '\x1b[35m');

// 任一子进程退出都退出整个开发会话
const watcher = setInterval(() => {
  if (children.some((child) => child.exitCode !== null || child.signalCode !== null)) {
    clearInterval(watcher);
    shutdown();
  }
}, 1000);

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：Vite 只负责前端（5173），/api 与 /media 代理到 Bun 后端（默认 8174）。
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8174', changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8174', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

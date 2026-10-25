# syntax=docker/dockerfile:1
# 红果短剧 Web —— 多阶段最小化镜像（GPL-3.0）
#
# 搜索已改为纯 HTTP 签名接口（无需无头浏览器），镜像不再包含 Chromium：
#   docker build -t hongguo-web .
#   docker run -d -p 8174:8174 -v hongguo-data:/app/server/data hongguo-web

# ── 阶段 1：构建前端产物 ─────────────────────────────────────────────
FROM oven/bun:1-alpine AS build
WORKDIR /app
# 先装依赖再拷源码，充分利用层缓存
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN bun run build

# ── 阶段 2：运行时 ──────────────────────────────────────────────────
# 运行期零 npm 依赖：server/ 只使用 Bun 与 Node 内置模块，无需 node_modules。
FROM oven/bun:1-alpine AS runtime
RUN apk add --no-cache tini

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY package.json ./

# 数据目录（data.json / device-id.json / danmaku-client.json / online-cache / downloads）
# 建议挂卷持久化
RUN mkdir -p /app/server/data && chown -R bun:bun /app/server/data
# 服务器必须监听 0.0.0.0 才能在容器外访问
ENV HOST=0.0.0.0 \
    PORT=8174 \
    HG_DATA_DIR=/app/server/data
USER bun
EXPOSE 8174
VOLUME /app/server/data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c 'wget -q -O /dev/null "http://127.0.0.1:${PORT:-8174}/api/browse-categories" || exit 1'
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "server/index.ts"]

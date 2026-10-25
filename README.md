# 红果短剧 Web 播放器

以 [hongguo-drama](../hongguo-drama)（Electron 桌面端）为参考实现的**独立 Web 版**项目，
用 TypeScript + Vite + React + React DOM + Bun 复刻桌面端的在线播放体验。
GPL-3.0 开源，仅供学习交流，请支持官方 App。

```
浏览器 (React + TS, Vite 构建)
   │  /api/*      内容接口（分类/搜索/详情/弹幕/进度…）
   │  /media/*    视频流（Range / 解密缓存）
   ▼
Bun 服务器（承担桌面端 Electron 主进程角色）
   ├─ lib/hongguo.ts      官网 SSR 取源 → App 签名接口 → 旧 API（三级回退链）
   ├─ lib/app-source.ts   App 签名（X-Gorgon/X-Argus/X-Ladon/X-Helios/X-Medusa）+ spade 解密
   ├─ lib/stream.ts       在线播放会话：明文流式转发 / 加密整集下载+纯 JS CENC 解密落盘
   ├─ lib/danmaku*.ts     官方分时弹幕（SM3 签名，设备标识持久化）
   ├─ lib/catalog.ts      官网分类/榜单（_ROUTER_DATA 解析）
   ├─ lib/search.ts       关键词搜索：本机 Chrome 无头渲染嗅探（对应桌面端隐藏窗口）
   └─ lib/store.ts        data.json（剧集档案/播放进度/设置，原子写入）
```

## 快速开始

依赖：[Bun](https://bun.sh) ≥ 1.1（搜索/联想/详情/下载全部走纯 HTTP 签名接口，**无浏览器依赖**）。

```bash
bun install

# 开发模式：Bun 后端(8174) + Vite 前端(5173，已配置 /api 与 /media 反代)
bun run dev

# 生产模式：构建后单进程托管前端与接口
bun run build
bun run start          # http://127.0.0.1:8174

# 类型检查
bun run check
```

环境变量：`PORT`（默认 8174）、`HOST`（默认 127.0.0.1）、`HG_DATA_DIR`（数据目录，默认
`server/data/`）、`HG_CHROME`（搜索用浏览器路径）。

## 打包（Docker）

多阶段构建，基础镜像 `oven/bun:1-alpine`：阶段 1 用 Bun 装依赖并执行 Vite 构建；阶段 2 只拷入
`dist/` 与 `server/` —— **运行期零 npm 依赖**（服务端只用 Bun 与 Node 内置模块，无需 node_modules）。

```bash
# 镜像不再包含无头浏览器（搜索为纯 HTTP 签名接口），实测约 130MB
docker build -t hongguo-web .
docker run -d -p 8174:8174 -v hongguo-data:/app/server/data hongguo-web
# 或用 compose（数据卷已配置）
docker compose up -d
```

### CI：GitHub Actions 自动构建镜像

每次提交（任意分支 push）、`v*` 标签、手动触发时，`.github/workflows/docker-publish.yml`
会构建镜像并发布到 GHCR（用内置 `GITHUB_TOKEN`，无需配置任何 Secret）：

```bash
# 拉取（首次发布后需在仓库 Packages 设置里把包改为 Public，或 docker login ghcr.io）
docker pull ghcr.io/wenchuntech/hongguo-web:latest
docker run -d -p 9001:8174 -v hongguo-data:/app/server/data ghcr.io/wenchuntech/hongguo-web:latest
```

标签规则：默认分支 → `latest`；各分支 → 分支名；`v*` 标签 → `1.2.3` / `1.2`；所有构建 → `sha-<短哈希>`。
构建缓存走 GHA cache，重复提交构建约 1-2 分钟。

容器要点：

- 服务器监听 `0.0.0.0:8174`（`HOST`/`PORT` 环境变量可覆盖）；`tini` 作为 PID 1 回收无头浏览器
  退出后的僵尸进程；
- 播放进度/剧集档案/弹幕设备标识/在线缓存放在 `/app/server/data`，请挂卷持久化（compose 已配置）；
- 镜像内置 `HEALTHCHECK`（探活 `/api/browse-categories`；Podman 的 OCI 格式会忽略该指令，Docker 正常）；
- 已在容器内实测：分类接口、搜索（无头 Chromium 约 6.5s 返回）、取源解密（18.4MB）、Range 流媒体
  全部可用。

体积说明：镜像为 `oven/bun:1-alpine` + 应用产物（运行期零 npm 依赖），约 130MB。
历史上搜索依赖无头 Chromium（镜像 917MB）；改为签名搜索接口后浏览器依赖已彻底移除。


## 与桌面端的功能对照

| 功能 | 桌面端 | Web 版 | 说明 |
| --- | --- | --- | --- |
| 发现短剧（分类/榜单/题材/分页） | ✅ | ✅ | 同一 SSR 解析实现 |
| 详情抽屉（评分/剧评/公开信息） | ✅ | ✅ | 评分、点赞/收藏数、首次公开时间；另有签名接口补充的**热度/追剧数/播放量/备案号/剧情简介**（video_detail/v1） |
| 分集时长角标 | ✅ | ✅ | 取源详情接口的 video_list[].duration |
| 相关作品 + 剧终接下一季 | ✅ | ✅ | plan/v 拉相关作品；本季播完自动接入季数更大的下一季第 1 集（binge-relay） |
| 服务端批量下载 | ✅ | ✅ | 区间语法选集（1-30,5，移植桌面端）、并发 2、.part 防损改名、任务进度/取消、按剧分组文件列表、重跑幂等（已完成集自动跳过） |
| 关键词搜索 | ✅ 隐藏窗口嗅探 | ✅ App 签名搜索接口 | 参考 it00021hot/hongguo-desktop 与 sunnysky123/hongguo-web 的实测移植：`search/tab/v`（持久化 device_id + 五头签名 + 节流 + 空 body=风控判定）；官网 SSR `searchList` 与联想词条作兜底，**无浏览器依赖** |
| 搜索联想（下拉直拨） | ➖ | ✅ | `search/suggest/v`：≥2 字 300ms 防抖、键盘 ↑↓/Enter/Esc、输入法组合保护；命中剧集条目一键直进播放器（it00021hot 同款） |
| 搜索分页 + 富字段 | ✅ | ✅ | passback/search_id 游标翻页；评分/播放量/热度标签；综合搜索 0 条时用联想剧集词条兜底 |
| 分享链接 / 剧集 ID 解析 | ✅ | ✅ | 跟随 ≤5 跳 30x，多策略提取 series_id |
| 在线播放（三级取源回退链） | ✅ | ✅ | 官网 Web → App 签名 → 旧 preload API |
| 加密片源播放（CENC） | ✅ FFmpeg/worker 解密 | ✅ 纯 JS 解密落盘 | spade_a/contentKey 两种密钥派生 |
| Range 拖动 / 流式播放 | ✅ 自定义协议 | ✅ `/media/:id` | 明文源透传 Range，加密源整集缓存后服务 |
| 在线缓存（300MB LRU） | ✅ | ✅ | 解密产物暂存 `server/data/online-cache/` |
| 断点续播 + 续播提示 | ✅ | ✅ | 服务端 data.json，跨浏览器会话 |
| 连播 / 自动下一集 | ✅ | ✅ | 播完自动切下一集并记录看完 |
| 预缓存下一集 | ✅ | ✅ | 播放 5 秒后触发 prefetch |
| 清晰度（自动/720P/1080P） | ✅ | ✅ | 切换保留进度；不满足时**不静默降级** |
| 倍速（点击 +0.25 循环 / 16 档精调） | ✅ | ✅ | |
| 控件自动隐藏（1s 空闲 + screenX/Y 位移判定） | ✅ | ✅ | 含桌面端 3.0 的「鼠标回入原位置」修复 |
| 快捷键（空格/←→/↑↓/A/S/D/F） | ✅ | ✅ | 同键位、同存储键、可自定义、冲突校验；均仅播放页在前台时响应 |
| 切页时的播放行为 | 后台继续播 | **离开播放页自动暂停** | Web 版按用户选择做了差异：切走暂停（保存进度），回来手动点播放继续 |
| 弹幕（官方分时真弹幕） | ✅ | ✅ | SM3 签名移植；设备标识持久化保证子集稳定 |
| 弹幕兜底（本集评论） | ✅ | ✅ | 官方弹幕失败时可在设置中切换 |
| 弹幕设置（来源/透明度/字号/速度/区域/密度/屏蔽词） | ✅ | ✅ | 与桌面端同一 localStorage 键 |
| 画面模式（适应/填满宽度，按剧记忆） | ✅ | ✅ | |
| 观看记录 + 更新提示（总集数刷新） | ✅ | ✅ | 6 小时节流、单批 ≤20；不含续作探测 |
| 收藏与上新 | ✅ | ✅ | 同一 localStorage 键 `hongguo:public-library:v1` |
| 我的剧库 | ✅ | ✅ | 服务端剧集档案，跨设备（同机）共享 |
| 外观主题（浅色/深色/跟随系统） | ✅ | ✅ | 同设计 token（DESIGN.md） |
| 移动端布局 | ➖ 桌面窗口 | ✅ | ≤980px 底部导航栏（播放页沉浸隐藏）、竖屏 9:16 舞台、横屏沉浸全宽、刘海屏安全区（safe-area） |
| 触摸手势 | ➖ 鼠标/键盘 | ✅ | 点按切换控件；双击左右 ±10s；横滑快进/快退（实时预览位移与目标时间）；左半屏纵滑亮度、右半屏纵滑音量；长按 2 倍速松手恢复 |
| 兼容模式（HEVC→H.264 转码） | ✅ FFmpeg | ❌ | 取源链已优先 H.264；HEVC-only 片源会提示失败 |
| 本地下载 / 下载管理 / 合并 | ✅ | ❌ | 浏览器场景超出范围 |
| 代理设置 / 隐身小窗 / 置顶 / 应用更新 | ✅ | ❌ | 桌面专属能力 |

## 播放链路说明

1. **取源**（`server/lib/hongguo.ts`）：优先解析官网 `/player/{sid}/{vid}` SSR 页的
   `VideoObject.contentUrl`（明文 MP4）；失败后走 App 签名接口（每请求合成设备标识、
   `_rticket` 抖动避 branch 1、域名白名单校验、`fallback_api` 二次取址）；再失败走旧
   `multi_video_model/preload` 接口。与桌面端一致，结果带 30s 缓存与 5 分钟 Web 源惩罚。
2. **传输**（`server/lib/stream.ts`）：明文片源直接流式透传（Range 透传、UA/Referer 组装、
   错误页判定、Referer 切换重试、3 轮 × 候选流恢复）；加密片源（spade_a/contentKey）整集
   下载（上限 300MB）→ 纯 JS CENC-AES-CTR 解密 + moov 重建 → 落盘缓存后按 Range 服务。
3. **播放**（前端 `src/components/Player.tsx`）：原生 `<video>`；`onLoadedMetadata` 后 seek
   到续播点并提示；错误时每集允许一次强制重连，仍失败给出明确提示与重试按钮。

## 验证边界（诚实声明）

以下结论基于 2026-10-24 在本机的实测：

**已验证**：发现/榜单/题材/分页（真实数据渲染）；详情抽屉（评分、热度/追剧数/播放量/备案号、简介、分集时长角标、相关作品）；签名搜索（12 条 + 评分/热度 + 分页游标）、搜索联想下拉（8 条、封面/摘要/直接播放）、缩略词联想兜底；分享链接解析；第 1 集取源（App 源下载解密）与 Range 拖动；断点续播；官方分时弹幕；控件自动隐藏、快捷键、倍速；观看记录；**服务端下载任务**（创建→解密→落盘 8.1MB→进度→文件列表，浏览器内端到端实测）；解密产物为合法 MP4（`ftyp isom`）；离开播放页自动暂停；Docker 容器内分类/搜索/取源/流媒体；移动端布局与触摸手势。

**未验证/已知限制**：

- App 取址用「每请求合成设备标识」绕按设备限流，**不保证所有剧集可用**；官网未开放
  （`web_available=false`）或付费锁定集可能取源失败。
- 搜索/联想/详情元信息依赖签名的 reading 族接口，device_id 需持久化稳定（已实现，
  `server/data/device-id.json`）；若被风控会自动回落官网 SSR，再失败按「没有结果」提示。
- 官网 SSR 搜索（searchList）与播放直链（main_url）在上游改版后已不可靠，仅作兜底；
  正片取源走 App 签名链路（b 域 `multi_video_model/v1` + fallback_api + key_seed 解密）。
- 弹幕接口非公开，随时可能失效；失败会如实说明并可切换「本集评论」，不会把
  「拿不到」说成「本集没有弹幕」。
- 上游每次返回的弹幕子集不同（同一集两次请求 184/595 条），属上游行为。
- 1080P 标签可能与实际不符；指定清晰度不满足时报错而非降级。
- HEVC-only 片源无法播放（无转码兜底）；解密为纯 JS 实现，超大单集（接近 300MB
  上限）耗时明显。
- 搜索依赖本机 Chrome/Chromium 无头渲染，未安装时给出明确错误。
- 长时间播放稳定性、全部浏览器（Safari/Firefox）、移动端适配未做完整回归。

## 目录结构

```
server/            Bun 后端（原 Electron 主进程职责）
  index.ts         入口：API 路由 + /media 流代理 + 静态托管
  lib/             hongguo / app-source / danmaku / catalog / search / stream / store …
src/               React 前端
  components/      Player / PlayerControls / Browse / SearchPage / WatchHistory / …
  danmaku/         弹幕引擎（model/official 移植）与图层组件
scripts/dev.ts     开发模式双进程
```

## 许可

GPL-3.0。签名/弹幕/解密算法移植自 hongguo-drama（GPL-3.0），后者又分别来自
woshishiq1/drpys 与 dawei233/hongguo-drama，各文件头部保留了原始来源说明。

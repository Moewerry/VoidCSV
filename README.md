# VoidCSV

> 大文件 CSV/XLSX 网页查看器，小文件前端预览，大文件本地引擎渐进索引。

- **小文件**：浏览器内纯前端解析预览
- **大文件**：通过本地引擎渐进索引与区间读取

## 项目结构

| 目录 | 说明 |
|------|------|
| `web/` | 前端（Vite + React） |
| `engine/` | 本地引擎（Express，`/api/*`） |
| `desktop/` | Electron 桌面版入口 |
| `docker/` | Docker 镜像与 Nginx 配置 |

## 本地开发

### 1) 安装依赖

在项目根目录执行：

```bash
pnpm install
pnpm --dir web install
pnpm --dir engine install
```

### 2) 启动

```bash
pnpm run dev
```

- 前端：`http://localhost:5173/`
- 引擎：`http://127.0.0.1:8787/`（开发期由 Vite 将 `/api/*` 代理到引擎）

### 3) 使用

打开主页 → **进入浏览器** → 选择 CSV / XLSX 文件。

## 局域网访问（开发模式）

1. 防火墙放行前端端口（默认 `5173`）。
2. 查本机 IPv4（如 `192.168.1.x`）。
3. 其他设备访问：`http://<你的IPv4>:5173/`

引擎默认只监听本机，经 Vite 代理访问，无需把 `8787` 暴露到局域网。

## Docker 部署

适合在服务器上一键启动「前端静态站 + 引擎 API」，无需本机安装 Node。

### 架构

```
浏览器 → web (Nginx :18080) → /api/* 反代 → engine (:8787)
                              → 静态资源 (web/dist)
上传文件持久化在 Docker 卷 engine-uploads
```

### 前置要求

- [Docker](https://docs.docker.com/get-docker/) 与 Docker Compose v2

### 启动

在项目根目录：

```bash
docker compose up -d --build
```

访问：**http://localhost:18080/**

> 对外端口为 `18080`（映射容器内 Nginx `80`），避免与常见 `8080` 冲突。可在 `docker-compose.yml` 中修改 `ports`。

### 常用命令

```bash
# 查看日志
docker compose logs -f

# 仅重启
docker compose restart

# 停止（保留上传卷）
docker compose down

# 停止并删除上传数据
docker compose down -v
```

### 引擎清理策略（可通过环境变量调整）

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `SESSION_MAX_AGE_MS` | 2h | 会话过期后删除上传文件 |
| `CLEANUP_INTERVAL_MS` | 10min | 清理任务间隔 |
| `FILE_MAX_AGE_MS` | 6h | 孤儿文件最大保留时间 |
| `MAX_UPLOAD_DIR_BYTES` | 4GB | 上传目录容量上限，超出后删最旧文件 |

修改方式：编辑 `docker-compose.yml` 中 `engine.environment`，然后 `docker compose up -d --build`。

## Windows 桌面版

需先安装根目录依赖（含 `electron`、`electron-builder`）：

```bash
npm install
```

构建 Windows 安装包与便携版：

```bash
npm run desktop:build
```

产物目录：`release/build/`

- 便携版：`VoidCSV 0.0.1.exe`
- 安装包：`VoidCSV Setup 0.0.1.exe`
- 免安装目录：`win-unpacked/VoidCSV.exe`

开发调试：

```bash
npm run desktop:dev
```

同步应用图标（从 `web/public/voidcsv.png` 生成 ICO）：

```bash
npm run icon:sync
```

## 生产部署（非 Docker）

典型做法：Nginx 托管 `web/dist`，并将 `/api/` 反代到本机 `engine`（`127.0.0.1:8787`），引擎用 PM2 / systemd 守护。SPA 需配置 `try_files $uri $uri/ /index.html;`。

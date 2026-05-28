# VoidCSV

使用网页方式浏览大文件 CSV（2GB+）的原型项目。

当前包含：
- `web/` 前端（首页 + Viewer，混合模式：小文件纯前端 / 大文件提示启用本地引擎）
- `engine/` 本地引擎服务（提供 `/api/*` 接口，先实现可运行的区间读取 MVP，后续再完善索引与性能）

## 启动
先安装依赖，然后启动开发环境。

### 1) 安装依赖
在项目根目录 `VoidCSV` 执行：
```bash
pnpm install
```

然后分别为 `web/` 和 `engine/` 安装依赖（因为它们各自有独立的 `package.json`）：
```bash
pnpm --dir web install
pnpm --dir engine install
```

### 2) 运行
```bash
pnpm run dev
```

开发模式下：
- 前端（Vite）：`http://localhost:5173/`
- 本地引擎（Express）：`http://127.0.0.1:8787/`（前端会自动通过 `/api/*` 代理访问）

### 3) 使用
- 打开前端主页，点击 `进入浏览器`
- 选择 CSV 文件：小文件走纯前端预览；大文件会弹提示启用本地引擎

## 局域网访问
1. 确保防火墙允许入站访问前端端口（默认 `5173`）。
2. 在运行 `pnpm run dev` 的机器上，查找你的 IPv4 地址（例如 `192.168.1.x`）。
3. 局域网其他设备用浏览器打开：
   - `http://<你的IPv4>:5173/`

说明：当前前端对 `/api/*` 的请求仍通过 Vite 代理转发到本机引擎（引擎默认只监听 `127.0.0.1`），因此无需把引擎端口开放到局域网。

## Docker 启动
在项目根目录 `VoidCSV` 执行：

```bash
docker compose up -d --build
```

启动后访问：
- `http://localhost:18080/`

常用命令：

```bash
# 查看日志
docker compose logs -f

# 停止并删除容器（保留上传数据卷）
docker compose down

# 停止并删除容器 + 数据卷（会清空 uploads）
docker compose down -v
```


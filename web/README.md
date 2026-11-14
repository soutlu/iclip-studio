# 前端（Web）

基于 Vite + React 的单页应用（SPA），核心技术栈为 TanStack Router、TanStack Query 和 Tailwind CSS（依赖版本见 [package.json](package.json)）。

- 完整前后端本地联调步骤见[本地启动](../docs/deploy.md#本地启动)
- 前端日常命令、目录职责与验证要求见 [AGENTS.md](AGENTS.md)

## 启动参数

在 `web/` 目录下执行 `pnpm dev`，默认监听 `0.0.0.0:3013`，并将 `/api` 请求通过同源代理转发给本地后端 `http://127.0.0.1:7788`。

### 自定义端口与代理目标

可以通过命令行环境变量覆盖监听地址、端口或后端地址（注意：`VITE_BACKEND_PROXY_TARGET` 只从命令行环境变量读取，不读 `.env` 文件）：

```bash
HOST=127.0.0.1 PORT=3015 VITE_BACKEND_PROXY_TARGET=http://127.0.0.1:7789 pnpm dev
```

### 成片预览的预览域名

成片编辑器的预览在预览域名下的预览页（`/whole-film-preview.html`）里运行（规则见 [conventions「成片工程与预览域名」](../contract/conventions.md#成片工程与预览域名)）。本机用 `localhost` 和 `127.0.0.1` 当作两个站点，端口相同，开发服务器在两个主机名下都能访问：

- **`pnpm dev`**：用哪个主机名打开应用，就把根目录 `.env` 里的 `WHOLE_FILM_PREVIEW_ORIGIN` 设成另一个，例如在 `http://localhost:3013` 打开时设成 `http://127.0.0.1:3013`。不配置时成片编辑器的预览无法加载。
- **`pnpm dev:mock`**：不用配置。预览页自动放在另一个主机名下，预览页取应用来源的地址由 mock 模式的开发服务器回答。

### 成片组件库与 Mock 模式

- **指定正式组件库**：`pnpm dev` 启动前默认会把仓库自带的测试组件库打包到 `public/hyperframes/`；如果需要加载本地的正式成片组件库，可指定 `HYPERFRAMES_LIBRARY=<组件库源目录> pnpm dev`。
- **纯前端 Mock 模式（`pnpm dev:mock`）**：不连接真实后端，使用 MSW 模拟数据。在主目录运行时默认端口为 `3014`，在 Git Worktree 中运行时会根据路径自动分配 `3100–3899` 之间的固定端口（启动日志会打印实际地址，也可通过 `PORT=3015 pnpm dev:mock` 手动指定）。

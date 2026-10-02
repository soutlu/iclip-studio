# 前端

Vite + React SPA，使用 TanStack Router、TanStack Query 和 Tailwind CSS。依赖及版本见 [package.json](package.json)。整套联调从[仓库 README](../README.md#启动指南)开始；前端命令、目录职责与验证要求见 [AGENTS.md](AGENTS.md)。

## 启动参数

在 `web/` 执行 `pnpm dev`，默认监听 `0.0.0.0:3013`，经同源代理连接 `http://127.0.0.1:7788`。监听地址、端口和后端目标通过 shell 环境变量指定：

```bash
HOST=127.0.0.1 PORT=3015 VITE_BACKEND_PROXY_TARGET=http://127.0.0.1:7789 pnpm dev
```

`VITE_BACKEND_PROXY_TARGET` 不从 `.env` 文件读取。`pnpm dev:mock` 固定使用 `mock` mode 和端口 3014，不连接后端；需要自定义 mock 端口时运行 `VITE_MODE=mock PORT=3015 pnpm dev`。

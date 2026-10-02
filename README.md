# Productor — iclip-studio

Productor 的后端与 Web 前端。产品定位、业务术语和不变量见 [docs/CONTEXT.md](docs/CONTEXT.md)，开发约定与文档地图见 [AGENTS.md](AGENTS.md)。

## 启动指南

1. 安装 Python、uv、Node.js、pnpm，准备可连接的 PostgreSQL；版本以 [server/pyproject.toml](server/pyproject.toml)、[web/package.json](web/package.json) 与各自 lockfile 为准。Agent 挂载 `shot_video` 或启用视频编辑时，PATH 中还需有 `ffmpeg` 和 `ffprobe`。然后执行 `make setup`。
2. 在仓库根目录创建 `.env`，数据库指向开发库，密钥不入库。必需变量与各能力的启用条件见[配置模型](server/src/iclip/config/models.py)与[配置与装配](docs/architecture.md#2-配置与装配)；启动时会列出缺失的变量名。
3. 把一份 `server/configs/`（`config.yaml`）与 `server/agents/`（`agents.yaml`、各 agent 目录、`skills/`）放到本机，两者不进仓库，改动保存即生效（见[改配置](#改配置)）。默认的 `storyboard` Agent 需要视频理解、媒体生成与对象存储；只跑基础对话时，去掉这条 Agent 声明与 `config.yaml` 的 `video`、`shot_video` 段，另声明一条不挂这些能力的 Agent。
4. 迁移并启动后端（已有数据库先备份）：

   ```bash
   make db-upgrade
   make dev          # http://localhost:7788，健康检查 /healthz
   ```

5. 另开终端启动前端：

   ```bash
   cd web && pnpm dev   # http://localhost:3013，同源 /api 代理到后端
   ```

   只验证前端时用 `pnpm dev:mock`，不连后端；端口与代理目标见[前端启动参数](web/README.md#启动参数)。

## 部署

单机部署用 [deploy/compose.yaml](deploy/compose.yaml)：一次性迁移 → 后端 → 前端，镜像从 ACR 拉取，构建与上传见[镜像发布](docs/release.md)。

1. Postgres 用服务器现有实例，本项目独占一个库。以管理员建库建账号：

   ```sql
   CREATE ROLE iclip LOGIN PASSWORD '<密码>';
   CREATE DATABASE iclip OWNER iclip;
   ```

2. 服务器上建一个目录，放入 `compose.yaml`、`.env`（镜像与端口变量见 compose.yaml 文件头，应用变量见[配置模型](server/src/iclip/config/models.py)，`DATABASE_URL` 指向上面的库），以及 `configs/`、`agents/` 两个目录（后端只读挂载，镜像里没有）。
3. 拉取并启动：

   ```bash
   docker login <ACR_REGISTRY>   # 与 .env 的 ACR_REGISTRY 相同
   docker compose pull && docker compose up -d
   curl http://localhost/api/healthz
   ```

4. 首个管理员：SSO 场景在 `.env` 设置 `ROOT_EMAIL`，该邮箱首次登录即 root；密码注册场景执行 `docker compose run --rm server python -m scripts.admin set-roles <账号> root,editor`。

后端只跑 1 个 worker，实时订阅在进程内存中。升级：改 `.env` 的 `IMAGE_TAG`，再 `docker compose pull && docker compose up -d`；迁移随启动执行，数据卷保留。

### 改配置

模型、agent、skill 与参考资料只在服务器的 `configs/`、`agents/` 里，不随镜像发版；改文件保存即生效，机制见[配置与装配](docs/architecture.md#2-配置与装配)。写错的原因在 `docker compose logs server` 与 `/healthz` 的 `config` 段；手动重载：`docker compose kill -s HUP server`。

只有两种情况要执行 `docker compose up -d`（`restart` 不重读 `.env`）：改了 `models` 与 agents 以外的配置段（`/healthz` 会标 `needs_restart`），或 `.env` 新增了变量（如新模型用新的 key 变量）。

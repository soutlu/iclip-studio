# 本地启动与服务器部署指南

本文说明如何在本地开发环境跑起整套服务，以及线上服务器的首次部署、日常升级和配置维护。Docker 镜像的构建与发布流程见[发版与镜像发布](release.md)。

## 本地启动

### 1. 安装基础工具与依赖
- 安装 Python、uv、Node.js 和 pnpm（具体版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 及各自的 lockfile 为准），并准备一个本地可连接的 PostgreSQL 数据库。
- 如果需要使用视频抽帧出图（`shot_video`）、视频剪辑合成或参考视频拆解功能，请确保系统 `PATH` 中已安装 `ffmpeg` 和 `ffprobe`。
- 在仓库根目录执行以下命令安装前后端依赖：
  ```bash
  make setup
  ```

### 2. 配置环境变量（`.env`）与配置文件（`server/configs/`）
- 在仓库根目录创建 `.env` 文件（所有配置项说明见[配置模型](../server/src/iclip/config/models.py)与[后端的配置与装配](architecture.md#后端的配置与装配)，缺少必填项时服务启动会直接报错并列出缺失的变量名）：

  | 环境变量名 | 是否必填 | 用途与填写说明 |
  |---|---|---|
  | `DATABASE_URL` | 必填 | 本地开发数据库连接串（例如 `postgresql+asyncpg://...`） |
  | `CREDENTIAL_ENCRYPTION_KEYS` | 必填 | 运行时用来加密模型 API Key 和 MCP 请求头的 Fernet 密钥。生成命令：<br>`uv run --project runtime python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
  | `RUNTIME_URL` | 必填 | 运行时服务地址，本地开发填 `http://localhost:7790`（见[调运行时](architecture.md#调运行时)） |
  | `RUNTIME_APP_KEY` | 必填 | 视频后端访问运行时的密钥（不少于 32 个字符，与 `runtime.yaml` 中 `apps.video.key_env` 对应） |
  | `RUNTIME_INTERNAL_TOKEN` | 必填 | 运行时回调后端、以及视频插件调用后端内部接口共用的令牌（不少于 32 个字符） |
  | `WHOLE_FILM_RENDER_URL` | 可选 | 本地需要调试「成片导出」功能时，设为 `http://localhost:8080` |

- 准备两份本地配置文件（均不入 Git 仓库，修改后需重启服务）：
  1. `server/configs/config.yaml`：视频后端运行配置。
  2. `server/configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制一份，将里面的 `http://server:7788` 全部替换成 `http://localhost:7788`，并按需开启要用到的插件配置段。

### 3. 执行数据库迁移并启动后端服务
```bash
make db-upgrade   # 执行后端与运行时两边的 Alembic 数据库迁移（如果库里已有重要数据请先备份）
make dev          # 先启动视频后端 (:7788)，健康检查通过后自动启动运行时服务 (:7790)
```
- **已有的本地库**：运行时的迁移报表已存在时，说明这个库还没打基线标记，见[升级](#升级)第 2 步；本地在 `server/` 目录下用 `uv run --env-file ../.env python -m agent_runtime.admin stamp-baseline` 执行。
- **初始化后台配置**：新库刚启动时还没有任何模型和 Agent。请使用 root 账号登录网页后台，在「配置页」中接入模型供应商、创建并发布技能与 Agent（如果需要用到视频理解、参考视频拆解或自动打标功能，请按下方[服务器部署](#服务器部署)第 6 步接入火山方舟）。

### 4. 启动前端开发服务（另开终端）
```bash
cd web && pnpm dev   # 访问 http://localhost:3013，/api 请求会自动代理到本地后端
```
- 如果只想看纯前端界面、不连接真实后端，可以运行 `pnpm dev:mock`。更多启动参数见[前端启动参数](../web/README.md#启动参数)。

### 5. 启动成片渲染服务（可选，另开终端）
本地需要测试导出成片时（需同时配好 OSS 与媒体生成），新开一个终端启动 `render/` 服务：
```bash
cd render && RENDER_ALLOWED_MEDIA_HOSTS=<允许下载的素材域名> RENDER_REGISTRY_ROOT=../web/public/hyperframes pnpm dev
```
- 渲染服务依赖无头浏览器 `chrome-headless-shell`（默认从 `~/.cache/puppeteer` 查找，可通过环境变量 `PRODUCER_HEADLESS_SHELL_PATH` 指定路径，版本号见 [render/Dockerfile](../render/Dockerfile)），详情见 [config.ts](../render/src/config.ts)。

---

## 服务器部署

线上单机部署使用 [deploy/compose.yaml](../deploy/compose.yaml)，通过 Docker Compose 同时编排 `server`（视频后端）、`runtime`（Agent 运行时）、`web`（前端与 Nginx 反代）和 `render`（成片渲染）四个容器。注意：后端与运行时均固定运行 1 个 Worker 进程（原因见[两个服务](architecture.md#1-两个服务)）。

### 1. 安装宿主机显卡驱动
- 在宿主机安装 NVIDIA 显卡驱动与 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)（需包含 EGL / OpenGL 图形库，供 `render` 容器启用硬件渲染）。
- 如果服务器没有独立显卡，请删掉 `compose.yaml` 中 `server` 和 `render` 下面的 `deploy` 显卡申请配置，服务会自动回退使用 CPU 软件编解码与软件渲染。

### 2. 创建数据库与专属账号
在服务器的 PostgreSQL 中为本项目创建独立的数据库和账号：
```sql
CREATE ROLE iclip LOGIN PASSWORD '<密码>';
CREATE DATABASE iclip OWNER iclip;
```

### 3. 准备服务器部署目录
在服务器上新建部署目录，放入以下文件与子目录：
- `compose.yaml`：从仓库 `deploy/compose.yaml` 复制。
- `.env`：配置镜像版本号 `IMAGE_TAG`、对外端口、`DATABASE_URL`、OSS 凭证以及运行时所需的四个核心变量（`RUNTIME_URL=http://runtime:7790`、`RUNTIME_APP_KEY`、`RUNTIME_INTERNAL_TOKEN`、`CREDENTIAL_ENCRYPTION_KEYS`）。
  - **重要提醒**：请将 `CREDENTIAL_ENCRYPTION_KEYS` 与数据库备份分开妥善保管；一旦丢失，数据库里已保存的所有模型 API Key 和 MCP 配置都将无法解密，只能重新录入。
  - 如果服务器是与 OSS 同地域的阿里云 ECS，建议配置 `OSS_INTERNAL_ENDPOINT` 走内网高速读写；
  - 如需开启视频超分（高清版），配置 `VIDEO_ENHANCE_SUBMIT_URL` 并在 `config.yaml` 中配置 `media_generation.video.enhance`；
  - 如需开启成片导出，配置 `WHOLE_FILM_RENDER_URL=http://render:8080` 以及 `RENDER_ALLOWED_MEDIA_HOSTS`（填入本系统 OSS 域名和上游视频生成域名，多个域名用逗号分隔）。
- `configs/config.yaml` 与 `configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制生成 `runtime.yaml`，回调地址保持 `http://server:7788`（插件启用条件见[内部接口与视频插件包](architecture.md#内部接口与视频插件包)，接入其他系统见[新应用接入运行时](runtime-apps.md)）。
- `components/`：成片动态组件库挂载目录（镜像内不包含组件库，需按下方[发布组件库](#发布组件库)步骤上传）。

### 4. 执行数据库迁移并启动容器
```bash
docker login <ACR_REGISTRY>
docker compose pull
docker compose run --rm server alembic upgrade head
docker compose run --rm --no-deps runtime python -m agent_runtime.admin migrate
docker compose up -d
curl http://localhost/api/healthz
```
运行时的命令要加 `--no-deps`：`compose.yaml` 里运行时依赖后端健康，不加会先把后端拉起来。

### 5. 设置首个 root 与管理员账号
- **方式一（SSO 自动授权）**：在 `.env` 中设置 `ROOT_EMAIL=<管理员邮箱>`，该邮箱首次通过 SSO 登录时会自动获得 `root` 角色。
- **方式二（命令行手动授权）**：
  ```bash
  # 授予最高管理员（包含 Agent 与模型供应商配置权限）：
  docker compose run --rm server python -m scripts.admin set-roles <用户名> root,editor
  # 授予日常管理员（仅管理用户与业务数据，不管理 Agent 与底层模型）：
  docker compose run --rm server python -m scripts.admin set-roles <用户名> admin
  ```

### 6. 在配置页接入火山方舟（用于视频理解、拆解与自动打标）
视频理解插件（`video`）、参考视频拆解和资料库自动打标固定使用火山方舟模型。请使用 `root` 账号登录网页后台，在「模型供应商」中：
1. 新增一个「火山方舟」供应商并保持启用，添加一把默认密钥（填入方舟 API Key，接口地址留空即使用默认地址 `https://ark.cn-beijing.volces.com/api/v3`）。
2. 在该供应商下添加并启用以下两个 `llm` 模型（接口协议均选择 `responses`）：
   - `doubao-seed-2-0-lite-260428`（供视频理解使用）
   - `doubao-seed-2-1-lite-260915`（供参考视频拆解与资料库打标使用）

---

## 运维与升级操作

### 成片渲染服务

`render` 容器仅在 Docker 内部网络监听 `8080` 端口（机制见[架构：成片渲染服务](architecture.md#成片渲染服务)）：
- **确认显卡硬件加速已生效**：运行 `docker compose exec render node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"`，返回结果中的 `gpu` 应为 `hardware`，且容器启动日志中的 `videoEncoder` 应为 `nvenc`。
- **内存与字体**：`compose.yaml` 为其分配了 `shm_size: 2gb` 共享内存与临时卷 `render-tmp`；渲染期间只使用组件库自带字体与镜像内置的 Noto CJK 字体，禁止从外网下载字体。
- **上线验收**：每次部署或升级后，建议导出一条带有中文 `logo-brand-close` 片尾的成片，对比导出的片尾字标大小是否与网页编辑器预览一致。

### 发布组件库

成片组件库在独立的私有仓库维护，通过挂载部署目录的 `components/` 提供给前端和渲染服务，**更新组件库无需重启任何容器**：

```bash
# 1. 在本机 web/ 目录下打包组件库（生成 catalog.json 和 <版本号>/ 文件夹）
pnpm hf:registry --library <私有组件库本地路径> --out <本机输出目录>

# 2. 先把新增的 <版本号>/ 文件夹上传到服务器
rsync -a <本机输出目录>/<版本号> <服务器>:<部署目录>/components/

# 3. 最后上传并原子替换 catalog.json（注意：不要加 --inplace 参数）
rsync -a <本机输出目录>/catalog.json <服务器>:<部署目录>/components/
```

### 升级

> **只能从 v0.16.3 或之后的版本直接升级**。后端的迁移基线就是 v0.16.3 的迁移头，更早的库执行 `alembic upgrade head` 会报 `Can't locate revision` 并停下，不改任何表。这样的库先把 `IMAGE_TAG` 改成 `v0.16.3` 按 v0.16.3 自带的本文档升上去，再回到本节；从 v0.15（运行时还未独立拆分的旧版本）升到 v0.16.3 按文末的[升级到运行时独立部署的版本](#升级到运行时独立部署的版本)执行。

1. 对照新版本的 [compose.yaml](../deploy/compose.yaml) 和[配置模型](../server/src/iclip/config/models.py)，检查是否需要在 `.env` 或配置文件中补充新变量；修改 `.env` 中的 `IMAGE_TAG` 为新版本号，拉取新镜像：
   ```bash
   docker compose pull
   ```
2. **一次性步骤**：已有的库第一次升到运行时自己管迁移的版本时，先打基线标记。命令只写版本表，不动表结构；库里没有运行时的表或已经打过标记时报错退出。此后的升级跳过这一步：
   ```bash
   docker compose run --rm --no-deps runtime python -m agent_runtime.admin stamp-baseline
   ```
3. 执行两边的迁移。漏了第 2 步时运行时的迁移会报表已存在并回滚，补上再跑：
   ```bash
   docker compose run --rm server alembic upgrade head
   docker compose run --rm --no-deps runtime python -m agent_runtime.admin migrate
   ```
4. 用新镜像重启：
   ```bash
   docker compose up -d
   ```
5. **可选的数据库空间回收（针对升到 v0.16.3 的历史版本）**：
   - 升级到「快照消息按哈希去重存储」的版本后（见[运行时的持久化](architecture.md#运行时的持久化)），可在停机窗口运行 `docker compose run --rm server python -m scripts.dedup_snapshot_messages` 转换旧快照，随后在数据库执行 `VACUUM FULL agent_runtime.snapshots` 回收磁盘空间。
   - 升级到迁移 `0039`（生成任务结果合并进 `output` 列）时，需先停掉后端服务再跑迁移，并在同一停机窗口执行 `VACUUM FULL iclip.generation_jobs`。

### 修改线上配置

- **修改模型、Agent、技能库与 MCP 服务**：直接在网页后台修改并保存/发布，下一次对话运行会自动加载最新配置，无需重启容器（已有对话锁定的 Agent 版本不受影响，见[对话固定版本与每次运行装配](architecture.md#对话固定版本与每次运行装配)）。
- **修改 `configs/*.yaml` 或 `.env`**：修改后必须执行 `docker compose up -d` 重新创建容器才能生效（单纯执行 `docker compose restart` 不会重新读取 `.env`）。

### 换密钥加密钥匙

环境变量 `CREDENTIAL_ENCRYPTION_KEYS` 支持用逗号分隔配置多把 Fernet 密钥（系统总是用**第一把密钥**加密新数据，并用**所有密钥**尝试解密旧数据），因此可以在**不停服**的情况下轮换密钥：

1. 生成一把新的 Fernet 密钥，拼在 `.env` 中 `CREDENTIAL_ENCRYPTION_KEYS` 现有值的**最前面**（用逗号隔开），然后执行 `docker compose up -d`。
2. 运行以下命令，将数据库里所有的模型密钥和 MCP 服务配置用新密钥重新加密一遍：
   ```bash
   docker compose run --rm runtime python -m agent_runtime.admin rotate-credential-keys
   ```
3. 从 `.env` 的 `CREDENTIAL_ENCRYPTION_KEYS` 中删掉旧密钥，再次执行 `docker compose up -d` 完成轮换。

---

### 升级到运行时独立部署的版本

> **历史版本迁移归档（仅适用于从 v0.15 / 数据库迁移 0039 升级）**：必须先升到 v0.16.3（下文的新版都指它），走完本节再按[升级](#升级)升到之后的版本。从该版本起，Agent 拆分为独立的 `runtime` 容器运行，且模型、Agent 与技能配置从本地 YAML 文件迁入数据库管理。请在停机维护窗口内按顺序执行。

1. **停服并备份数据与配置**：
   ```bash
   docker compose stop
   pg_dump --format=custom --file=<备份目录>/iclip.dump --dbname='postgresql://iclip:<密码>@<库主机>:<端口>/iclip'
   cp -a compose.yaml .env configs agents skills <备份目录>/
   cp configs/config.yaml configs/config.old.yaml
   ```
2. **更新 `compose.yaml` 与 `.env`**：换上 v0.16.3 的 `compose.yaml`，把 `.env` 中的 `IMAGE_TAG` 改成 `v0.16.3` 并执行 `docker compose pull`。在 `.env` 中补充 `RUNTIME_URL=http://runtime:7790`、`RUNTIME_APP_KEY`、`RUNTIME_INTERNAL_TOKEN` 和 `CREDENTIAL_ENCRYPTION_KEYS`，同时记下并删掉废弃的 `VIDEO_UNDERSTANDING_URL` 与 `VIDEO_UNDERSTANDING_API_KEY`。
3. **执行数据库迁移**：
   ```bash
   docker compose run --rm server alembic upgrade head
   ```
4. **拆分新旧配置文件**：
   - 从 `configs/config.yaml` 中删掉 `models`、`conversations`、`agent_runs`、`video` 四段；`shot_video` 段简化为 `shot_video: {}`；`iclip_studio` 段删掉 `breakdown_model`。
   - 从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制生成 `configs/runtime.yaml`，将原配置中的 `agent_runs`、`conversations.compaction`（改名为 `compaction`）、`shot_video`（移入 `plugins.config.shot_video`）、`video_breakdown` 与 `oss` 填进去。
5. **启动后端并运行一键迁移脚本**：
   ```bash
   docker compose up -d server
   # 先带 --dry-run 预检，确认无误后去掉 --dry-run 正式将旧配置文件导入数据库：
   docker compose run --rm -v ./agents:/app/agents:ro -v ./skills:/app/skills:ro server \
     python -m scripts.import_agent_config --runtime-config configs/runtime.yaml \
     --legacy-config configs/config.old.yaml --agents agents/agents.yaml --skills skills --dry-run
   ```
6. **启动全部容器并验证**：执行 `docker compose up -d`，按上方[服务器部署](#服务器部署)第 6 步在后台接入火山方舟，验证新旧对话收发消息与测试预览一切正常后，即可删掉部署目录下不再使用的 `agents/`、`skills/` 与 `configs/config.old.yaml`。

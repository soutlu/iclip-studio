# 本地启动与服务器部署指南

本文说明如何在本地开发环境跑起整套服务，以及线上服务器的首次部署、日常升级和配置维护。Docker 镜像的构建与发布流程见[发版与镜像发布](release.md)。

## 本地启动

### 1. 安装基础工具与依赖
- 安装 Python、uv、Node.js 和 pnpm（具体版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 及各自的 lockfile 为准），并准备一个本地可连接的 PostgreSQL 数据库。
- 如果需要使用视频抽帧出图（`shot_video`）、视频剪辑合成或参考视频拆解功能，请确保系统 `PATH` 中已安装 `ffmpeg` 和 `ffprobe`。
- 在仓库根目录执行以下命令，先按 `runtime.ref` 把运行时项目 Cue 检出到 `runtime/`，再安装前后端依赖。检出需要本机 SSH 能读私有仓库 `soutlu/Cue`；以后 `runtime.ref` 变了，执行 `make runtime` 切到新版本：
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
  | `WHOLE_FILM_RENDER_URL` | 可选 | 本地需要调试成片（保存草稿和导出都要渲染服务）时，设为 `http://localhost:8080` |

- 准备两份本地配置文件（均不入 Git 仓库，修改后需重启服务）：
  1. `server/configs/config.yaml`：视频后端运行配置。
  2. `server/configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制一份，将里面的 `http://server:7788` 全部替换成 `http://localhost:7788`，并按需开启要用到的插件配置段。

### 3. 执行数据库迁移并启动后端服务
```bash
make db-upgrade   # 执行后端与运行时两边的 Alembic 数据库迁移（如果库里已有重要数据请先备份）
make dev          # 先启动视频后端 (:7788)，健康检查通过后自动启动运行时服务 (:7790)
```
- **已有的本地库**：运行时的迁移报表已存在时，说明这个库还没打基线标记，见[升级运行时](#升级运行时)第 2 步；本地在 `server/` 目录下用 `uv run --env-file ../.env python -m agent_runtime.admin stamp-baseline` 执行。
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
- `compose.yaml` 与 `upgrade.sh`：从仓库 `deploy/compose.yaml` 与 [deploy/upgrade.sh](../deploy/upgrade.sh) 复制，`upgrade.sh` 保留可执行权限，升级时用（见[升级](#升级)）。
- `.env`：配置镜像版本号 `IMAGE_TAG` 与 `RUNTIME_IMAGE_TAG`（见[升级](#升级)）、对外端口、`DATABASE_URL`、OSS 凭证以及运行时所需的四个核心变量（`RUNTIME_URL=http://runtime:7790`、`RUNTIME_APP_KEY`、`RUNTIME_INTERNAL_TOKEN`、`CREDENTIAL_ENCRYPTION_KEYS`）。
  - **重要提醒**：请将 `CREDENTIAL_ENCRYPTION_KEYS` 与数据库备份分开妥善保管；一旦丢失，数据库里已保存的所有模型 API Key 和 MCP 配置都将无法解密，只能重新录入。
  - 如果服务器是与 OSS 同地域的阿里云 ECS，建议配置 `OSS_INTERNAL_ENDPOINT` 走内网高速读写；
  - 如需开启视频超分（高清版），配置 `VIDEO_ENHANCE_SUBMIT_URL` 并在 `config.yaml` 中配置 `media_generation.video.enhance`；
  - 如需开启成片（保存草稿和导出都经渲染服务），配置 `WHOLE_FILM_RENDER_URL=http://render:8080` 以及 `RENDER_ALLOWED_MEDIA_HOSTS`（填入本系统 OSS 域名和上游视频生成域名，多个域名用逗号分隔）。
- `configs/config.yaml` 与 `configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制生成 `runtime.yaml`，回调地址保持 `http://server:7788`（插件启用条件见[内部接口与视频插件包](architecture.md#内部接口与视频插件包)，接入其他系统见运行时项目的 `docs/apps.md`）。
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

> **只能从 v0.16.3 或之后的版本直接升级**。后端的迁移基线是 v0.16.3 的迁移头。更早的库先按 v0.16.3 的部署文档迁移到该版本，再执行本节的升级步骤。

应用和运行时各有一条发布线（见[发版与镜像发布](release.md)），分开升级，互不重启。两边谁先升见[跨版本兼容](../contract/conventions.md#跨版本兼容)。

升级用部署目录里的 `upgrade.sh`（[deploy/upgrade.sh](../deploy/upgrade.sh)），在部署目录执行。脚本先拉取目标镜像，再用目标镜像只读核对 Alembic 版本。数据库已在目标版本时直接切换镜像，适用于已通过 DMS 完成迁移的环境。仍需迁移时，脚本先在目标镜像里完成迁移，再写入 `.env`。拉取、核对或迁移失败时，`.env` 不变。写入版本后重启或健康检查失败时，脚本会打印旧版本和重启命令。需要回退数据库时，另行处理对应迁移。升级成功后脚本打印新旧版本号，并清掉没有标签的悬空镜像，带标签的旧版本可用于回退。

`.env` 要同时写明 `IMAGE_TAG` 和 `RUNTIME_IMAGE_TAG`：两者缺省都是 `latest`，没写的一边下次拉取时会被带到最新版本。升级应用时 `.env` 里还没有 `RUNTIME_IMAGE_TAG`，脚本会读出运行时容器当前在用的镜像标签，补进 `.env` 并打印出来；运行时容器没在运行、读不出标签或标签是 `latest` 时，脚本报错退出，需要手动在 `.env` 里写上：运行时单独发版之前的运行时镜像用应用版本号做标签，也就是当时 `IMAGE_TAG` 的值。

#### 升级应用

升级后端、前端和渲染服务，运行时容器不动。先对照新版本的 [compose.yaml](../deploy/compose.yaml) 和[配置模型](../server/src/iclip/config/models.py)，检查是否需要在 `.env` 或配置文件中补充新变量，然后执行：

```bash
./upgrade.sh app vX.Y.Z
```

脚本依次执行：

1. `.env` 里没有 `RUNTIME_IMAGE_TAG` 时，读取运行时容器当前的镜像标签。
2. 用 `IMAGE_TAG=vX.Y.Z docker compose pull server web render` 拉取目标镜像。
3. 核对 `iclip.alembic_version`。仍需迁移时，执行 `IMAGE_TAG=vX.Y.Z docker compose run --rm --no-deps -T server alembic upgrade head`。
4. 把目标 `IMAGE_TAG` 写入 `.env`，并按需补上第 1 步读出的 `RUNTIME_IMAGE_TAG`。
5. 用 `docker compose up -d server web render` 重启，等 `server`、`render` 健康（最长 180 秒），并确认 `web` 在运行。

#### 升级运行时

只升级运行时容器（运行时 + 视频插件）。先对照 `runtime-vX.Y.Z` 标签上 [compose.yaml](../deploy/compose.yaml) 的 `runtime` 段和 [runtime.example.yaml](../deploy/runtime.example.yaml)，检查是否需要在 `.env` 或配置文件中补充新变量，然后执行：

```bash
./upgrade.sh runtime runtime-vX.Y.Z
```

已有的库第一次升到运行时自己管迁移的版本时，命令末尾加 `--stamp-baseline`，先打基线标记，此后的升级不加。基线标记只写版本表，不动表结构；库里没有运行时的表或已经打过标记时报错退出。漏加时迁移会报表已存在并回滚，加上 `--stamp-baseline` 重新执行即可。

脚本依次执行如下步骤。核对、迁移和重启运行时都带 `--no-deps`，以便单独操作运行时容器。

1. 用 `RUNTIME_IMAGE_TAG=runtime-vX.Y.Z docker compose pull runtime` 拉取目标镜像。
2. 核对 `agent_runtime.alembic_version`。仍需迁移时，在目标镜像运行 `python -m agent_runtime.admin migrate`。带 `--stamp-baseline` 时，先在目标镜像运行 `python -m agent_runtime.admin stamp-baseline`。
3. 把目标 `RUNTIME_IMAGE_TAG` 写入 `.env`。
4. 用 `docker compose up -d --no-deps runtime` 重启，等 `runtime` 健康（最长 180 秒）。

### 修改线上配置

- **修改模型、Agent、技能库与 MCP 服务**：直接在网页后台修改并保存/发布，下一次对话运行会自动加载最新配置，无需重启容器（已有对话锁定的 Agent 版本不受影响，见运行时项目的 `docs/architecture.md`「对话固定版本与每次运行装配」）。
- **修改 `configs/*.yaml` 或 `.env`**：修改后必须执行 `docker compose up -d` 重新创建容器才能生效（单纯执行 `docker compose restart` 不会重新读取 `.env`）。

### 换密钥加密钥匙

环境变量 `CREDENTIAL_ENCRYPTION_KEYS` 支持用逗号分隔配置多把 Fernet 密钥（系统总是用**第一把密钥**加密新数据，并用**所有密钥**尝试解密旧数据），因此可以在**不停服**的情况下轮换密钥：

1. 生成一把新的 Fernet 密钥，拼在 `.env` 中 `CREDENTIAL_ENCRYPTION_KEYS` 现有值的**最前面**（用逗号隔开），然后执行 `docker compose up -d`。
2. 运行以下命令，将数据库里所有的模型密钥和 MCP 服务配置用新密钥重新加密一遍：
   ```bash
   docker compose run --rm runtime python -m agent_runtime.admin rotate-credential-keys
   ```
3. 从 `.env` 的 `CREDENTIAL_ENCRYPTION_KEYS` 中删掉旧密钥，再次执行 `docker compose up -d` 完成轮换。

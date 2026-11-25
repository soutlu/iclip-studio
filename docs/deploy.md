# 本地启动与服务器部署指南

本文说明如何在本地开发环境跑起整套服务，以及线上服务器的首次部署、日常升级和配置维护。Docker 镜像的构建与发布流程见[发版与镜像发布](release.md)。

## 本地启动

### 1. 安装基础工具与依赖
- 安装 Python、uv、Node.js 和 pnpm（具体版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 及各自的 lockfile 为准），并准备一个本地可连接的 PostgreSQL 数据库。
- 如果需要使用视频抽帧出图（`shot_video`）、视频剪辑合成或参考视频拆解功能，请确保系统 `PATH` 中已安装 `ffmpeg` 和 `ffprobe`。
- 在仓库根目录执行以下命令，先按 `runtime.ref` 把运行时项目 Cue 检出到 `runtime/`，再安装前后端依赖。检出需要本机 SSH 能读私有仓库 `soutlu/Cue`；后续 `runtime.ref` 变更后执行 `make runtime` 即可切换版本：
  ```bash
  make setup
  ```

### 2. 配置环境变量（`.env`）与配置文件（`server/configs/`）
- 在仓库根目录创建 `.env` 文件，只放密钥的值（与 `config.yaml` 的分工见[后端的配置与装配](architecture.md#后端的配置与装配)；缺少必填项时服务启动会直接报错并列出缺失的变量名）：

  | 环境变量名 | 是否必填 | 用途与填写说明 |
  |---|---|---|
  | `DATABASE_URL` | 必填 | 本地开发数据库连接串（例如 `postgresql+asyncpg://...`） |
  | `AUTH_SECRET` | 必填 | 登录会话签名密钥（不少于 32 个字符） |
  | `CREDENTIAL_ENCRYPTION_KEYS` | 必填 | 运行时用来加密模型 API Key 和 MCP 请求头的 Fernet 密钥。生成命令：<br>`uv run --project runtime python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
  | `RUNTIME_APP_KEY` | 必填 | 视频后端访问运行时的密钥（不少于 32 个字符，与 `runtime.yaml` 中 `apps.video.key_env` 对应） |
  | `RUNTIME_INTERNAL_TOKEN` | 必填 | 运行时回调后端、以及视频插件调用后端内部接口共用的令牌（不少于 32 个字符） |
  | `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` | 配置 `object_store` 段时必填 | 对象存储凭证 |
  | `PRODUCT_CATALOG_DATABASE_URL` | 配置 `product_catalog` 段时必填 | 产品资料库只读连接串 |
  | 各配置组的媒体密钥 | 开启媒体生成时必填 | 变量名由 `config.yaml` 的 `model_groups` 指定，见[配置组](#配置组) |

- 准备两份本地配置文件（均不入 Git 仓库，修改后需重启服务）：
  1. `server/configs/config.yaml`：视频后端运行配置。结构参考占位配置 [server/scripts/contract/config.yaml](../server/scripts/contract/config.yaml)（各可选段全开的完整样例）与[配置模型](../server/src/iclip/config/models.py)，按需删除未启用功能的对应配置段或字段即可。本地开发时：
     - `runtime.url` 设为 `http://localhost:7790`（见[调运行时](architecture.md#调运行时)）；
     - 需调试成片导出时配置 `final_cut.render_url: http://localhost:8080`；
     - `final_cut.preview_origin` 为 `final-cut` 预览沙箱源地址，格式为 `http(s)://主机[:端口]`（不带路径，规则见 [conventions「预览域名」](../contract/conventions.md#final-cut-工程与预览域名)，未配置时编辑器预览无法加载）。本地配置为与主应用不同的另一回环主机名（同端口）：如用 `http://localhost:3013` 访问应用则设为 `http://127.0.0.1:3013`，反之亦然。
  2. `server/configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制一份，将里面的 `http://server:7788` 全部替换成 `http://localhost:7788`，并按需开启要用到的插件配置段。

### 3. 执行数据库迁移并启动后端服务
```bash
make db-upgrade   # 执行后端与运行时两边的 Alembic 数据库迁移（如果库里已有重要数据请先备份）
make dev          # 先启动视频后端 (:7788)，健康检查通过后自动启动运行时服务 (:7790)
```
- **已有的本地库**：若运行 `make db-upgrade` 提示运行时的数据库表已存在，说明该库尚未写入迁移基线标记（见[升级运行时](#升级运行时)）；先在 `server/` 目录下执行 `uv run --env-file ../.env python -m agent_runtime.admin stamp-baseline`，再重新执行 `make db-upgrade`。
- **初始化后台配置**：新库刚启动时还没有任何模型和 Agent。请使用 root 账号登录网页后台，在「配置页」中接入模型供应商、创建并发布技能与 Agent（如需使用视频理解、参考视频拆解、自动打标或 `final-cut` 翻译功能，请按下方[服务器部署](#服务器部署)第 6 步接入火山方舟）。

### 4. 启动前端开发服务（另开终端）
```bash
cd web && pnpm dev   # 访问 http://localhost:3013，/api 请求会自动代理到本地后端
```
- 如只需查看纯前端界面、不连接真实后端，运行 `pnpm dev:mock`。更多参数见[前端启动参数](../web/README.md#启动参数)。

### 5. 启动成片渲染服务（可选，另开终端）
本地需要测试导出成片时（需同时配好 OSS 与媒体生成），新开终端启动 `render/` 服务：
```bash
cd render && RENDER_ALLOWED_MEDIA_HOSTS=<允许下载的素材域名> RENDER_REGISTRY_ROOT=../web/public/hyperframes pnpm dev
```
- 渲染服务依赖无头浏览器 `chrome-headless-shell`（默认从 `~/.cache/puppeteer` 查找，可通过环境变量 `PRODUCER_HEADLESS_SHELL_PATH` 指定路径，固定版本号见 [render/Dockerfile](../render/Dockerfile)），详情见 [config.ts](../render/src/config.ts)。

---

## 服务器部署

线上单机部署使用 [deploy/compose.yaml](../deploy/compose.yaml)，通过 Docker Compose 同时编排 `server`（视频后端）、`runtime`（Agent 运行时）、`web`（前端与 Nginx 反代）和 `render`（成片渲染）四个容器。注意：后端与运行时均固定运行 1 个 Worker 进程（原因见[两个服务](architecture.md#1-两个服务)）。

### 1. 安装宿主机显卡驱动
- 在宿主机安装 NVIDIA 显卡驱动与 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)（需包含 EGL / OpenGL 图形库，供 `render` 容器启用硬件渲染）。
- 若服务器无独立显卡，删掉 `compose.yaml` 中 `server` 和 `render` 下面的 `deploy` 显卡申请配置，服务会自动回退使用 CPU 软件编解码与软件渲染。

### 2. 创建数据库与专属账号
在服务器的 PostgreSQL 中为本项目创建独立的数据库和账号：
```sql
CREATE ROLE iclip LOGIN PASSWORD '<密码>';
CREATE DATABASE iclip OWNER iclip;
```

### 3. 准备服务器部署目录
在服务器上新建部署目录，放入以下文件与子目录：
- `compose.yaml` 与 `upgrade.sh`：从仓库 `deploy/compose.yaml` 与 [deploy/upgrade.sh](../deploy/upgrade.sh) 复制，保留 `upgrade.sh` 可执行权限供[升级](#升级)使用。
- `.env`：仅存放 Compose 编排变量与敏感凭证——镜像仓库 `ACR_REGISTRY`、`ACR_NAMESPACE`、镜像版本号 `IMAGE_TAG` 与 `RUNTIME_IMAGE_TAG`（见[升级](#升级)）、对外端口 `WEB_PORT`、`RENDER_ALLOWED_MEDIA_HOSTS`（启用成片导出时填写本系统 OSS 域名和上游视频生成域名，多个域名以逗号分隔）、`DATABASE_URL`、`AUTH_SECRET`、OSS 凭证、`PRODUCT_CATALOG_DATABASE_URL`（启用 `product_catalog` 时）、各配置组的媒体密钥（见[配置组](#配置组)），以及运行时所需的 `RUNTIME_APP_KEY`、`RUNTIME_INTERNAL_TOKEN`、`CREDENTIAL_ENCRYPTION_KEYS`。
  - **重要提醒**：请将 `CREDENTIAL_ENCRYPTION_KEYS` 与数据库备份分开妥善保管；一旦丢失，数据库里已保存的所有模型 API Key 和 MCP 配置都将无法解密，只能重新录入。
- `configs/config.yaml`：结构参考 [server/scripts/contract/config.yaml](../server/scripts/contract/config.yaml) 与[配置模型](../server/src/iclip/config/models.py)。部署时注意：
  - `runtime.url` 设为 `http://runtime:7790`；
  - 若服务器是与 OSS 同地域的阿里云 ECS，建议配置 `object_store.internal_endpoint` 走内网高速读写；
  - 媒体生成各项服务的密钥环境变量名与视频网关 `model_id` 按组配置在 `model_groups` 段，启用媒体生成时必须配置 `default` 组（见[配置组](#配置组)）；
  - 按需开通样片功能（配置 `media_generation.video.draft_complete_url` 为视频网关的样片转 1080p 提交地址）：配置后方可发起转 1080p，视频模型清单方列出支持样片的模型（须在 `allowed_models` 中）；出片请求本身是否携带样片参数不受此项控制，原样转发给上游；
  - 按需启用高清版（配置 `media_generation.video.enhance` 段）与千问音频能力（三项独立开关，配置对应子段即启用）：素材片字幕识别配置 `media_generation.subtitle`；生成背景音乐配置 `media_generation.music`；`final-cut` 配音与旁白配置 `media_generation.speech`（`url` 填 `https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer`，`concurrency` 与 `timeout_seconds` 可省略）；
  - 启用成片导出：配置 `final_cut.render_url: http://render:8080`，并在 `.env` 中配置 `RENDER_ALLOWED_MEDIA_HOSTS`；
  - 启用 `final-cut` 预览沙箱：配置 `final_cut.preview_origin: https://<预览子域名>`（未配置时编辑器预览无法加载）。预览子域名的 DNS 解析与 HTTPS 证书须与主应用域名一样指向 `web` 容器，由同一套 Nginx 托管前端页面并将 `/api/` 原样保留 `Host` 转发给后端。
- `configs/runtime.yaml`：从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制生成，回调地址保持 `http://server:7788`（插件启用条件见[内部接口与视频插件包](architecture.md#内部接口与视频插件包)，接入其他系统见运行时项目的 `docs/apps.md`）。
- 两份配置的 `ops.log_format` 都设为 `json`：默认的 Console 格式会省略例行的访问日志（见[日志](architecture.md#4-日志)）。
- `components/`：外置组件库挂载目录（镜像内不包含组件库，按下方[发布组件库](#发布组件库)上传）。

### 4. 执行数据库迁移并启动容器
```bash
docker login <ACR_REGISTRY>
docker compose pull
docker compose run --rm server alembic upgrade head
docker compose run --rm --no-deps runtime python -m agent_runtime.admin migrate
docker compose up -d
curl http://localhost/api/healthz
```
运行时的迁移命令须加 `--no-deps`（`compose.yaml` 中 `runtime` 依赖 `server` 健康，不加会提前拉起后端）。

### 5. 设置首个 root 与管理员账号
- **方式一（SSO 自动授权）**：在 `config.yaml` 的 `sso` 段配置 `root_email: <管理员邮箱>`，该邮箱首次通过 SSO 登录时自动获得 `root` 角色。其余成员首次通过 SSO 登录默认仅获得只读角色 `viewer`，须由 `root` 或管理员在网页「设置 → 用户」中为其分配写权限角色（如 `editor`）与配置组。
- **方式二（命令行手动授权）**：
  ```bash
  # 授予最高管理员（包含 Agent 与模型供应商配置权限）：
  docker compose run --rm server python -m scripts.admin set-roles <用户名> root,editor
  # 授予日常管理员（仅管理用户与业务数据，不管理 Agent 与底层模型）：
  docker compose run --rm server python -m scripts.admin set-roles <用户名> admin
  ```

### 6. 在配置页接入火山方舟（用于视频理解、拆解、自动打标与翻译）
视频理解插件（`video`）、参考视频拆解、资料库自动打标与 `final-cut` 文字翻译固定使用火山方舟模型。请使用 `root` 账号登录网页后台，在「模型供应商」中：
1. 新增一个「火山方舟」供应商并保持启用，添加一把默认密钥（填入方舟 API Key，接口地址留空即使用默认地址 `https://ark.cn-beijing.volces.com/api/v3`）。
2. 在该供应商下添加并启用以下两个 `llm` 模型（接口协议均选择 `responses`）：
   - `doubao-seed-2-0-lite-260428`（供视频理解使用）
   - `doubao-seed-2-1-lite-260915`（供参考视频拆解、资料库打标与 `final-cut` 翻译使用）

---

## 运维与升级操作

### 成片渲染服务

`render` 容器仅在 Docker 内部网络监听 `8080` 端口（机制见[架构：成片渲染服务](architecture.md#成片渲染服务)）：
- **确认显卡硬件加速已生效**：运行 `docker compose exec render node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"`，返回结果中的 `gpu` 应为 `hardware`，且容器启动日志中的 `videoEncoder` 应为 `nvenc`。
- **内存与字体**：`compose.yaml` 为其分配了 `shm_size: 2gb` 共享内存与临时卷 `render-tmp`；渲染期间只使用组件库自带字体与镜像内置的 Noto CJK 字体，禁止从外网下载字体。
- **上线验收**：每次部署或升级后，建议导出一条带有中文 `logo-brand-close` 片尾的成片，核对导出的片尾字标大小与网页编辑器预览一致。

### 发布组件库

组件库在独立私有仓库维护，通过挂载部署目录的 `components/` 提供给前端和渲染服务，**更新组件库无需重启任何容器**。打包产物由三部分组成：
- `vendor/`：跨版本共享文件（运行库、动画库、字体样式与字体文件、组件静态资源等）。文件路径均带版本号或内容摘要，**只增不删、不改已有文件**（本机输出目录里已有同路径不同内容的文件时，打包会直接报错）。
- `<版本号>/`：该版本的组件文件、封面与字体表，内部 `vendor` 为指向 `../vendor` 的软链接。
- `catalog.json`：当前生效的组件目录索引，指向目标版本号。

在仓库根目录执行（目标位置为部署目录的 `components/`，支持 `<服务器>:<部署目录>/components` 或本机路径）：

```bash
scripts/publish-components.sh <私有组件库本地路径> <本机输出目录> <服务器>:<部署目录>/components
```

- **固定复用 `<本机输出目录>`**：打包时会比对该目录内已有的 `vendor/`，拦截同路径但内容变化的文件；每次更换空目录会失去这层本地保护。
- **脚本自动预检与原子切换**：脚本先比对目标位置已有的 `vendor/` 文件（发现内容不一致即列出冲突并中止，不传输任何文件）；校验通过后依次增量补齐 `vendor/`、上传 `<版本号>/`，最后原子替换 `catalog.json`，确保切换瞬间被引用的文件均已就绪。

### 升级

> - **迁移基线要求**：只能从 `v0.16.3` 或之后的版本直接升级（更早的库须先按 `v0.16.3` 部署文档升至该版本）。
> - **首次升级到统一 `vX.Y.Z` 运行时镜像前**：先将服务器部署目录中的 `upgrade.sh` 替换为新版本标签上的 [deploy/upgrade.sh](../deploy/upgrade.sh)（保留可执行权限），旧脚本不识别 `vX.Y.Z` 格式的运行时版本号。
> - **运行时第一次升级到带对话行（`agent_runtime.conversation_heads`）的版本前**：同样先替换服务器上的 `upgrade.sh`（是哪个版本见该版本 Release 的上线前摘要）。这次的运行时迁移按库里已有的数据生成对话行，必须在运行时停下时执行；旧脚本迁移时不停运行时，迁移期间跑完的对话轮次进不了对话行。

每个版本标签 `vX.Y.Z` 均包含全部四个镜像（见[发版与镜像发布](release.md)）。服务器 `.env` 通过 `IMAGE_TAG`（`server / web / render`）和 `RUNTIME_IMAGE_TAG`（`runtime`）分开记录版本，支持独立或同时升级；具体升级范围与需核对的配置文件见该版本 GitHub Release 的上线前摘要。

升级前先对照新版本标签上的 [compose.yaml](../deploy/compose.yaml)、[占位配置样例](../server/scripts/contract/config.yaml)、[配置模型](../server/src/iclip/config/models.py) 与 [runtime.example.yaml](../deploy/runtime.example.yaml) 补齐新增配置项（若存在已迁入 `config.yaml` 的旧环境变量，须同步从 `.env` 中清理），再在部署目录执行 `./upgrade.sh`：

| 用法 | 升级范围 |
|---|---|
| `./upgrade.sh app vX.Y.Z` | 仅升级应用（`server / web / render`），`runtime` 容器不动（见[升级应用](#升级应用)） |
| `./upgrade.sh runtime vX.Y.Z [--stamp-baseline]` | 仅升级运行时（见[升级运行时](#升级运行时)） |
| `./upgrade.sh all vX.Y.Z --app-first`<br>`./upgrade.sh all vX.Y.Z --runtime-first` | 按指定先后顺序将两边升至同一版本（见[两边一起升级](#两边一起升级)） |

**通用执行流程**：拉取目标镜像 → 只读核对对应 Schema 的 Alembic 版本（已在目标版本则跳过迁移，否则在目标镜像内执行迁移；运行时有待执行的迁移时先停止 `runtime` 容器再迁移，迁移期间对话不可用） → 更新 `.env` 版本号 → 重启对应容器并等待健康检查通过（最长 180 秒） → 清理无标签悬空镜像（保留旧版标签镜像供回滚）。拉取、核对或迁移失败（含迁移中途被中断）时，`.env` 保持不变，迁移前停下的运行时按原版本重新启动；写入 `.env` 后若重启或健康检查失败，脚本会自动打印回滚步骤（见[回滚](#回滚)）。

#### 升级应用

```bash
./upgrade.sh app vX.Y.Z
```

仅升级 `server`、`web`、`render`（核对 `iclip.alembic_version`），`runtime` 容器不重启。`.env` 须同时明确记录 `IMAGE_TAG` 与 `RUNTIME_IMAGE_TAG`（缺省均为 `latest`）：若首次升级应用时 `.env` 未配置 `RUNTIME_IMAGE_TAG`，脚本会自动读取运行中 `runtime` 容器的版本标签写入 `.env`（读不到或标签为 `latest` 时报错退出，需手动补填）。

#### 升级运行时

```bash
./upgrade.sh runtime vX.Y.Z
```

全程携带 `--no-deps` 单独升级 `runtime` 容器（核对 `agent_runtime.alembic_version`）。既有数据库**首次**升级到运行时独立管迁移的版本时，须在末尾追加 `--stamp-baseline` 写入基线标记（仅写版本表，此后升级不再加；若漏加，迁移会在修改 `.env` 前直接报错退出，补上参数重跑即可）。

#### 两边一起升级

```bash
./upgrade.sh all vX.Y.Z --app-first      # 先升级应用，成功后再升级运行时
./upgrade.sh all vX.Y.Z --runtime-first  # 先升级运行时，成功后再升级应用
```

必须显式指定先后顺序：对照 Release 说明与[跨版本兼容](../contract/conventions.md#跨版本兼容)选择（无特定顺序要求时任选其一）。脚本按指定顺序分两步执行：第一步失败时第二步不会启动；第二步失败时第一步已完成，脚本会明确列出两边当前状态与分步回滚命令。

> **注**：运行时首次需带 `--stamp-baseline` 时不能使用 `all`，请分两条命令依次执行：
> ```bash
> ./upgrade.sh runtime vX.Y.Z --stamp-baseline
> ./upgrade.sh app vX.Y.Z
> ```

#### 回滚

按升级失败提示修改 `.env` 中的版本变量（若升级前无该行则删除），再重启对应服务：

| 回滚对象 | `.env` 变量 | 重启命令 |
|---|---|---|
| 应用 | `IMAGE_TAG` | `docker compose up -d server web render` |
| 运行时 | `RUNTIME_IMAGE_TAG` | `docker compose up -d --no-deps runtime` |

两边均需回滚时，遵循**后升先退**原则（先回滚第二步升级的一端，再回滚第一步升级的一端）。

上述操作仅回退容器镜像，不会自动回退已执行的数据库迁移，因此仅适用于数据库迁移兼容旧版代码（[只增不删](architecture.md#后端的持久化与迁移)）的版本；若本版包含非兼容迁移（PR 说明与发版摘要会提示），回滚镜像前须先手工处理数据库。

> **运行时从带对话行的版本回滚到不带对话行的版本**：不带对话行的版本不写 `agent_runtime.conversation_heads`，回滚期间的对话内容只在快照里。再次升级前，须先在数据库执行 `DROP TABLE agent_runtime.conversation_heads;`，并把 `agent_runtime.alembic_version` 改回 `45f235eaa73b`，再次升级时迁移才会按快照重新生成对话行；不处理的话，脚本会判定运行时数据库已是目标版本而跳过迁移，回滚期间的内容不会出现在聊天记录里。

### 修改线上配置

- **修改模型、Agent、技能库与 MCP 服务**：直接在网页后台修改并保存/发布，下一次对话运行自动加载最新配置，无需重启容器（已有对话锁定的 Agent 版本不受影响）。
- **仅修改 `configs/*.yaml`**：执行 `docker compose restart server`（修改 `runtime.yaml` 则执行 `docker compose restart runtime`）。因配置文件以卷挂载方式注入容器，`docker compose up -d` 不会重建或重启未变更的容器，进程无法加载新配置。
- **修改 `.env`**（无论是否同时修改 `configs/*.yaml`）：执行 `docker compose up -d` 重建容器方可生效（`docker compose restart` 不会重新读取 `.env`）。

### 配置组

配置组用于按用户隔离媒体生成与大模型调用的密钥及上游视频网关 `model_id`（用户归组与定组规则见 [CONTEXT.md「配置组」](CONTEXT.md#配置组model-group)）。媒体生成组配置维护在 `configs/config.yaml` 顶层 `model_groups` 段（环境变量名指向 `.env` 中的实际密钥），大模型密钥在网页后台「模型与供应商」中按组绑定，用户归属配置组由 `root` 在网页「设置 → 用户」中分配。`default` 为保留组名，对应默认组在媒体生成中使用的配置，格式与校验规则与其他组相同，但不出现在后台可选配置组中，大模型密钥亦不可绑定至该组：

```yaml
model_groups:
  default:                                          # 未分组用户使用此组；启用媒体生成时必填
    video_api_key_env: VIDEO_API_KEY
    subtitle_api_key_env: QWEN_SUBTITLE_API_KEY
    music_api_key_env: QWEN_MUSIC_API_KEY
    speech_api_key_env: QWEN_SPEECH_API_KEY
    video_models:
      vendor-b-seedance-2-5-flash: <默认的 model_id>
      vendor-b-seedance-2-5: <默认的 model_id>
      wan3.0-video-prime: <默认的 model_id>
      video-enhance: <默认的 model_id>
  mkt:                                              # 组名：小写字母开头，仅含小写字母、数字和下划线
    video_api_key_env: VIDEO_API_KEY_MKT            # 该组视频密钥环境变量名（必填）
    subtitle_api_key_env: QWEN_SUBTITLE_API_KEY_MKT # 启用字幕识别时必填
    music_api_key_env: QWEN_MUSIC_API_KEY_MKT       # 启用生成背景音乐时必填
    speech_api_key_env: QWEN_SPEECH_API_KEY_MKT     # 启用配音时必填
    video_models:                                   # 产品模型名 → 该组视频网关 model_id
      vendor-b-seedance-2-5-flash: <该组的 model_id>
      vendor-b-seedance-2-5: <该组的 model_id>
      wan3.0-video-prime: <该组的 model_id>
      video-enhance: <该组的 model_id>              # 键取 media_generation.video.enhance.model；仅启用高清版时填写
```

- **启动期严格校验**：组名格式非法时后端启动即报错退出。启用媒体生成后，若缺少 `default` 组，或任一组（含 `default`）的 `video_models` 键集合与 `allowed_models`（含已启用的 `enhance.model`）不一致、已启用服务（视频必启；字幕、配乐、配音视 `media_generation` 是否配置对应子段而定）的 `*_api_key_env` 未声明或所指环境变量为空，同样在启动阶段报错退出；未启用媒体生成时不校验各组的密钥与 `video_models`。仅配置 `default` 组时，后台无可选配置组，全员归属默认组。
- **上线新组三步**（先绑定大模型密钥再分配用户，避免成员因缺少密钥而无法发送消息）：
  1. 在 `config.yaml` 新增配置组，在 `.env` 填入该组各媒体密钥，执行 `docker compose up -d`；
  2. 使用 `root` 登录网页后台「模型与供应商」，为该组所需供应商添加密钥并绑定至该配置组；
  3. 使用 `root` 在网页「设置 → 用户」中为成员分配该配置组，即时生效、无需重启。
- **日常变更与安全删组**：
  - **换密钥**：更换媒体密钥直接修改 `.env` 变量值并执行 `docker compose up -d`（在途轮询自动使用新密钥）；更换大模型密钥直接在网页后台编辑对应密钥，无需重启。
  - **删组**：先在网页「设置 → 用户」中将该组成员调整至其他组或清空（恢复默认组）→ 待在途任务归零（`SELECT count(*) FROM iclip.generation_jobs WHERE model_group = '<组名>' AND status IN ('pending', 'submitting', 'submitted');` 返回 `0`）→ 再从 `config.yaml` 与 `.env` 移除该组并执行 `docker compose up -d`。若仍有遗漏成员绑定已删除的组，其发起消息或生成请求时将报错并提示联系管理员重新分配（不回退默认组）。
  - **按用户查组**：`SELECT email, username, model_group FROM iclip.users WHERE model_group IS NOT NULL ORDER BY model_group;` 列出已分配配置组的用户（未列出者均在默认组）；`GET /users` 的 `modelGroup` 字段同样返回各成员的配置组。

### 换密钥加密钥匙

环境变量 `CREDENTIAL_ENCRYPTION_KEYS` 支持逗号分隔的多把 Fernet 密钥（始终用**第一把密钥**加密新数据，用**全部密钥**尝试解密旧数据），支持**不停服**轮换：

1. 生成新 Fernet 密钥拼在 `.env` 中 `CREDENTIAL_ENCRYPTION_KEYS` 现有值的**最前面**（逗号分隔），执行 `docker compose up -d`。
2. 执行全量重加密命令：
   ```bash
   docker compose run --rm runtime python -m agent_runtime.admin rotate-credential-keys
   ```
3. 从 `.env` 的 `CREDENTIAL_ENCRYPTION_KEYS` 中移除旧密钥，再次执行 `docker compose up -d` 完成轮换。

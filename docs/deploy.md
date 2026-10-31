# 本地启动与服务器部署

本文讲怎样在本机跑起整套服务，以及怎样部署、升级服务器和修改线上配置。镜像的构建与上传见[发版与镜像发布](release.md)。

## 本地启动

1. 安装 Python、uv、Node.js、pnpm，准备一个可连接的 PostgreSQL 开发库，然后执行 `make setup`。
   - 版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 与各自的 lockfile 为准。
   - Agent 挂载 `shot_video` 或启用视频编辑时，PATH 中还要有 `ffmpeg` 和 `ffprobe`。
2. 在仓库根目录创建 `.env`，`DATABASE_URL` 指向开发库，密钥不入库。
   - 要填哪些变量、各项能力怎样启用，见[配置模型](../server/src/iclip/config/models.py)与[配置与装配](architecture.md#2-配置与装配)；缺少变量时，启动会列出变量名。
   - `CREDENTIAL_ENCRYPTION_KEYS` 必填，生成方法见[服务器部署](#服务器部署)第 3 步；运行时服务用它解密模型供应商的密钥，后端运行不读它。
   - `RUNTIME_URL`（本地是 `http://localhost:7790`）与 `RUNTIME_APP_KEY` 必填，缺了后端起不来：消息、transcript、实时推送、工作区文件、配置页、开对话与首页名册都经运行时服务（见[后端架构](architecture.md#1-模块职责)）。`RUNTIME_APP_KEY` 不少于 32 个字符，运行时配置里应用 `video` 的 `key_env` 指向它。
   - `RUNTIME_INTERNAL_TOKEN` 必填，不少于 32 个字符，缺了后端与运行时都起不来：运行时回调后端（开跑检查、运行开始、轮次开始）与插件调后端都带它。
3. 把一份 `server/configs/config.yaml` 放到本机，再把 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制成 `server/configs/runtime.yaml`，里面的 `http://server:7788` 都换成 `http://localhost:7788`，按要用的插件打开对应的段。两份都不进仓库，改了要重启。模型、agent 与技能存在数据库里，不在文件里。
4. 迁移数据库并启动后端与运行时服务：

   ```bash
   make db-upgrade   # 已有数据的库先备份
   make dev          # 后端 http://localhost:7788，运行时 http://localhost:7790，健康检查都是 /healthz
   ```

   - `make dev` 先起后端，等它答了健康检查再起运行时服务（运行时配了 `shot_video` 时启动就向后端取图片模型）；Ctrl-C 两个一起停。后端先起时连不上运行时不要紧，事件流会自己重连。

   - 库里还没有 agent 时，首页没有可选的 agent。手上有旧的 `config.yaml`（带 `models` 段）、`agents/` 与 `skills/` 时，按[升级到 agent 配置入库的版本](#升级到-agent-配置入库的版本)第 4–6 步跑一次切换命令（在 `server/` 下用 `uv run --env-file ../.env python -m scripts.import_agent_config …`）；否则用 root 账号在配置页里接入供应商、建技能与 agent 并发布。
   - 带取帧、出图或视频理解插件的 agent 要求对应的配置段与环境变量；只跑基础对话时，建一个不挂这些插件的 agent。

5. 另开一个终端启动前端：

   ```bash
   cd web && pnpm dev   # http://localhost:3013，/api 经同源代理转到后端
   ```

   - 只看前端时用 `pnpm dev:mock`，不连后端。端口与代理目标见[前端启动参数](../web/README.md#启动参数)。

6. 要在本机导出成片时（要求开着 OSS 与媒体生成），再开一个终端起渲染服务，并在 `.env` 把 `WHOLE_FILM_RENDER_URL` 设为 `http://localhost:8080`：

   ```bash
   cd render && RENDER_ALLOWED_MEDIA_HOSTS=<素材主机> RENDER_REGISTRY_ROOT=../web/public/hyperframes pnpm dev
   ```

   - 组件库用 `make setup`（或在 `web/` 运行 `pnpm hf:registry`）组装到 `web/public/hyperframes/` 的测试组件库；要看正式组件时按[发布组件库](#发布组件库)第 1 步组装到本机另一个目录，`RENDER_REGISTRY_ROOT` 指向它。Chrome 由 `PRODUCER_HEADLESS_SHELL_PATH` 指定，不设时用 `~/.cache/puppeteer` 里装好的 chrome-headless-shell（版本与 [render/Dockerfile](../render/Dockerfile) 里的一致，用 `npx @puppeteer/browsers install chrome-headless-shell@<版本> --path ~/.cache/puppeteer` 安装），PATH 中还要有 `ffmpeg` 和 `ffprobe`。各变量的含义见 [config.ts](../render/src/config.ts)。

## 服务器部署

单机部署用 [deploy/compose.yaml](../deploy/compose.yaml)，起后端、运行时服务、前端与成片渲染服务四个容器，镜像从 ACR 拉取。运行时服务的镜像 `iclip-runtime` 由 [runtime/Dockerfile](../runtime/Dockerfile) 以仓库根为上下文构建，装的是运行时与视频插件包。

1. 安装 NVIDIA 驱动与 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。后端与渲染服务的容器都要申请显卡，申请不到就起不来。
   - 没有显卡：删掉 compose.yaml 里 `server` 与 `render` 的 `deploy` 段，改用软件编解码与软件渲染。
   - 确认后端用上了显卡：启动日志「本地视频编解码已选定」那一条的 `codec` 为 `nvenc`；渲染服务见[成片渲染服务](#成片渲染服务)。
2. 在服务器现有的 Postgres 上，以管理员身份给本项目建一个独占的库和账号：

   ```sql
   CREATE ROLE iclip LOGIN PASSWORD '<密码>';
   CREATE DATABASE iclip OWNER iclip;
   ```

3. 在服务器上建一个部署目录，放入：
   - `compose.yaml`
   - `.env`：镜像与端口变量见 compose.yaml 文件头，应用变量见[配置模型](../server/src/iclip/config/models.py)，`DATABASE_URL` 指向上一步建的库
   - `.env` 里的 `CREDENTIAL_ENCRYPTION_KEYS`：加密模型供应商密钥的 Fernet key，必填，缺失或格式不对运行时服务起不来。用 `docker compose run --rm server python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` 生成一个，与数据库备份分开保管；丢了它，库里的密钥都解不开，只能重新录入。换钥见[换密钥加密钥匙](#换密钥加密钥匙)。
   - `configs/`：只读挂载，镜像里没有；模型、agent 与技能不在这里，部署好后在配置页里建
     - `config.yaml`：后端的运行配置
     - `runtime.yaml`：运行时服务的配置，从 [deploy/runtime.example.yaml](../deploy/runtime.example.yaml) 复制，接入的应用必须叫 `video`；回调与内部接口的地址是 `http://server:7788`；要用的插件段（`video`、`video_breakdown`、`shot_video`）照样例打开；`video_breakdown` 要后端的 `config.yaml` 配 `iclip_studio` 段，`shot_video` 要后端配 `shot_video: {}` 与媒体生成，`video` 只在运行时这边配，见[配置与装配](architecture.md#2-配置与装配)
   - `.env` 里运行时服务那几项（compose 只把这几项交给运行时容器）：
     - `RUNTIME_URL=http://runtime:7790`，后端用
     - `RUNTIME_APP_KEY`：不少于 32 个字符，后端与运行时同一个值（`runtime.yaml` 的 `apps.video.key_env`）
     - `RUNTIME_INTERNAL_TOKEN`：必填，不少于 32 个字符，后端与运行时同一个值（`runtime.yaml` 的 `hooks.token_env` 与 `plugins.config.internal_api.token_env`）
     - `DATABASE_URL` 与 `CREDENTIAL_ENCRYPTION_KEYS` 两个服务共用
     - `VIDEO_UNDERSTANDING_API_KEY`：`runtime.yaml` 打开了 `video` 段时它的 `api_key_env`
   - `components/`：成片的组件库，web 与渲染服务只读挂载，镜像里没有；按[发布组件库](#发布组件库)放好，没有它编辑器读不到组件目录、导出失败
   - 服务器是与 OSS 桶同地域的阿里云 ECS 或在其 VPC 内时：在 `.env` 把 `OSS_INTERNAL_ENDPOINT` 设为该地域的内网 endpoint（如 `https://oss-cn-shenzhen-internal.aliyuncs.com`），服务端读写和下载对象走内网，浏览器直传仍用 `OSS_ENDPOINT`；不设则全部走 `OSS_ENDPOINT`。
   - 高清版（超分）：在 `.env` 把 `VIDEO_ENHANCE_SUBMIT_URL` 设为上游超分接口的完整提交地址（与 `VIDEO_SUBMIT_URL` 同一台服务，查询地址与 key 共用），并在 `configs/config.yaml` 的 `media_generation.video` 下写 `enhance` 段（`model`、从高到低的 `resolutions`、`fps`，取值见[配置模型](../server/src/iclip/config/models.py)）；不设地址则高清版没有开通，设了地址却没写这一段启动报错。
   - 成片导出：在 `.env` 把 `WHOLE_FILM_RENDER_URL` 设为渲染服务在 compose 网络里的地址（如 `http://render:8080`），要求同时配了 OSS 与媒体生成；不设则导出端点答「成片导出没有开通」。渲染服务的 `RENDER_ALLOWED_MEDIA_HOSTS` 要列出它会取素材的主机：本桶的内网 host `<OSS_BUCKET>.<OSS_INTERNAL_ENDPOINT 的 host>`（没配内网 endpoint 时是 `<OSS_BUCKET>.<OSS_ENDPOINT 的 host>`），以及上游视频服务发布出片的主机。
4. 用有 DDL 权限的账号执行目标版本的数据库迁移。部署和服务启动都不会自动迁移。
5. 登录镜像仓库，拉取并启动：

   ```bash
   docker login <ACR_REGISTRY>   # 与 .env 的 ACR_REGISTRY 相同
   docker compose pull && docker compose up -d
   curl http://localhost/api/healthz
   ```

   - 启动顺序由 compose 定：后端答了健康检查才起运行时服务，因为运行时配了 `shot_video` 时启动就向后端取图片模型，取不到起不来（原因在 `docker compose logs runtime`）。后端日志里先有几条「运行时事件流断了」是正常的，运行时起来后出现「运行时事件流已连上」。

6. 设置首个管理员：
   - 用 SSO 登录：在 `.env` 设置 `ROOT_EMAIL`，这个邮箱首次登录即为 root。
   - 用密码注册：执行 `docker compose run --rm server python -m scripts.admin set-roles <账号> root,editor`。

后端与运行时服务各只跑 1 个 worker。实时投影、事件分发与浏览器订阅都存在进程内存里，增加 worker 前先看[运行、记录与订阅](architecture.md#5-运行记录与订阅)。

### 成片渲染服务

`render` 容器只在 compose 网络里监听 8080，不对外开端口，后端经 `WHOLE_FILM_RENDER_URL=http://render:8080` 调它（职责见[架构](architecture.md#3-身份与模块协作)）。

- **素材主机**：`.env` 里的 `RENDER_ALLOWED_MEDIA_HOSTS`（逗号分隔，带端口就写上端口）由 compose 传给它，取值见上面第 3 步。不设时容器启动即退出，日志是「配置不完整」；导出请求里的素材主机不在名单里答 400 `media-host-not-allowed`。
- **显卡**：compose 给它申请 `gpu, compute, utility, video, graphics` 五项能力，Chrome 用显卡渲染要 `graphics`，NVENC 编码要 `video`。确认用上了显卡：`docker compose exec render node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"` 的 `gpu` 为 `hardware`，启动日志「渲染环境」那一条的 `gpu` 为 `hardware`、`videoEncoder` 为 `nvenc`。是 `software` 时另有一条 warning「浏览器使用软件渲染」，渲染照常，只是更慢。
  - 宿主机须安装与 NVIDIA 驱动版本一致的 EGL / OpenGL 图形用户态库；只有 CUDA 计算库时，NVENC 可用，但 Chrome 不能使用 GPU。使用 NVIDIA CDI 时，补装图形库后须重新生成 CDI 设备清单，再重建 `render` 容器，让新增的驱动库挂入容器。
- **字体**：组件用的网页字体只用组件库里的字体文件，西文用原字体、中文用 Noto Sans SC，与编辑器预览一致；镜像另带 Noto CJK 兜底系统字体。渲染期间不从外网取字体。
- **资源**：Chrome 要共享内存，compose 设了 `shm_size: 2gb`；临时项目目录在卷 `render-tmp`，每次导出结束即删。导出排队、进度只在内存里，重启容器后进行中的导出记为失败（`RENDER_LOST`），用户要重新导出；已完成的成片在桶里，不受影响。
- **日志**：`docker compose logs render`，每行一个 JSON，`event` 是中文短句；一次导出按 `exportId` 串起「导出已排队」到「导出完成」或「导出失败」。
- **上线核对**：部署或升级后导出一条片尾用 `logo-brand-close`、字标写中文的成片，与编辑器预览对比片尾字标的大小和位置。这类组件在自己的脚本里量字宽来定字号，HyperFrames 只在运行组件脚本前等正在加载的字体（最多 5 秒），量的时候字形若还没到位，字标大小就与预览不同；Apple Silicon 上模拟运行 amd64 镜像时字标小约 6%，原生运行的导出与预览一致。差得明显时检查容器的 CPU 与显卡（`/health` 的 `gpu`）。

### 发布组件库

成片的组件库（组件目录、组件、运行时、字体与封面）在私有组件库目录里维护，不随镜像发版；部署目录的 `components/` 挂给 web（站点上的 `/hyperframes/`）与渲染服务（`RENDER_REGISTRY_ROOT`）。增减组件只发布组件库，不用重启容器。服务器上不需要 git、node 或任何组装步骤。

1. 在本机组装：在公开仓库检出的 `web/` 下（先 `pnpm install`）运行

   ```bash
   pnpm hf:registry --library <私有组件库目录> --out <本机输出目录>
   ```

   输出 `catalog.json`（组件目录，带版本号）与 `<版本号>/`（这一版的全部文件）。版本号是全部输入的摘要，输入不变时版本号不变。

2. 先上传版本目录：

   ```bash
   rsync -a <本机输出目录>/<版本号> <服务器>:<部署目录>/components/
   ```

3. 再上传 `catalog.json`：

   ```bash
   rsync -a <本机输出目录>/catalog.json <服务器>:<部署目录>/components/
   ```

   rsync 默认先写临时文件再改名，这一步是原子替换；不要加 `--inplace`。compose 挂载的是整个 `components/` 目录，改名替换后容器里立即看到新文件。

`catalog.json` 不缓存，编辑器重新打开即读到新目录；版本目录长期缓存，所以一个版本目录上传后不再改动，旧版本目录留着给还开着的编辑器用，不再需要时手动删除。渲染服务每次受理导出时读一次 `catalog.json`。

### 升级

1. 新版本有表结构变化时，先执行该版本的数据库迁移。
2. 新版本的 [compose.yaml](../deploy/compose.yaml) 有变化时，换上新版本的文件，按它的文件头与[配置模型](../server/src/iclip/config/models.py)在 `.env` 补上新增的变量；[服务器部署](#服务器部署)多了步骤时补做。compose.yaml 新挂载了部署目录里的目录时，先把目录放好再启动：第一次升级到挂载 `components/` 的版本前，先按[发布组件库](#发布组件库)放好组件库。
3. 把 `.env` 的 `IMAGE_TAG` 改成新版本，再执行 `docker compose pull && docker compose up -d`。
4. 升级到快照消息按引用存的版本后，内联整段历史的旧快照行照常读取，不必处理，存法见[持久化与迁移](architecture.md#4-持久化与迁移)。要回收旧行占的空间，可在停机窗口执行 `docker compose run --rm server python -m scripts.dedup_snapshot_messages` 改写旧行，再在库里执行 `VACUUM FULL agent_runtime.snapshots`（期间锁表）；该版本附带手动执行的历史数据迁移时，改写放在那次迁移之后。
5. 升级到生成记录把产出并进 `output` 的版本（迁移 0039）时，先停后端再执行迁移：旧版本的代码读不了新的表结构。迁移完成后，在同一停机窗口里在库里执行 `VACUUM FULL iclip.generation_jobs`（期间锁表），回收迁移整表更新留下的旧行，实测每百万行十几秒；再按第 3 步启动新版本。
6. 升级到 agent 改在运行时服务里跑的版本时，启动前先改 `configs/config.yaml`，还留着下面这些段后端启动失败，报错点名那一段和它在运行时配置里的位置：
   - 删掉 `agent_runs` 段，改过的值写进 `configs/runtime.yaml` 的 `agent_runs`（字段同名）。
   - 删掉 `conversations` 段，`conversations.compaction` 的值写进 `configs/runtime.yaml` 的 `compaction`（字段同名）。
   - 删掉 `video` 段，视频理解改在 `configs/runtime.yaml` 的 `plugins.config.video` 配：`understanding_model` → `model`，`understanding_thinking` → `thinking`，`understanding_fps` → `fps`，再写上 `understanding_url`（原来 `VIDEO_UNDERSTANDING_URL` 的值）与 `api_key_env: VIDEO_UNDERSTANDING_API_KEY`。`.env` 的 `VIDEO_UNDERSTANDING_*` 留着，后端的 `iclip_studio` 拆解还用。
   - `shot_video` 段只留 `shot_video: {}`，出图重试策略（`poll_interval_seconds`、`dev_attempts`、`pro_attempts`、`backoff_seconds`、`backoff_factor`、`job_timeout_seconds`）写进 `configs/runtime.yaml` 的 `plugins.config.shot_video`（字段同名）。
   - `.env` 里要有 `RUNTIME_INTERNAL_TOKEN`（见[服务器部署](#服务器部署)第 3 步），缺了后端起不来。

### 升级到 agent 配置入库的版本

这个版本起，模型、agent 与技能存在数据库里，运行时从库里装配，`config.yaml` 的 `models` 段与 `conversations.title_model` 不再认（还留着就启动失败），`agents/`、`skills/` 不再挂载。切换要停服，按顺序做：

1. 停服务（`docker compose stop server`），备份数据库；把部署目录的 `configs/`、`agents/`、`skills/` 另存一份，并把 `configs/config.yaml` 复制成 `configs/config.old.yaml`。
2. 确认 `.env` 里有 `CREDENTIAL_ENCRYPTION_KEYS`（生成方法见[服务器部署](#服务器部署)第 3 步），旧 `models` 段各项 `api_key_env` 指向的变量也都还在 `.env` 里。
3. 换上新版本的 `compose.yaml`，把 `.env` 的 `IMAGE_TAG` 改成新版本并 `docker compose pull`，执行新版本的数据库迁移（迁移 0043 建 `agent_runtime.sessions`，0045 把技能库、模型供应商与 agent 配置的表挪进 `agent_runtime`；第 5、6 步的切换命令要在它们之后跑）。
4. 从 `configs/config.yaml` 删掉 `models` 段与 `conversations.title_model`，并按[升级](#升级)第 6 步改好搬到运行时配置的那几段（`config.old.yaml` 不动）：下一步的命令也按 `configs/config.yaml` 读后端配置。
5. 先试一遍（新 compose 不再挂 `agents/`、`skills/`，这里临时挂进去；新建密钥会真的连一次模型供应商，服务器要连得上它）。插件登记表按 `configs/runtime.yaml`（[服务器部署](#服务器部署)第 3 步）建，与运行时服务启动时同一份；它写了 `shot_video` 段时，插件包打开时要向后端取图片模型，先 `docker compose up -d server` 只起新版本的后端再跑，否则命令以「按运行时配置打开插件包失败」拒绝、什么都不写：

   ```bash
   docker compose run --rm -v ./agents:/app/agents:ro -v ./skills:/app/skills:ro server \
     python -m scripts.import_agent_config --runtime-config configs/runtime.yaml \
     --legacy-config configs/config.old.yaml --agents agents/agents.yaml --skills skills --dry-run
   ```

   它打印会写入的供应商、密钥、模型、默认模型、技能、agent 与对话会话数，最后一行是「--dry-run：以上内容没有写入」。有问题时打印「切换没有进行，什么都没写」和原因（检查清单见 [import_agent_config.py](../server/scripts/import_agent_config.py) 的文件头），改好文件再试。
6. 去掉 `--dry-run` 正式运行，最后一行是「已写入」。全部在一个事务里，失败就整体回滚。
7. `docker compose up -d` 启动服务，核对：首页列着原来的三个 agent；每个 agent 各开一段对话发一条消息；运行记录里的版本号（`agent_runtime.runs.metadata` 的 `agent_version_id`）是各 agent 的 v1；切换前就有的对话能接着聊。
8. 删掉部署目录里的 `agents/`、`skills/` 与 `configs/config.old.yaml`。

回滚：停服务，恢复第 1 步的数据库备份、旧版本的 `compose.yaml` 与 `IMAGE_TAG`、另存的 `configs/`、`agents/`、`skills/`，再启动。

### 改配置

- 模型、agent 与技能在配置页里改：发布 agent、发布技能、改密钥或模型后，下一次运行自动用上新的，不用重启；已有的对话固定在开对话时的 agent 版本上，见[配置与装配](architecture.md#2-配置与装配)。
- `configs/config.yaml` 与 `.env` 改了要执行 `docker compose up -d`（`restart` 不会重读 `.env`），配置写错时原因在 `docker compose logs server`。

### 换密钥加密钥匙

`CREDENTIAL_ENCRYPTION_KEYS` 是逗号分隔的多个 Fernet key：第一个用来加密，全部用来解密。换钥不停服：

1. 生成一个新 key（命令见[服务器部署](#服务器部署)第 3 步），加在 `.env` 里这个变量的最前面，执行 `docker compose up -d`。此后新存的密钥用新 key，旧的照读。
2. 执行 `docker compose run --rm runtime python -m agent_runtime.admin rotate-credential-keys`，把库里全部密钥改用新 key 加密，命令会打印改了几把。
3. 从变量里去掉旧 key，再执行 `docker compose up -d`。

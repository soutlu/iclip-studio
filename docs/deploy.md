# 本地启动与服务器部署

本文讲怎样在本机跑起整套服务，以及怎样部署、升级服务器和修改线上配置。镜像的构建与上传见[发版与镜像发布](release.md)。

## 本地启动

1. 安装 Python、uv、Node.js、pnpm，准备一个可连接的 PostgreSQL 开发库，然后执行 `make setup`。
   - 版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 与各自的 lockfile 为准。
   - Agent 挂载 `shot_video` 或启用视频编辑时，PATH 中还要有 `ffmpeg` 和 `ffprobe`。
2. 在仓库根目录创建 `.env`，`DATABASE_URL` 指向开发库，密钥不入库。
   - 要填哪些变量、各项能力怎样启用，见[配置模型](../server/src/iclip/config/models.py)与[配置与装配](architecture.md#2-配置与装配)；缺少变量时，启动会列出变量名。
3. 把一份 `server/configs/`（`config.yaml`）、`server/agents/`（`agents.yaml`、各 agent 目录）和 `server/skills/`（一个子目录一个 skill）放到本机。这三个目录不进仓库，修改后保存即生效；不挂 skill 时可以没有 `skills/`。
   - 默认的 `storyboard` Agent 需要视频理解、媒体生成和对象存储。只跑基础对话时，去掉这条 Agent 声明和 `config.yaml` 的 `video`、`shot_video` 段，另声明一条不挂这些能力的 Agent。
4. 迁移数据库并启动后端：

   ```bash
   make db-upgrade   # 已有数据的库先备份
   make dev          # http://localhost:7788，健康检查 /healthz
   ```

5. 另开一个终端启动前端：

   ```bash
   cd web && pnpm dev   # http://localhost:3013，/api 经同源代理转到后端
   ```

   - 只看前端时用 `pnpm dev:mock`，不连后端。端口与代理目标见[前端启动参数](../web/README.md#启动参数)。

6. 要在本机导出整片时，再开一个终端起渲染服务，并在 `.env` 把 `WHOLE_FILM_RENDER_URL` 设为 `http://localhost:8080`：

   ```bash
   cd render && RENDER_ALLOWED_MEDIA_HOSTS=<素材主机> RENDER_REGISTRY_ROOT=../web/public/hyperframes pnpm dev
   ```

   - 组件库用 `make setup` 同步到 `web/public/hyperframes/` 的那一份；Chrome 由 `PRODUCER_HEADLESS_SHELL_PATH` 指定，不设时用 `~/.cache/puppeteer` 里装好的 chrome-headless-shell（版本与 [render/Dockerfile](../render/Dockerfile) 里的一致，用 `npx @puppeteer/browsers install chrome-headless-shell@<版本> --path ~/.cache/puppeteer` 安装），PATH 中还要有 `ffmpeg` 和 `ffprobe`。各变量的含义见 [config.ts](../render/src/config.ts)。

## 服务器部署

单机部署用 [deploy/compose.yaml](../deploy/compose.yaml)，起后端、前端与整片渲染服务三个容器，镜像从 ACR 拉取。

1. 安装 NVIDIA 驱动与 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。后端与渲染服务的容器都要申请显卡，申请不到就起不来。
   - 没有显卡：删掉 compose.yaml 里 `server` 与 `render` 的 `deploy` 段，改用软件编解码与软件渲染。
   - 确认后端用上了显卡：启动日志「本地视频编解码已选定」那一条的 `codec` 为 `nvenc`；渲染服务见[整片渲染服务](#整片渲染服务)。
2. 在服务器现有的 Postgres 上，以管理员身份给本项目建一个独占的库和账号：

   ```sql
   CREATE ROLE iclip LOGIN PASSWORD '<密码>';
   CREATE DATABASE iclip OWNER iclip;
   ```

3. 在服务器上建一个部署目录，放入：
   - `compose.yaml`
   - `.env`：镜像与端口变量见 compose.yaml 文件头，应用变量见[配置模型](../server/src/iclip/config/models.py)，`DATABASE_URL` 指向上一步建的库
   - `configs/`、`agents/`、`skills/`：后端只读挂载，镜像里没有
   - 服务器是与 OSS 桶同地域的阿里云 ECS 或在其 VPC 内时：在 `.env` 把 `OSS_INTERNAL_ENDPOINT` 设为该地域的内网 endpoint（如 `https://oss-cn-shenzhen-internal.aliyuncs.com`），服务端读写和下载对象走内网，浏览器直传仍用 `OSS_ENDPOINT`；不设则全部走 `OSS_ENDPOINT`。
   - 整片导出：在 `.env` 把 `WHOLE_FILM_RENDER_URL` 设为渲染服务在 compose 网络里的地址（如 `http://render:8080`），要求同时配了 OSS；不设则导出端点答「整片导出没有开通」。渲染服务的 `RENDER_ALLOWED_MEDIA_HOSTS` 要列出它会取素材的主机：本桶的内网 host `<OSS_BUCKET>.<OSS_INTERNAL_ENDPOINT 的 host>`（没配内网 endpoint 时是 `<OSS_BUCKET>.<OSS_ENDPOINT 的 host>`），以及上游视频服务发布出片的主机。
4. 在 OSS 控制台给桶加一条生命周期规则，清掉导出的临时整片：进入这个 Bucket →「数据管理」→「生命周期」→「创建规则」，状态选启用，策略选按前缀匹配，前缀填 `iclip/agent/whole-film-exports/`，文件过期策略选按天数、1 天后删除，保存。只对这个前缀生效，桶里别的对象不受影响。
5. 用有 DDL 权限的账号执行目标版本的数据库迁移。部署和服务启动都不会自动迁移。
6. 登录镜像仓库，拉取并启动：

   ```bash
   docker login <ACR_REGISTRY>   # 与 .env 的 ACR_REGISTRY 相同
   docker compose pull && docker compose up -d
   curl http://localhost/api/healthz
   ```

7. 设置首个管理员：
   - 用 SSO 登录：在 `.env` 设置 `ROOT_EMAIL`，这个邮箱首次登录即为 root。
   - 用密码注册：执行 `docker compose run --rm server python -m scripts.admin set-roles <账号> root,editor`。

后端只跑 1 个 worker。实时订阅存在进程内存里，增加 worker 前先看[运行、记录与订阅](architecture.md#5-运行记录与订阅)。

### 整片渲染服务

`render` 容器只在 compose 网络里监听 8080，不对外开端口，后端经 `WHOLE_FILM_RENDER_URL=http://render:8080` 调它（职责见[架构](architecture.md#3-身份与模块协作)）。

- **素材主机**：`.env` 里的 `RENDER_ALLOWED_MEDIA_HOSTS`（逗号分隔，带端口就写上端口）由 compose 传给它，取值见上面第 3 步。不设时容器启动即退出，日志是「配置不完整」；导出请求里的素材主机不在名单里答 400 `media-host-not-allowed`。
- **显卡**：compose 给它申请 `gpu, compute, utility, video, graphics` 五项能力，Chrome 用显卡渲染要 `graphics`，NVENC 编码要 `video`。确认用上了显卡：`docker compose exec render node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"` 的 `gpu` 为 `hardware`，启动日志「渲染环境」那一条的 `gpu` 为 `hardware`、`videoEncoder` 为 `nvenc`。是 `software` 时另有一条 warning「浏览器使用软件渲染」，渲染照常，只是更慢。
- **字体**：组件用的网页字体只用组件库里的字体文件，西文用原字体、中文用 Noto Sans SC，与编辑器预览一致；镜像另带 Noto CJK 兜底系统字体。渲染期间不从外网取字体。
- **资源**：Chrome 要共享内存，compose 设了 `shm_size: 2gb`；临时项目目录在卷 `render-tmp`，每次导出结束即删。导出排队、进度只在内存里，重启容器会丢掉进行中和刚结束的导出。
- **日志**：`docker compose logs render`，每行一个 JSON，`event` 是中文短句；一次导出按 `exportId` 串起「导出已排队」到「导出完成」或「导出失败」。
- **上线核对**：部署或升级后导出一条片尾用 `logo-brand-close`、字标写中文的整片，与编辑器预览对比片尾字标的大小和位置。这类组件在自己的脚本里量字宽来定字号，HyperFrames 只在运行组件脚本前等正在加载的字体（最多 5 秒），量的时候字形若还没到位，字标大小就与预览不同；Apple Silicon 上模拟运行 amd64 镜像时字标小约 6%，原生运行的导出与预览一致。差得明显时检查容器的 CPU 与显卡（`/health` 的 `gpu`）。

### 升级

1. 新版本有表结构变化时，先执行该版本的数据库迁移。
2. 把 `.env` 的 `IMAGE_TAG` 改成新版本，再执行 `docker compose pull && docker compose up -d`。

### 改配置

模型、agent、skill 与参考资料只在服务器的 `configs/`、`agents/`、`skills/` 里，不随镜像发版。修改后保存即生效，机制见[配置与装配](architecture.md#2-配置与装配)。

- 配置写错时，原因在 `docker compose logs server` 和 `/healthz` 的 `config` 段。
- 手动重载：`docker compose kill -s HUP server`。
- 以下两种情况要执行 `docker compose up -d`（`restart` 不会重读 `.env`）：
  - 改了 `models` 与 agents 以外的配置段，此时 `/healthz` 会标 `needs_restart`
  - `.env` 新增了变量，比如新模型用了新的 key 变量

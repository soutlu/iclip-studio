# 本地启动与服务器部署

本文讲怎样在本机跑起整套服务，以及怎样部署、升级服务器和修改线上配置。镜像的构建与上传见[发版与镜像发布](release.md)。

## 本地启动

1. 安装 Python、uv、Node.js、pnpm，准备一个可连接的 PostgreSQL 开发库，然后执行 `make setup`。
   - 版本以 [server/pyproject.toml](../server/pyproject.toml)、[web/package.json](../web/package.json) 与各自的 lockfile 为准。
   - Agent 挂载 `shot_video` 或启用视频编辑时，PATH 中还要有 `ffmpeg` 和 `ffprobe`。
2. 在仓库根目录创建 `.env`，`DATABASE_URL` 指向开发库，密钥不入库。
   - 要填哪些变量、各项能力怎样启用，见[配置模型](../server/src/iclip/config/models.py)与[配置与装配](architecture.md#2-配置与装配)；缺少变量时，启动会列出变量名。
3. 把一份 `server/configs/`（`config.yaml`）和 `server/agents/`（`agents.yaml`、各 agent 目录、`skills/`）放到本机。这两个目录不进仓库，修改后保存即生效。
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

## 服务器部署

单机部署用 [deploy/compose.yaml](../deploy/compose.yaml)，起后端和前端两个容器，镜像从 ACR 拉取。

1. 安装 NVIDIA 驱动与 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。后端容器要申请显卡做视频编解码，申请不到就起不来。
   - 没有显卡：删掉 compose.yaml 里 `server` 的 `deploy` 段，改用软件编解码。
   - 确认用上了显卡：启动日志「本地视频编解码已选定」那一条的 `codec` 为 `nvenc`。
2. 在服务器现有的 Postgres 上，以管理员身份给本项目建一个独占的库和账号：

   ```sql
   CREATE ROLE iclip LOGIN PASSWORD '<密码>';
   CREATE DATABASE iclip OWNER iclip;
   ```

3. 在服务器上建一个部署目录，放入：
   - `compose.yaml`
   - `.env`：镜像与端口变量见 compose.yaml 文件头，应用变量见[配置模型](../server/src/iclip/config/models.py)，`DATABASE_URL` 指向上一步建的库
   - `configs/`、`agents/`：后端只读挂载，镜像里没有
   - 服务器是与 OSS 桶同地域的阿里云 ECS 或在其 VPC 内时：在 `.env` 把 `OSS_INTERNAL_ENDPOINT` 设为该地域的内网 endpoint（如 `https://oss-cn-shenzhen-internal.aliyuncs.com`），服务端读写和下载对象走内网，浏览器直传仍用 `OSS_ENDPOINT`；不设则全部走 `OSS_ENDPOINT`。
4. 用有 DDL 权限的账号执行目标版本的数据库迁移。部署和服务启动都不会自动迁移。
5. 登录镜像仓库，拉取并启动：

   ```bash
   docker login <ACR_REGISTRY>   # 与 .env 的 ACR_REGISTRY 相同
   docker compose pull && docker compose up -d
   curl http://localhost/api/healthz
   ```

6. 设置首个管理员：
   - 用 SSO 登录：在 `.env` 设置 `ROOT_EMAIL`，这个邮箱首次登录即为 root。
   - 用密码注册：执行 `docker compose run --rm server python -m scripts.admin set-roles <账号> root,editor`。

后端只跑 1 个 worker。实时订阅存在进程内存里，增加 worker 前先看[运行、记录与订阅](architecture.md#5-运行记录与订阅)。

### 升级

1. 新版本有表结构变化时，先执行该版本的数据库迁移。
2. 把 `.env` 的 `IMAGE_TAG` 改成新版本，再执行 `docker compose pull && docker compose up -d`。

### 改配置

模型、agent、skill 与参考资料只在服务器的 `configs/`、`agents/` 里，不随镜像发版。修改后保存即生效，机制见[配置与装配](architecture.md#2-配置与装配)。

- 配置写错时，原因在 `docker compose logs server` 和 `/healthz` 的 `config` 段。
- 手动重载：`docker compose kill -s HUP server`。
- 以下两种情况要执行 `docker compose up -d`（`restart` 不会重读 `.env`）：
  - 改了 `models` 与 agents 以外的配置段，此时 `/healthz` 会标 `needs_restart`
  - `.env` 新增了变量，比如新模型用了新的 key 变量

# 发版与镜像发布指南

本文说明正式发版与线上紧急热修的操作步骤，以及 Docker 镜像的构建与发布机制。
- **重要提醒**：打发版标签 `vX.Y.Z` 前，必须先获得开发者的明确确认（见 [AGENTS.md](../AGENTS.md#3-分支与交付)）。
- 镜像打包完成后的服务器升级步骤，见[升级](deploy.md#升级)。

每次推送 `vX.Y.Z` 标签都会并行构建全部四个镜像（标签均为 `vX.Y.Z`，见[标签与缓存策略](#标签与缓存策略)）。线上服务器分开记录版本并支持独立升级：
- **应用**（`IMAGE_TAG`）：`iclip-server`、`iclip-web`、`iclip-render`
- **运行时**（`RUNTIME_IMAGE_TAG`）：`iclip-runtime`（运行时 + 视频插件）

---

## 发版与热修

发版即给通过全量 `ci` 的提交打版本标签。

| 场景 | 做法 |
|---|---|
| **正式发版** | 按[发版步骤](#发版步骤)给 `main` 上的提交打 `vX.Y.Z` |
| **紧急热修（`main` 可直接发）** | 修复按日常流程合入 `main`，再按[发版步骤](#发版步骤)发新版本 |
| **紧急热修（`main` 含暂不发布的改动）** | 修复先按日常流程合入 `main`，再按[热修步骤](#热修步骤)在 `release/vX.Y` 上发版 |

### 发版步骤

1. **准备：查看上线前摘要并运行全量 `ci`**：
   ```bash
   make release-check                    # 发 main 的最新提交
   make release-check REF=release/vX.Y   # 发热修分支的最新提交
   ```
   命令会拉取远端分支最新提交，对比该分支上一个 `vX.Y.Z` 标签打印**上线前摘要**（仅在本地查看摘要、不联网触发可用 `bash scripts/release.sh summary <提交>`）：
   - **提交数**：本次包含的提交数量。
   - **运行时是否需升级**：`runtime.ref`、`plugins/video/`、`deploy/runtime-video/` 有改动时需升级（运行时自身的数据库迁移在私有项目 Cue 中维护，需前往 Cue 对照）。
   - **后端迁移**：列出新增迁移文件，并按关键字提示疑似删改已有结构的操作（以迁移源码为准，规则见[后端的持久化与迁移](architecture.md#后端的持久化与迁移)）。
   - **配置与编排变更**：列出有改动的配置与编排文件，升级前需在服务器上对照补齐。
   - **建议升级命令**：两边均需升级时，需结合本批 PR 说明中的「升级顺序」（写法见 [AGENTS.md](../AGENTS.md#3-分支与交付)，可用 `gh pr list --state merged --search '"升级顺序" in:body' --json number,title,mergedAt` 检索）确定先后参数。

   随后命令检查该提交是否已有成功的手动全量 `ci`（无则自动触发并等待完成；若期间分支合入新提交或检查失败则报错退出，处理后重跑即可），最后输出带完整提交哈希的第二步命令。

2. **打标签并创建 GitHub Release（须开发者确认）**：
   将摘要交由开发者确认并定下版本号后，执行第一步末尾输出的命令：
   ```bash
   make release VERSION=vX.Y.Z SHA=<提交>
   ```
   命令再次核验版本号、标签唯一性与该提交的全量 `ci` 状态（任一不通过即中止），锁定该提交创建 GitHub Release（自动填入上线前摘要与变更列表），推送标签触发镜像流水线。
   - **版本号规则（`vX.Y.Z`）**：由开发者确定。`X` 代表重大架构重构或不兼容变更，`Y` 代表向下兼容的新功能，`Z` 代表问题修复（在 `v0.Y.Z` 阶段，较大改动递增 `Y`，日常修复递增 `Z`）。

3. **等待镜像打包完成并上线**：
   创建 Release 只触发镜像构建，不会自动部署。运行 `make release` 末尾打印的查询命令确认流水线输出 `completed success` 后，按 Release 说明中的升级命令及[升级](deploy.md#升级)更新线上环境。

> **首次切换至统一标签注意**：升级到第一个包含运行时镜像的 `vX.Y.Z` 版本时，线上运行时仍停留在旧的 `runtime-v*` 镜像上，无论摘要是否提示运行时变更，均须同时升级应用与运行时（并先更新服务器上的 `upgrade.sh`，见[升级](deploy.md#升级)）。

### 热修步骤

用于 `main` 含有暂不发布的改动、仅需将修复合入线上版本的场景（`vX.Y` 取线上版本号前两段）：

1. **修复先合入 `main`**：按日常流程提 PR 合入 `main`，记下合并后的 `<修复提交>`。

2. **从线上版本标签切出热修分支**（同一 `vX.Y` 已有该分支时直接复用）：
   ```bash
   git fetch origin --tags
   git push origin "<线上版本标签>^{commit}:refs/heads/release/vX.Y"
   ```

3. **将修复 cherry-pick 到热修分支并提 PR**：
   ```bash
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/release/vX.Y
   cd .claude/worktrees/<任务名> && make runtime
   git cherry-pick <修复提交>
   git push -u origin HEAD
   gh pr create --base release/vX.Y
   gh pr merge <n> --auto --squash
   ```
   因目标分支不是 `main`，PR 会自动执行全量 `ci` 并在通过后合入。

4. **在热修分支上发版**：按[发版步骤](#发版步骤)执行，第一步指定 `make release-check REF=release/vX.Y`（摘要与变更列表均从线上版本标签算起）。
   > **注**：从 `v0.17.x` 及更早标签切出的热修分支仍携带旧版流水线（不支持手动触发 `ci`，且只构建三个应用镜像）。此类分支跳过 `make release-check`，待热修 PR 的全量 `ci` 通过并合入后，经开发者确认直接创建 Release，线上仅升级应用：
   > ```bash
   > git fetch origin
   > gh release create vX.Y.Z --target "$(git rev-parse origin/release/vX.Y)" --title vX.Y.Z --generate-notes --notes-start-tag <线上版本标签>
   > ```

### 换运行时版本

运行时镜像打包的运行时代码来自私有项目 Cue，版本由根目录的 `runtime.ref` 钉住，镜像按发版提交上的 `runtime.ref` 检出 Cue 打包。换运行时版本就是一个普通的 PR，随下一个版本发布：

1. 在 Cue 的 `main` 上打 `vA.B.C` 标签（Cue 自己的版本号，和本仓库的版本号没有对应关系）。
2. 本仓库执行 `make runtime-bump REF=vA.B.C`，然后按日常流程提 PR 合入 `main`。

---

## 镜像与流水线

项目共构建四个 Docker 镜像（镜像名称与 [deploy/compose.yaml](../deploy/compose.yaml) 保持一致），由 GitHub Actions 工作流 [release-images](../.github/workflows/release-images.yml) 并行构建并直接推送到阿里云容器镜像服务（ACR）：

| 镜像名称 | Dockerfile 位置 | 包含内容与构建说明 |
|---|---|---|
| `iclip-server` | [server/Dockerfile](../server/Dockerfile) | 视频业务后端（构建上下文包含 `server/` 与 `plugins/video/`，不含运行时） |
| `iclip-runtime` | [deploy/runtime-video/Dockerfile](../deploy/runtime-video/Dockerfile) | Agent 运行时服务（安装部署包 `deploy/runtime-video`，将按 `runtime.ref` 检出的 `runtime/` 与 `plugins/video` 打包在一起） |
| `iclip-web` | [web/Dockerfile](../web/Dockerfile) | 前端静态资源与 Nginx（通过 [web/nginx.conf](../web/nginx.conf) 将 `/api` 转发给后端；不含组件库，组件库独立挂载，见[发布组件库](deploy.md#发布组件库)） |
| `iclip-render` | [render/Dockerfile](../render/Dockerfile) | 成片渲染服务（编入前端 final-cut 主文件写法 `composition/`；因 Chrome Headless Shell 仅提供 x86_64 Linux 包，该镜像固定为 `linux/amd64` 架构） |

### 标签与缓存策略

- **版本标签**：推送 `vX.Y.Z` tag 时，流水线每次都构建并上传全部四个镜像，镜像标签都是 `vX.Y.Z`；当四个镜像全部上传并校验摘要成功，且该 tag 是全部 `vX.Y.Z` 标签里版本号最大的时，才会更新四个镜像的 `latest` 标签，否则跳过并写进运行摘要，所以热修旧版本或重跑旧版本不会回退 `latest`。比较时只看 `vX.Y.Z` 格式的标签。
- **其他标签格式**：流水线只由 `v` 开头的标签触发，格式不是 `vX.Y.Z` 的报错退出，不构建镜像。
- **分支测试打包**：在 GitHub Actions 页面手动选择某个分支触发流水线时，构建全部四个镜像，只会生成 `branch-<分支名>` 镜像，不会覆盖正式版本和 `latest`。
- **构建缓存**：后端、前端、渲染三个镜像自动使用 GitHub Container Registry（GHCR）保存 Docker 层缓存，无需额外配置 GHCR 密钥；运行时镜像的层里有私有的运行时代码，不读写 GHCR 缓存，每次冷构建。四个镜像都只向 ACR 上传远端缺失的镜像层。
- **构建失败处理**：如果是网络抖动或 ACR 凭证过期导致失败，修复后直接在原运行页面点击 **Re-run failed jobs** 即可复用缓存重跑；如果需要修改代码或 Dockerfile，则必须走 PR 合入后用新版本号重新发版。

### 仓库密钥配置

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置 Secrets：`ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME`、`ACR_PASSWORD`，以及 `CUE_DEPLOY_KEY`（运行时项目 Cue 的只读部署密钥的私钥，CI 的 Python 检查、缓存预热与运行时镜像构建用它检出 Cue）。

### 本地手动构建镜像

在仓库根目录执行（每个 Dockerfile 均配有对应的 `.dockerignore` 控制构建上下文大小；构建 `iclip-runtime` 前先执行 `make runtime`；在 Apple Silicon Mac 上构建 `iclip-render` 需指定 `--platform linux/amd64`）：

```bash
docker build -f server/Dockerfile -t iclip-server:local .
docker build -f deploy/runtime-video/Dockerfile -t iclip-runtime:local .
docker build -f web/Dockerfile -t iclip-web:local .
docker build --platform linux/amd64 -f render/Dockerfile -t iclip-render:local .
```

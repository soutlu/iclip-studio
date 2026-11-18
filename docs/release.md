# 发版与镜像发布指南

本文说明正式发版与线上紧急热修的操作步骤，以及 Docker 镜像的构建与发布机制。
- **重要提醒**：打发版标签 `vX.Y.Z` 前，必须先获得开发者的明确确认（见 [AGENTS.md](../AGENTS.md#3-分支与交付)）。
- 镜像打包完成后的服务器升级步骤，见[升级](deploy.md#升级)。

一个 `vX.Y.Z` 标签打全部四个镜像，镜像标签都是 `vX.Y.Z`（见[标签与缓存策略](#标签与缓存策略)）。服务器上应用（`iclip-server`、`iclip-web`、`iclip-render`，部署变量 `IMAGE_TAG`）和运行时（`iclip-runtime`，运行时 + 视频插件，部署变量 `RUNTIME_IMAGE_TAG`）的版本分开记，可以分开升级。

---

## 发版与热修

发版就是给通过全量 `ci` 的提交打标签。

| 场景 | 做法 |
|---|---|
| **正式发版** | 按[发版步骤](#发版步骤)给 `main` 上的提交打 `vX.Y.Z` |
| **紧急热修，`main` 可以直接发** | 修复按日常流程合入 `main`，再按[发版步骤](#发版步骤)发一个新版本 |
| **紧急热修，`main` 上有还不能发的改动** | 修复先按日常流程合入 `main`，再按[热修步骤](#热修步骤)在 `release/vX.Y` 上发版 |

### 发版步骤

1. **在待发的提交上跑全量 `ci`**：
   记下 `main` 的最新提交，手动触发 `ci`（手动触发总是全量检查）：
   ```bash
   git fetch origin
   sha=$(git rev-parse origin/main)
   gh workflow run ci.yml --ref main
   ```
   等这次运行结束，确认它检查的提交（`headSha`）就是 `$sha`，且结论是 `success`：
   ```bash
   gh run list --workflow ci.yml --event workflow_dispatch --branch main --limit 1 --json headSha,status,conclusion
   ```
   `headSha` 不等于 `$sha` 说明触发前 `main` 又合入了新提交，重新执行这一步。

2. **打标签并创建 GitHub Release（须开发者确认）**：
   给通过检查的这个提交（不是此刻 `main` 的最新提交）创建 Release，会自动推送标签并触发镜像打包流水线：
   ```bash
   gh release create vX.Y.Z --target "$sha" --title vX.Y.Z --generate-notes --notes-start-tag <上一个 vX.Y.Z>
   git fetch --tags
   ```
   - **版本号规则（`vX.Y.Z`）**：由开发者确定。`X` 代表重大架构重构或不兼容变更，`Y` 代表向下兼容的新功能，`Z` 代表问题修复（在 `v0.Y.Z` 阶段，较大改动递增 `Y`，日常修复递增 `Z`）。

3. **等待镜像打包完成并上线**：
   创建 Release 只会触发构建镜像，不会自动部署到服务器。运行以下命令确认流水线输出 `completed success` 后，再按[升级](deploy.md#升级)更新线上环境：
   ```bash
   gh api "repos/{owner}/{repo}/actions/workflows/release-images.yml/runs?event=push&branch=vX.Y.Z" --jq 'first(.workflow_runs[]) | .status + " " + .conclusion'
   ```
   运行时只在上一个版本标签以来 `runtime.ref`、`plugins/video/`、`deploy/runtime-video/` 有改动时升级，有输出就是有改动：
   ```bash
   git diff --stat <上一个 vX.Y.Z> vX.Y.Z -- runtime.ref plugins/video deploy/runtime-video
   ```
   第一个带运行时镜像的 `vX.Y.Z` 版本两边都要升级：服务器上的运行时还在 `runtime-v*` 标签的镜像上，上面的判断对它不适用。

### 热修步骤

用于 `main` 上有还不能发的改动、只想把修复发到线上版本的情况。`vX.Y` 取线上版本号的前两段。

1. **修复先合入 `main`**：按日常流程提 PR 合入 `main`，记下它在 `main` 上的提交 `<修复提交>`。

2. **从线上版本的标签切出热修分支**（同一个 `vX.Y` 已有热修分支时直接复用）：
   ```bash
   git fetch origin --tags
   git push origin "<线上版本标签>^{commit}:refs/heads/release/vX.Y"
   ```

3. **把修复 cherry-pick 到热修分支并提 PR**：
   ```bash
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/release/vX.Y
   cd .claude/worktrees/<任务名> && make runtime
   git cherry-pick <修复提交>
   git push -u origin HEAD
   gh pr create --base release/vX.Y
   gh pr merge <n> --auto --squash
   ```
   目标分支不是 `main`，`ci` 跑全量检查，通过后自动合入。

4. **在热修分支上发版**：热修 PR 的 `ci` 已经是全量检查，合入后不用再手动触发。记下热修分支的最新提交，从[发版步骤](#发版步骤)第 2 步做起，`--notes-start-tag` 填线上版本标签：
   ```bash
   git fetch origin
   sha=$(git rev-parse origin/release/vX.Y)
   ```
   标签触发的是该提交里的流水线：从 v0.17.x 及更早的标签切出的热修分支上打标签，只构建三个应用镜像，不构建运行时镜像。

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

# 发版与镜像发布指南

本文说明正式发版、线上紧急热修与热修回流的操作步骤，以及 Docker 镜像的构建与发布机制。
- **重要提醒**：创建或合并任何目标为 `main` 分支的 PR，都必须先获得开发者的明确确认（见 [AGENTS.md](../AGENTS.md#发版与热修)）。
- 镜像打包完成后的服务器升级步骤，见[本地启动与服务器部署](deploy.md#服务器部署)。

---

## 发版与热修

| 场景 | 分支方向 | 合并命令（均使用 `--merge` 保留合并节点，不用 Squash） |
|---|---|---|
| **正式发版** | `develop → main`（由开发者指定版本号后创建 PR） | 待 `ci` 通过且开发者确认后执行：`gh pr merge <n> --merge` |
| **紧急热修（Hotfix）** | 从 `origin/main` 检出独立 Worktree 修复，PR 指向 `main` | 待 `ci` 通过且开发者确认后执行：`gh pr merge <n> --merge` |
| **热修回流** | `main → develop`（把热修同步回开发分支） | 执行 `gh pr merge <n> --auto --merge`，`ci` 通过后自动合入 |

### 操作步骤

1. **手动合并 `main` 前核对 CI 状态**：
   确保该 PR 最新提交的 `ci` 检查已输出 `completed success`：
   ```bash
   sha=$(gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha)
   gh api "repos/{owner}/{repo}/commits/$sha/check-runs?check_name=ci" --jq '.check_runs[] | .status + " " + .conclusion'
   ```

2. **打标签并创建 GitHub Release**：
   PR 合入 `main` 后，确认 `main` 上的最新提交无误，执行以下命令创建 Release（会自动触发镜像打包流水线）：
   ```bash
   gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes
   git fetch --tags
   ```
   - **版本号规则（`vX.Y.Z`）**：由开发者确定。`X` 代表重大架构重构或不兼容变更，`Y` 代表向下兼容的新功能，`Z` 代表问题修复（在 `v0.Y.Z` 阶段，较大改动递增 `Y`，日常修复递增 `Z`）。

3. **等待镜像打包完成并上线**：
   创建 Release 只会触发构建镜像，不会自动部署到服务器。运行以下命令确认流水线输出 `completed success` 后，再按[服务器升级步骤](deploy.md#升级)更新线上环境：
   ```bash
   gh api "repos/{owner}/{repo}/actions/workflows/release-images.yml/runs?event=push&branch=vX.Y.Z" --jq 'first(.workflow_runs[]) | .status + " " + .conclusion'
   ```

---

## 镜像与流水线

项目共构建四个 Docker 镜像（镜像名称与 [deploy/compose.yaml](../deploy/compose.yaml) 保持一致），由 GitHub Actions 工作流 [release-images](../.github/workflows/release-images.yml) 并行构建并直接推送到阿里云容器镜像服务（ACR）：

| 镜像名称 | Dockerfile 位置 | 包含内容与构建说明 |
|---|---|---|
| `iclip-server` | [server/Dockerfile](../server/Dockerfile) | 视频业务后端（构建上下文包含 `server/`、`runtime/` 与 `plugins/video/`） |
| `iclip-runtime` | [runtime/Dockerfile](../runtime/Dockerfile) | Agent 运行时服务（安装部署包 `deploy/runtime-video`，将 `runtime` 与 `plugins/video` 打包在一起） |
| `iclip-web` | [web/Dockerfile](../web/Dockerfile) | 前端静态资源与 Nginx（通过 [web/nginx.conf](../web/nginx.conf) 将 `/api` 转发给后端；不含成片组件库，组件库独立挂载，见[发布组件库](deploy.md#发布组件库)） |
| `iclip-render` | [render/Dockerfile](../render/Dockerfile) | 成片渲染服务（编入前端合成代码与合同类型；因 Chrome Headless Shell 仅提供 x86_64 Linux 包，该镜像固定为 `linux/amd64` 架构） |

### 标签与缓存策略

- **正式版本标签**：推送 `vX.Y.Z` tag 时，流水线构建并上传四个镜像；当四个镜像全部上传并校验摘要成功，且该 tag 对应的提交仍是 `main` 分支最新提交时，才会同步更新 `latest` 标签。
- **分支测试打包**：在 GitHub Actions 页面手动选择某个分支触发流水线时，只会生成 `branch-<分支名>` 镜像，不会覆盖正式版本和 `latest`。
- **构建缓存**：流水线自动使用 GitHub Container Registry（GHCR）保存 Docker 层缓存，并只向 ACR 上传远端缺失的镜像层，无需额外配置 GHCR 密钥。
- **构建失败处理**：如果是网络抖动或 ACR 凭证过期导致失败，修复后直接在原运行页面点击 **Re-run failed jobs** 即可复用缓存重跑；如果需要修改代码或 Dockerfile，则必须走 PR 合入后用新版本号重新发版。

### 仓库密钥配置

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置 Secrets：`ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME`、`ACR_PASSWORD`。

### 本地手动构建镜像

在仓库根目录执行（每个 Dockerfile 均配有对应的 `.dockerignore` 控制构建上下文大小；在 Apple Silicon Mac 上构建 `iclip-render` 需指定 `--platform linux/amd64`）：

```bash
docker build -f server/Dockerfile -t iclip-server:local .
docker build -f runtime/Dockerfile -t iclip-runtime:local .
docker build -f web/Dockerfile -t iclip-web:local .
docker build --platform linux/amd64 -f render/Dockerfile -t iclip-render:local .
```

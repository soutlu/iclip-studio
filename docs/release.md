# 镜像发布

发版与热修的操作步骤、版本号规则见 [AGENTS.md](../AGENTS.md#3-分支与交付)；服务器上线与升级见 [README](../README.md#部署)。本文只讲镜像怎样构建和上传。

## 镜像与流水线

两个镜像：`iclip-server`（[server/Dockerfile](../server/Dockerfile)）与 `iclip-web`（[web/Dockerfile](../web/Dockerfile)，nginx 托管静态产物并把 `/api` 去前缀反代到后端，配置见 [web/nginx.conf](../web/nginx.conf)）。[release-images](../.github/workflows/release-images.yml) 在 GitHub Actions 上并行构建，经专用 DMIT 代理上传到 ACR，部署时从 ACR 拉取。

- **版本**：推送 `vX.Y.Z` 标签即构建并上传两个镜像。两个镜像都上传并核验成功、且该版本提交仍是 `main` 的最新提交时，才更新 `latest`。
- **试打包**：手动选择分支运行只生成 `branch-<分支名>` 镜像，不更新正式版本和 `latest`。
- **缓存**：GHCR 只保存构建缓存，下次打包复用没变的部分；上传 ACR 时只传远端缺少的层。工作流自动读写缓存，无需另配 GHCR 凭证。

## 仓库配置

Actions variables：`ACR_REGISTRY`、`ACR_NAMESPACE`；secrets：`ACR_USERNAME`、`ACR_PASSWORD`、`ACR_DMIT_CONFIG`。

`ACR_DMIT_CONFIG` 保存完整的 Mihomo 配置：HTTP/mixed 端口监听 `127.0.0.1:17891`，只有一个 DMIT 节点，所有代理流量固定走该节点，日志设为 `silent`；不含订阅、分流规则集或直连回退。节点参数只保存在 Secret 中，不提交到仓库。

## 代理与运行记录

每个镜像 job 在上传前启动独立代理并检查 ACR 连通性；只有上传步骤走代理，失败直接报错。job 结束时清理进程和临时配置，无需本机 Clash 在线。

运行 Summary 显示构建、代理、上传、摘要核验结果及上传耗时；日志保留每层进度和整个上传命令的实际耗时，不把 Skopeo 的本地读取速率当作上传网速。

## 失败处理

网络或凭证问题修好后，在原运行中点 **Re-run failed jobs**；重跑会重新构建和上传，能命中的缓存仍复用。需要改源码、Dockerfile 或工作流时，修复后重新走 PR，再用新版本号发布；重跑旧运行不会用到新代码。

## 本地构建

在仓库根目录执行。前端构建需要 `contract/` 中的共享样例，构建上下文由 [web/Dockerfile.dockerignore](../web/Dockerfile.dockerignore) 限定为前端和合同文件。

```bash
docker build -t iclip-server:local server
docker build -f web/Dockerfile -t iclip-web:local .
```

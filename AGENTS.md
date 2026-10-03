# AGENTS.md — 开发约定

先读本文与 [docs/CONTEXT.md](docs/CONTEXT.md)。修改后端时查 [docs/architecture.md](docs/architecture.md)，修改前端时再读 [web/AGENTS.md](web/AGENTS.md)。按任务查阅专项文档，入口见[文档地图](#文档地图)。

## 1. 命令与验证

命令在仓库根目录执行；前端专项命令见 [web/AGENTS.md](web/AGENTS.md)。

| 命令 | 用途 |
|---|---|
| `make setup` | 安装后端与前端依赖 |
| `make dev` | 启动后端；环境准备见 [README.md](README.md#启动指南) |
| `make db-upgrade` | 执行 Alembic 迁移；服务启动不自动建表 |
| `make check` | 后端 lint、格式、类型、依赖边界、常规测试，以及合同与文档对账；CI 已包含这些检查，本地不必跑 |
| `make web-check` | 前端 `ci:check`；CI 已包含这些检查，本地不必跑 |
| `make test` | 后端单元与无真实 LLM 的集成测试 |
| `make test-external` | 使用外部服务凭证的测试；环境与跳过规则见 [测试规范](docs/test-design.md) |
| `make contract` | 从后端导出 OpenAPI |
| `make docs-check` | 核对 Markdown 相对链接与 make 目标 |
| `make hooks` | 安装本地 pre-commit / pre-push hooks |

`make up` 调用本机维护、不入库的 `scripts/dev-up.sh`；新检出的仓库使用 README 的启动步骤。

本地只跑与改动相关的检查，通过后再推送；生产构建与全量 e2e 交给 CI，不在本地重复。

- 后端变更提交前执行 `make lint`、`make format-check` 与 `make typecheck`，并运行与改动直接相关的 pytest；改了端点再跑 `make contract`，改了模块依赖关系再跑 `make tach`。完整测试由 CI 运行，本地不重复跑 `make check`。前端变更另按 [web/AGENTS.md](web/AGENTS.md) 验证。
- 纯文档变更运行 `make docs-check`，修改 `web/` 下的 Markdown 另查格式；不为措辞新增业务测试。
- 修改 SSO / PMS 接入后，本地走通一次真实登录回调。
- 数据库测试只用一次性测试库或临时 schema；`TEST_DATABASE_URL` 不得指向业务库。迁移检查范围见 [测试规范](docs/test-design.md)。

### CI

| 工作流 | 触发 | 内容 |
|---|---|---|
| [ci](.github/workflows/ci.yml) | PR 打开、推送新提交、重新打开、修改目标分支；只改标题或正文时不运行检查，合入后的 push 不触发 | 每次都查文档；目标为 `develop` 时按改动路径选择后端、前端检查，前端只改了 `web/` 下的 Markdown 时只查格式，目标为其他分支（含 `main`）时两端都查；结果汇总为 `ci` |
| [cache-warm](.github/workflows/cache-warm.yml) | 推送 `develop`、`main`（含 PR 合入）；手动运行 | 只安装依赖、不跑检查，把依赖缓存存到该分支，供指向它的 PR 恢复 |
| [release-images](.github/workflows/release-images.yml) | 推送 `vX.Y.Z` tag；手动选择分支 | 构建并上传镜像，见[镜像发布](docs/release.md) |

选中的静态检查、构建与测试并行执行；集成测试每组使用独立 Postgres，前端单测与 e2e 按分片运行。本次选中了哪些端看运行 Summary，路径判定看 `scope` 日志。`ci` 结果怎样决定合并见[分支与交付](#3-分支与交付)。

## 2. 合同与实现边界

- 领域术语与不变量以 [docs/CONTEXT.md](docs/CONTEXT.md) 为准，两端共用。
- 对外端点、字段、状态码与端点权限由后端定义，以 [contract/openapi.json](contract/openapi.json) 为准，端点权限只在路由上声明、不在文档里手抄；它表达不了的约定写在 [contract/conventions.md](contract/conventions.md)。
- 修改端点的顺序：后端实现 → `make contract` → 在 `web/` 执行 `pnpm contract:generate`。前端消费生成类型与 zod，不手写端点 schema。
- 基础 token 以 [design-system.html](design-system.html) 为准。token 先改规范，再同步运行时 CSS，通过 `pnpm lint:design`；验收截图放 `.artifacts/design-qa/`。
- 不通过忽略类型错误、关闭 lint 或放宽检查配置消除失败；先修正实现。

日志使用 `structlog.stdlib.get_logger(__name__)`，事件为固定短句，变量用关键字参数；不拼接 f-string 或 `%s`。请求上下文由中间件绑定，业务只增加本层字段。第三方常态噪音在 [app/logging.py](server/src/iclip/app/logging.py) 的 `QUIET_LOGGERS` 调整。

```python
_logger.warning("生成任务提交失败", job_id=job.id, code=exc.code)
```

## 3. 分支与交付

两条线：日常开发进 `develop`，`ci` 通过即自动合入；发版与热修进 `main`，开发者确认后手动合入。`main` 与 `develop` 都不直接 push、不强推、不删除；`develop` 由规则集强制要求 `ci` 通过，但不要求分支先更新到最新，`develop` 前进不会让在途 PR 重跑 CI。

### 日常开发

开发在独立 worktree 中进行；主目录常驻 `develop`，不在其中开发或切换分支。

1. **建分支**：从最新 `origin/develop` 起步。
   ```bash
   git fetch origin
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/develop
   ```
   依赖未合 PR 时从该 PR 分支起步，PR 描述注明「依赖 #N」；#N squash 合入后，把本分支移到新的 `develop` 上再推送：`git fetch origin && git rebase --onto origin/develop <依赖分支名> && git push --force-with-lease`。
2. **本地验证**：按[命令与验证](#1-命令与验证)跑与改动相关的检查，通过后 commit。
3. **推送、开 PR、开自动合并**：在任务 worktree 中执行，确认 PR 目标是 `develop` 再开自动合并。
   ```bash
   git push -u origin HEAD
   gh pr create --base develop
   gh pr merge <n> --auto --squash
   ```
   `main` 没有必需检查，误指 `main` 的 PR 开自动合并会直接合入；先用 `gh pr edit <n> --base develop` 修正，`ci` 会按新目标重跑。

   PR 创建后不再编辑标题或正文：只改标题或正文不会触发 `ci`，自动合并会一直等不到结果；确需修改时，改完用 `gh pr update-branch <n>` 让 `ci` 重跑，`develop` 没有前进时改为推送一个空提交。
4. **等 `ci`**：通过即自动 squash 合入。失败时先读失败 job 的日志，e2e 另下载对应 `playwright-e2e-*` artifact 中的 trace（名称包含分片与运行次数）；与改动无关的偶发失败用 **Re-run failed jobs** 只重跑失败的 job，其余修复后推送新提交，自动合并保持开启。
5. **清理**：`gh pr view <n> --json state` 为 `MERGED`，且 `git worktree list` 确认是自己的 worktree、没有待保留的未提交修改后，回主目录执行：
   ```bash
   git pull --ff-only
   git worktree remove .claude/worktrees/<任务名>
   git branch -D <分支名>
   ```

### 发版与热修

`main` 是已交付版本，只接收发版和热修；**创建或合并目标为 `main` 的 PR 都必须先获开发者确认**。发版、热修、热修回流前读 [docs/release.md](docs/release.md#发版与热修)。

## 4. 文档维护

- 文档只写现行事实和可执行规则，不写过程、进度或历史解释；决策与取舍写进 ADR。
- 新增或修改 ADR 前读 [docs/adr/README.md](docs/adr/README.md)。
- 引用 ADR：普通文档陈述由 ADR 决定的事实且理由不显然时，在句末链到那篇 ADR；CONTEXT.md 只在开头链一次 `adr/`，词条里不链；代码注释只在理由不明显时写 `ADR-NNNN`。
- 一处事实只有一个权威来源，其余链接过去；文档归属见[文档地图](#文档地图)。
- 不复述类型、配置、检查工具已完整表达的细节；保留职责、入口、工具无法判断的约束与操作步骤。
- 发现文档与实现不一致时，结合合同、CONTEXT 与已接受的 ADR 判断；实现偏差不能自动变成新规范。
- 更新文档后核对命令、路径、链接，并运行 `make docs-check`。

### 文档地图

| 文档 | 何时读 | 内容与更新时机 |
|---|---|---|
| [README.md](README.md) | 本地启动或部署服务器前 | 简介、本地启动与服务器部署步骤变化时更新 |
| [AGENTS.md](AGENTS.md) | 任何改动前 | 全仓操作与开发规则变化时更新 |
| [web/AGENTS.md](web/AGENTS.md) | 修改前端时 | 前端命令、目录职责、边界、验证要求变化时更新 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 任何改动前 | 两端共用的领域术语、不变量和禁止逻辑变化时更新 |
| [docs/architecture.md](docs/architecture.md) | 修改后端时 | 后端分层、职责和装配机制变化时更新 |
| [docs/adr/](docs/adr/) | 新增或修改 ADR 前 | 已接受的架构决策与取舍，编写规则见目录内 README；决策变化时新增一篇并标明取代关系 |
| [docs/release.md](docs/release.md) | 发版、热修、热修回流或修改镜像流水线前 | 发版与热修步骤、版本号规则、镜像构建与上传流水线、仓库配置变化时更新 |
| [contract/openapi.json](contract/openapi.json) | 调用或修改端点前 | 后端端点变更后由 `make contract` 导出 |
| [contract/conventions.md](contract/conventions.md) | 修改端点或跨端约定前 | OpenAPI 无法表达的跨端约定变化时更新 |
| [design-system.html](design-system.html) | 修改 token 或界面样式前 | 基础 token 变化时更新 |
| [web/README.md](web/README.md) | 启动前端前 | 前端启动参数变化时更新 |
| [web/docs/frontend-implementation.md](web/docs/frontend-implementation.md) | 写或改前端组件与测试前 | 前端实现与测试约定变化时更新 |
| [docs/test-design.md](docs/test-design.md) | 写或改后端测试前 | 后端测试分层、边界和环境变化时更新 |
| [docs/tool-design.md](docs/tool-design.md) | 改 Agent 工具的名称、描述、参数前 | Agent 工具面向模型的接口与文字规范变化时更新 |

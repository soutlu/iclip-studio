# AGENTS.md — 开发约定

开始任何开发前请先阅读本文与 [docs/CONTEXT.md](docs/CONTEXT.md)：
- 修改后端或视频插件时，查阅 [docs/architecture.md](docs/architecture.md)。
- 运行时在私有项目 Cue 里单独开发，按它自己的 `AGENTS.md` 与 `docs/` 执行；本仓库用根目录的 `runtime.ref` 钉住运行时版本，`make runtime` 按它把 Cue 检出到 `runtime/`（不进本仓库）。
- 修改前端时，查阅 [web/AGENTS.md](web/AGENTS.md)。
- 其他专项文档入口见文末[文档地图](#文档地图)。

---

## 1. 命令与验证

以下命令在仓库根目录执行（前端专属命令见 [web/AGENTS.md](web/AGENTS.md)）：

| 命令 | 用途 |
|---|---|
| `make setup` | 先执行 `make runtime`，再安装后端、视频插件与前端依赖 |
| `make runtime` | 按 `runtime.ref` 把运行时项目 Cue 检出到 `runtime/`，需要能读私有仓库 `soutlu/Cue`；`runtime/` 已存在但不是 Git 检出时报错退出，需先手动移走 |
| `make dev` | 启动视频后端与 Agent 运行时服务（环境准备见[本地启动](docs/deploy.md#本地启动)） |
| `make db-upgrade` | 执行后端与运行时两边的 Alembic 数据库迁移（服务启动时不会自动建表） |
| `make check` | 运行全套静态检查与常规测试（包含 `plugins/video/`、`server/` 的 lint、格式、类型检查、依赖边界、单测/集成测试，以及 OpenAPI 合同、锁文件与文档链接检查）。CI 会自动跑，本地无需全量执行 |
| `make web-check` | 运行前端全套检查（`pnpm ci:check`）。CI 会自动跑，本地无需全量执行 |
| `make test` | 运行 `plugins/video/` 与 `server/` 的单元测试及不依赖真实大模型的集成测试 |
| `make test-external` | 运行需要真实外部服务凭证的测试（环境配置与跳过规则见[测试规范](docs/test-design.md)） |
| `make contract` | 导出视频后端的 `contract/openapi.json` |
| `make docs-check` | 检查全仓 Markdown 相对路径链接是否有效、文中提到的 `make` 目标是否存在 |
| `make lock-check` | 检查运行时部署镜像的锁文件 `deploy/runtime-video/uv.lock` 是否与项目依赖一致，并确保与 `server/uv.lock` 中的共有包版本完全一致 |
| `make hooks` | 安装本地 Git `pre-commit` / `pre-push` 钩子 |

> 注：`make up` 调用的是开发者本机自用的 `scripts/dev-up.sh`（不入库）；新克隆的仓库请按[本地启动](docs/deploy.md#本地启动)的步骤启动。

### 本地按需验证原则

本地只跑与本次改动直接相关的检查，通过后再推送；耗时的生产构建与全量 E2E 测试交给 CI 执行：

- **修改 Python 代码（`server/`、`plugins/video/`）**：提交前执行 `make lint`、`make format-check` 和 `make typecheck`，并运行与改动直接相关的 `pytest` 用例。
  - 如果改了 HTTP 接口，额外运行 `make contract`；
  - 如果改了模块间的导入关系，额外运行 `make tach`；
  - 如果改了 Python 依赖包，额外运行 `make lock-check`。
- **修改成片渲染服务（`render/`，或其引用的前端合成代码、组件目录、生成合同）**：在 `render/` 目录下执行 `pnpm lint`、`pnpm typecheck` 和 `pnpm test`（若本机未安装 `chrome-headless-shell`，真实渲染集成测试会自动跳过，需在汇报中说明）。
- **纯文档修改**：运行 `make docs-check`；若修改了 `web/` 目录下的 Markdown，还需在 `web/` 下运行 `pnpm format:check`。
- **修改 SSO / PMS 登录接入**：必须在本地完整走通一次真实的登录回调流程。
- **数据库测试安全**：测试只能连接一次性测试库或临时 Schema，`TEST_DATABASE_URL` 严禁指向真实业务数据库（详见[测试规范](docs/test-design.md)）。
- **密钥泄露扫描（Gitleaks）**：本地提交钩子会扫描暂存区，CI 的 `secrets` 任务会扫描完整 Git 历史。两处共用 [.gitleaks.toml](.gitleaks.toml) 配置；如有误报，只能按「具体文件路径 + 固定测试值」精确放行，禁止将整个测试目录加入白名单。

### CI 工作流

| 工作流 | 触发时机 | 执行内容 |
|---|---|---|
| [ci](.github/workflows/ci.yml) | 打开 PR、推送新提交、重新打开 PR 或修改目标分支（仅修改 PR 标题/正文或合并后的 push 不触发） | 1. 必查文档链接与 Git 历史密钥泄露。<br>2. 目标分支为 `develop` 时，按改动路径智能选择检查范围（`server` 依赖 `plugins/video`，两者都按 `runtime.ref` 检出的运行时安装：改了 `plugins/video` 或 `runtime.ref` 都查插件与 `server`；仅改 `web/*.md` 时只查前端格式；运行时自身的检查归 Cue）。<br>3. 目标为其他分支（含 `main`）时全量检查。所有结果汇总为 `ci` 状态 |
| [cache-warm](.github/workflows/cache-warm.yml) | 推送到 `develop` 或 `main`（含 PR 合入）、手动触发 | 仅安装依赖并保存缓存，供后续 PR 加速恢复 |
| [release-images](.github/workflows/release-images.yml) | 推送 `vX.Y.Z` 或 `runtime-vX.Y.Z` 标签、手动指定分支触发 | `vX.Y.Z` 构建并上传后端、前端、渲染三个镜像，`runtime-vX.Y.Z` 只构建并上传运行时镜像，手动运行构建全部四个（见[发版与镜像发布](docs/release.md)） |

---

## 2. 合同与实现边界

- **领域概念统一**：前后端共用同一套领域术语与系统不变量，以 [docs/CONTEXT.md](docs/CONTEXT.md) 为准。
- **接口合同先行**：对外 HTTP 接口路径、字段、状态码与权限由后端路由定义，导出至 [contract/openapi.json](contract/openapi.json)；OpenAPI 无法表达的跨端约定记录在 [contract/conventions.md](contract/conventions.md)。
- **修改接口的标准顺序**：先改后端实现 → 根目录运行 `make contract` 导出合同 → 在 `web/` 目录运行 `pnpm contract:generate` 生成前端类型与 Zod Schema（前端直接消费生成物，禁止手写接口 Schema）。
- **设计系统 Token**：基础视觉 Token 以 [design-system.html](design-system.html) 为准。修改 Token 时先改规范文件，再同步 CSS，并通过 `pnpm lint:design` 检查；UI 验收截图统一放在 `.artifacts/design-qa/`。
- **不掩盖错误**：严禁通过 `@ts-ignore`、`# type: ignore`、关闭 lint 规则或放宽检查配置来让报错消失；必须直接修复代码实现。
- **结构化日志规范**：Python 统一使用 `structlog.stdlib.get_logger(__name__)`。日志事件写简短固定的中文短句，动态变量通过关键字参数传入（禁止使用 f-string 或 `%s` 拼接日志正文）。第三方库的日志噪音统一在 [app/logging.py](server/src/iclip/app/logging.py) 的 `QUIET_LOGGERS` 中压低。

```python
_logger.warning("生成任务提交失败", job_id=job.id, code=exc.code)
```

---

## 3. 分支与交付

仓库采用双主干分支模型：
- **`develop`（日常开发分支）**：所有日常功能与修复均向 `develop` 提 PR，`ci` 检查通过后自动 Squash 合并。
- **`main`（正式发版分支）**：只接收版本发布和紧急热修，**创建或合并指向 `main` 的 PR 必须先获得开发者明确确认**。
- `main` 与 `develop` 均禁止直接 push、禁止强推（force push）、禁止删除。

### 日常开发流程（Worktree 模式）

主目录常驻 `develop` 分支，不在主目录直接写代码或切分支；每个任务都在独立的 Git Worktree 中进行：

1. **拉取最新代码并创建 Worktree**：
   ```bash
   git fetch origin
   git worktree add .claude/worktrees/<任务名> -b <分支名> origin/develop
   ```
   - 如果当前任务依赖另一个尚未合并的 PR `#N`，则基于那个 PR 的分支创建 Worktree，并在新 PR 描述中注明「依赖 #N」；等 `#N` 合并进 `develop` 后，执行 `git fetch origin && git rebase --onto origin/develop <被依赖分支名> && git push --force-with-lease`。

2. **本地验证并提交**：按[命令与验证](#1-命令与验证)跑完相关检查后 `git commit`。

3. **推送分支、创建 PR 并开启自动合并**：
   ```bash
   git push -u origin HEAD
   gh pr create --base develop
   gh pr merge <n> --auto --squash
   ```
   - **注意 1**：开启自动合并前务必确认目标分支是 `develop`（`main` 分支没有配置必过状态检查，如果误指向 `main` 开自动合并会直接合入！若选错请先执行 `gh pr edit <n> --base develop`）。
   - **注意 2**：PR 创建后尽量不要只修改标题或正文（GitHub 在只改标题/正文时不会重新触发 `ci`，会导致自动合并一直卡住；如果确实改了标题或正文，请运行 `gh pr update-branch <n>` 或推一个空提交重新触发 `ci`）。

4. **等待 `ci` 通过与故障排查**：
   - `ci` 通过后会自动 Squash 合入 `develop`。
   - 如果 `ci` 失败，先查看失败 Job 的日志（前端 E2E 失败可下载 `playwright-e2e-*` 构建产物中的 trace 排查）。如果是与本次改动无关的偶发波动，只点 **Re-run failed jobs** 重跑失败项；如果是代码问题，直接推送新提交修复即可（自动合并保持开启）。

5. **合并后清理 Worktree**：
   确认 `gh pr view <n> --json state` 状态为 `MERGED` 且无未提交代码后，回到主目录清理：
   ```bash
   git pull --ff-only
   git worktree remove .claude/worktrees/<任务名>
   git branch -D <分支名>
   ```

### 发版与热修

`main` 代表已交付的应用版本。执行版本发布、线上紧急热修或热修回流 `develop` 前，请先阅读 [docs/release.md](docs/release.md#发版与热修)。

---

## 4. 文档维护

- **只写现行事实**：文档只描述系统当前真实的规则与操作步骤，不写开发过程、历史进度或临时待办；架构取舍与背景原因统一写进 ADR（见 [docs/adr/README.md](docs/adr/README.md)）。
- **如何引用 ADR**：普通文档在陈述某项由 ADR 拍板的规则且原因不直观时，在句末加上该 ADR 的链接；`CONTEXT.md` 只在文件开头链接一次 `adr/` 目录；代码注释只在原因不明显时标注 `ADR-NNNN`。
- **单一事实源**：同一条规则只在一份权威文档里维护，其他文档通过链接指向它，不在多处重复抄写。
- **不复述代码已表达的细节**：类型定义、配置默认值、Linter 规则已经能自动检查的细节不在文档里罗列；文档重点写职责边界、核心流程和工具无法自动检查的业务约束。
- **修改文档后必查**：核对文中的命令、文件路径与链接，并运行 `make docs-check`。

### 文档地图

| 文档 | 什么时候读 | 核心内容与更新时机 |
|---|---|---|
| [AGENTS.md](AGENTS.md) | 任何改动前 | 全仓通用开发流程、命令与交付规则变化时更新 |
| [web/AGENTS.md](web/AGENTS.md) | 修改前端代码时 | 前端命令、目录职责边界与验证要求变化时更新 |
| [docs/CONTEXT.md](docs/CONTEXT.md) | 任何改动前 | 前后端共用的核心业务概念、系统不变量与禁止逻辑变化时更新 |
| [docs/architecture.md](docs/architecture.md) | 修改后端或视频插件时 | 各服务职责分工、通信通道、模块分层与运行装配机制变化时更新 |
| 运行时项目 Cue 的 `AGENTS.md` 与 `docs/` | 修改运行时、新业务系统接入运行时，或修改应用与运行时对接方式时 | 由 Cue 维护：运行时的命令、架构、协议、接入步骤与测试规范 |
| [docs/adr/](docs/adr/) | 新增或调整架构决策前 | 已拍板的重大架构决策与取舍（编写规范见目录内 README） |
| [docs/deploy.md](docs/deploy.md) | 本地启动、服务器部署或升级时 | 本地环境搭建、服务器部署、版本升级与密钥轮换步骤变化时更新 |
| [docs/release.md](docs/release.md) | 发版、热修或修改镜像打包流水线时 | 发版/热修操作流程、版本号规范与 Docker 镜像构建流水线变化时更新 |
| [contract/openapi.json](contract/openapi.json) | 调用或修改后端接口前 | 后端路由变更后由 `make contract` 自动导出 |
| [contract/conventions.md](contract/conventions.md) | 修改接口或跨端实时协议前 | OpenAPI 无法表达的认证、状态机、错误码与 WebSocket 协议变化时更新 |
| [design-system.html](design-system.html) | 修改视觉 Token 或组件样式前 | 基础设计 Token 变化时更新 |
| [web/README.md](web/README.md) | 启动前端开发服务器前 | 前端开发服务器端口与代理环境变量变化时更新 |
| [web/docs/frontend-implementation.md](web/docs/frontend-implementation.md) | 编写前端组件、文案或测试前 | 前端组件实现规范、界面文案规范与测试分层变化时更新 |
| [docs/test-design.md](docs/test-design.md) | 编写或调整 Python 测试时 | 各模块测试职责、分层原则、数据库夹具与验证边界变化时更新 |
| [docs/tool-design.md](docs/tool-design.md) | 新增或修改 Agent 工具时 | Agent 工具面向大模型的 docstring 写法、参数校验与卡片展示规范变化时更新 |

# 项目命令入口。

.PHONY: runtime runtime-bump setup dev up lint format format-check typecheck tach test check contract contract-sync contract-check docs-check lock-check lock-sync db-upgrade test-external web-check hooks wt-new wt-clean

# 把运行时项目 Cue 按 runtime.ref 钉住的版本检出到 runtime/（不进本仓库），需要 Cue 的读权限。
# runtime/ 已存在却不是 Git 检出时报错退出，不替人删除。
runtime:
	@if [ ! -e runtime/.git ]; then \
		if [ -e runtime ]; then echo 'runtime/ 已存在但不是 Git 检出，先把它移走再执行 make runtime' >&2; exit 1; fi; \
		git clone git@github.com:soutlu/Cue.git runtime; \
	fi
	git -C runtime fetch --tags
	git -C runtime -c advice.detachedHead=false checkout "$$(cat runtime.ref)"

# 换运行时版本：make runtime-bump REF=vA.B.C。把 runtime.ref 改成 REF，检出新版本，再重锁三个锁文件。
runtime-bump:
	@if [ -z "$(REF)" ]; then echo '用法：make runtime-bump REF=vA.B.C' >&2; exit 1; fi
	printf '%s\n' '$(REF)' > runtime.ref
	$(MAKE) runtime
	$(MAKE) lock-sync

setup: runtime
	cd plugins/video && uv sync
	cd server && uv sync
	cd web && pnpm install && pnpm hf:registry
	cd render && pnpm install

# 起后端（7788）与运行时服务（7790），Ctrl-C 两个一起停。运行时等后端答了健康检查才起：配了 shot_video 或
# video_breakdown 时它启动就向后端核对插件服务。后端启动失败时 --reload 的监督进程不退出，所以最多等 60 秒，
# 超时连同后端一起退出。两个都用后端的虚拟环境（它的 dev 组可编辑地装着运行时检出 runtime/ 与 plugins/video/），
# 源码改动各自重载。
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd server && uv run --env-file ../.env python -m iclip.main --config configs/config.yaml --reload --reload-dir src --reload-dir ../plugins/video/src) & \
	for _ in $$(seq 1 60); do curl -sf http://localhost:7788/healthz >/dev/null && break; sleep 1; done; \
	curl -sf http://localhost:7788/healthz >/dev/null || { echo '后端 60 秒内没能通过 /healthz，往上翻它打出来的报错' >&2; exit 1; }; \
	(cd server && uv run --env-file ../.env python -m agent_runtime.main --config configs/runtime.yaml --reload --reload-dir ../runtime/src --reload-dir ../plugins/video/src) & \
	wait

up:
	bash scripts/dev-up.sh

lint:
	cd plugins/video && uv run ruff check .
	cd server && uv run ruff check .

format:
	cd plugins/video && uv run ruff format .
	cd server && uv run ruff format .

format-check:
	cd plugins/video && uv run ruff format --check .
	cd server && uv run ruff format --check .

typecheck:
	cd plugins/video && uv run pyright
	cd server && uv run pyright

tach:
	cd plugins/video && uv run tach check
	cd server && uv run tach check

test:
	cd plugins/video && uv run pytest -m "unit or integration_no_llm"
	cd server && uv run pytest -m "unit or integration_no_llm"

check: lint format-check typecheck tach test contract-check docs-check lock-check

# 核对 Markdown 相对链接与 make 目标。
docs-check:
	python3 scripts/check-docs.py

# 核对运行时镜像的锁 deploy/runtime-video/uv.lock：与项目文件一致，且与 server/uv.lock 共有的包同一版本。
lock-check:
	cd deploy/runtime-video && uv lock --check
	python3 scripts/check-locks.py

# 重锁视频插件、后端与运行时镜像三个锁，把运行时镜像锁里与后端共有的包对齐到后端的版本，再核对。
lock-sync:
	cd plugins/video && uv lock
	cd server && uv lock
	cd deploy/runtime-video && uv lock
	python3 scripts/check-locks.py --fix
	$(MAKE) lock-check

# 导出后端的 contract/openapi.json；要连同前端类型一起更新用 make contract-sync。
contract:
	cd server && uv run python scripts/dump_openapi.py

# 导出后端合同，再运行 web 的 pnpm contract:generate，更新前端类型与 zod schema。
contract-sync: contract
	cd web && pnpm contract:generate

contract-check:
	cd server && uv run python scripts/dump_openapi.py --check

# 后端虚拟环境的 dev 组可编辑地装着运行时检出 runtime/，运行时的迁移也经它执行。
db-upgrade:
	cd server && uv run --env-file ../.env alembic upgrade head
	cd server && uv run --env-file ../.env python -m agent_runtime.admin migrate

test-external:
	cd server && uv run --env-file ../.env pytest -m "integration_llm or e2e_full or external" -v

web-check:
	cd web && pnpm ci:check

hooks:
	cd server && uv run pre-commit install -t pre-commit -t pre-push

# 在主目录执行：make wt-new NAME=<任务名> [BRANCH=<分支名>]。从 origin/main 建 .claude/worktrees/<NAME>
# （BRANCH 缺省用 NAME），再在里面检出运行时。
wt-new:
	@if [ -z "$(NAME)" ]; then echo '用法：make wt-new NAME=<任务名> [BRANCH=<分支名>]' >&2; exit 1; fi
	@if [ "$$(git rev-parse --git-dir)" != .git ]; then echo 'make wt-new 要在主目录执行' >&2; exit 1; fi
	git fetch origin
	git worktree add '.claude/worktrees/$(NAME)' -b '$(or $(BRANCH),$(NAME))' origin/main
	$(MAKE) -C '.claude/worktrees/$(NAME)' runtime

# 在主目录执行：make wt-clean NAME=<任务名>。Worktree 没有未提交的改动、它的分支的 PR 已经 MERGED，
# 才拉取主目录、移除 Worktree 并删本地分支；任何一项不满足就报错退出，什么都不删。
wt-clean:
	@if [ -z "$(NAME)" ]; then echo '用法：make wt-clean NAME=<任务名>' >&2; exit 1; fi
	@if [ "$$(git rev-parse --git-dir)" != .git ]; then echo 'make wt-clean 要在主目录执行' >&2; exit 1; fi
	@dir='.claude/worktrees/$(NAME)'; \
	[ -d "$$dir" ] && [ "$$(git -C "$$dir" rev-parse --show-toplevel)" = "$$(cd "$$dir" && pwd -P)" ] \
		|| { echo "$$dir 不是 Worktree" >&2; exit 1; }; \
	branch=$$(git -C "$$dir" symbolic-ref --short HEAD) || { echo "$$dir 不在任何分支上" >&2; exit 1; }; \
	if [ -n "$$(git -C "$$dir" status --porcelain)" ]; then echo "$$dir 有未提交的改动" >&2; exit 1; fi; \
	state=$$(gh pr view "$$branch" --json state --jq .state) || { echo "查不到分支 $$branch 的 PR" >&2; exit 1; }; \
	if [ "$$state" != MERGED ]; then echo "分支 $$branch 的 PR 状态是 $$state，不是 MERGED" >&2; exit 1; fi; \
	set -ex; git pull --ff-only; git worktree remove "$$dir"; git branch -D "$$branch"

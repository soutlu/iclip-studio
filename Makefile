# 项目命令入口。

.PHONY: runtime setup dev up lint format format-check typecheck tach test check contract contract-check docs-check lock-check db-upgrade test-external web-check hooks

# 把运行时项目 Cue 按 runtime.ref 钉住的版本检出到 runtime/（不进本仓库），需要 Cue 的读权限。
# runtime/ 已存在却不是 Git 检出时报错退出，不替人删除。
runtime:
	@if [ ! -e runtime/.git ]; then \
		if [ -e runtime ]; then echo 'runtime/ 已存在但不是 Git 检出，先把它移走再执行 make runtime' >&2; exit 1; fi; \
		git clone git@github.com:soutlu/Cue.git runtime; \
	fi
	git -C runtime fetch --tags
	git -C runtime -c advice.detachedHead=false checkout "$$(cat runtime.ref)"

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
	(cd server && uv run --env-file ../.env python -m iclip.main --config configs/config.yaml --reload --reload-dir . --reload-dir ../runtime/src --reload-dir ../plugins/video/src) & \
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

# 导出后端的 contract/openapi.json；导出后运行 web 的 pnpm contract:generate，更新前端类型与 zod schema。
contract:
	cd server && uv run python scripts/dump_openapi.py

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

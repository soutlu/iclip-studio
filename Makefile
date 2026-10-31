# 项目命令入口。

.PHONY: setup dev up lint format format-check typecheck tach test check contract contract-check docs-check db-upgrade test-external web-check hooks

setup:
	cd runtime && uv sync
	cd plugins/video && uv sync
	cd server && uv sync
	cd web && pnpm install && pnpm hf:registry
	cd render && pnpm install

# 起后端（7788）与运行时服务（7790），Ctrl-C 两个一起停。运行时等后端答了健康检查才起：配了 shot_video 时它启动
# 就向后端取图片模型。两个都用后端的虚拟环境（它可编辑地装着 runtime/ 与 plugins/video/），源码改动各自重载。
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd server && uv run --env-file ../.env python -m iclip.main --config configs/config.yaml --reload --reload-dir . --reload-dir ../runtime/src --reload-dir ../plugins/video/src) & \
	until curl -sf http://localhost:7788/healthz >/dev/null; do sleep 1; done; \
	(cd server && uv run --env-file ../.env python -m agent_runtime.main --config configs/runtime.yaml --reload --reload-dir ../runtime/src --reload-dir ../plugins/video/src) & \
	wait

up:
	bash scripts/dev-up.sh

lint:
	cd runtime && uv run ruff check .
	cd plugins/video && uv run ruff check .
	cd server && uv run ruff check .

format:
	cd runtime && uv run ruff format .
	cd plugins/video && uv run ruff format .
	cd server && uv run ruff format .

format-check:
	cd runtime && uv run ruff format --check .
	cd plugins/video && uv run ruff format --check .
	cd server && uv run ruff format --check .

typecheck:
	cd runtime && uv run pyright
	cd plugins/video && uv run pyright
	cd server && uv run pyright

tach:
	cd runtime && uv run tach check
	cd plugins/video && uv run tach check
	cd server && uv run tach check

test:
	cd runtime && uv run pytest -m "unit or integration_no_llm"
	cd plugins/video && uv run pytest -m "unit or integration_no_llm"
	cd server && uv run pytest -m "unit or integration_no_llm"

check: lint format-check typecheck tach test contract-check docs-check

# 核对 Markdown 相对链接与 make 目标。
docs-check:
	python3 scripts/check-docs.py

# 导出后端与运行时服务的 OpenAPI；后端的导出后运行 web 的 pnpm contract:generate，更新前端类型与 zod schema。
contract:
	cd server && uv run python scripts/dump_openapi.py
	cd runtime && uv run python scripts/dump_openapi.py

contract-check:
	cd server && uv run python scripts/dump_openapi.py --check
	cd runtime && uv run python scripts/dump_openapi.py --check

db-upgrade:
	cd server && uv run --env-file ../.env alembic upgrade head

test-external:
	cd server && uv run --env-file ../.env pytest -m "integration_llm or e2e_full or external" -v

web-check:
	cd web && pnpm ci:check

hooks:
	cd server && uv run pre-commit install -t pre-commit -t pre-push

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "src" / "iclip"

FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("pydantic_ai",): (),
    ("pydantic_ai_harness",): (),
    ("fastapi", "starlette"): (
        "app/",
        "domains/identity/api.py",
        "domains/agents/transcript_api.py",
        "domains/conversations/api.py",
        "domains/generation/api.py",
        "domains/inspirations/api.py",
        "domains/collections/api.py",
        "domains/tasks/api.py",
        "domains/audit/api.py",
        "domains/library/api.py",
        "domains/references/api.py",
        "domains/tagging/api.py",
        "domains/skills/api.py",
        "domains/brand_templates/api.py",
        "domains/tracking/api.py",
        "domains/uploads/api.py",
        "domains/model_providers/api.py",
        "domains/mcp_servers/api.py",
        "domains/agent_config/api.py",
        "platform/runtime_admin.py",
        "domains/identity/middleware.py",
        "domains/identity/accounts.py",
        "main.py",
    ),
    ("sqlalchemy",): (
        "platform/db/",
        "app/",
        "domains/products/catalog_pg.py",
        "domains/audit/reports_pg.py",
        "domains/library/reports_pg.py",
    ),
    ("fastapi_users", "fastapi_users_db_sqlalchemy"): ("domains/identity/",),
    ("openai",): (),
    ("oss2",): ("platform/object_store/oss.py",),
    ("PIL",): ("platform/shot_media/board.py", "platform/media/image.py"),
    ("procrastinate",): (
        "domains/generation/queue.py",
        "domains/generation/module.py",
        "domains/references/queue.py",
        "domains/references/module.py",
        "domains/tagging/queue.py",
        "domains/tagging/module.py",
        "app/",
    ),
}
_SQLALCHEMY_MODULE_FILE = "infra_sql.py"
_SQLALCHEMY_MODULE_PREFIXES = ("domains/",)


def _python_files() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


def _imported_top_levels(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def _rel(path: Path) -> str:
    return path.relative_to(SRC).as_posix()


def test_framework_fences() -> None:
    violations: list[str] = []
    for path in _python_files():
        rel = _rel(path)
        imports = _imported_top_levels(path)
        for frameworks, allowed in FRAMEWORK_FENCES.items():
            hit = imports & set(frameworks)
            if not hit:
                continue
            if (
                frameworks == ("sqlalchemy",)
                and rel.startswith(_SQLALCHEMY_MODULE_PREFIXES)
                and path.name == _SQLALCHEMY_MODULE_FILE
            ):
                continue
            if not any(rel == prefix or rel.startswith(prefix) for prefix in allowed):
                violations.append(f"{rel}: 越界 import {sorted(hit)}")
    assert not violations, "框架围栏违规:\n" + "\n".join(violations)


def test_cross_module_imports_only_public() -> None:

    violations: list[str] = []
    domains = [p.name for p in (SRC / "domains").iterdir() if p.is_dir()]
    for path in (SRC / "domains").rglob("*.py"):
        rel = _rel(path)
        own = rel.split("/")[1]
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            parts = node.module.split(".")
            if parts[:2] == ["iclip", "domains"] and len(parts) >= 3:
                target = parts[2]
                if target in domains and target != own and (len(parts) < 4 or parts[3] != "public"):
                    violations.append(f"{rel}: 绕过 public 引 {node.module}")
    assert not violations, "\n".join(violations)


def test_models_and_commands_are_pure() -> None:

    import sys

    stdlib = set(sys.stdlib_module_names)
    violations: list[str] = []
    for name in ("models.py", "commands.py"):
        for path in (SRC / "domains").rglob(name):
            for top in _imported_top_levels(path):
                if top not in stdlib and top != "iclip":
                    violations.append(f"{_rel(path)}: 第三方 {top}")
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.ImportFrom)
                    and node.module
                    and node.module.startswith("iclip.")
                    and not node.module.startswith("iclip.common")
                    and not node.module.startswith(f"iclip.domains.{path.parent.name}")
                ):
                    violations.append(f"{_rel(path)}: {node.module}")
    assert not violations, "\n".join(violations)


def test_no_silent_exception_fallbacks() -> None:

    violations: list[str] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            if node.type is None:
                violations.append(f"{_rel(path)}:{node.lineno} 裸 except")
            elif len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                violations.append(f"{_rel(path)}:{node.lineno} except: pass")
    assert not violations, "\n".join(violations)


RUNTIME_ALLOWLIST: dict[str, str] = {
    "cue.client": "运行时服务的客户端库：HTTP 接口、两条 WebSocket、报错还原",
    "cue.errors": "领域错误分类，两边同一套，客户端库按它还原运行时的 4xx",
    "cue.http.errors": "状态码表、错误信封与校验文案，两边同一套",
    "cue.urls": "地址形状判定",
    "cue.app_wire": "会话接口的请求体与答复体",
    "cue.hooks": "运行时回调后端的请求体",
    "cue.live.frames": "两条 WebSocket 上运行时发的帧，浏览器收到的回执、文件变化与心跳就是它们",
    "cue.transcript.wire": "transcript 的消息请求体、读页信封与帧的信封基类",
    "cue.transcript.ops": "transcript 实体：消息内容、主 agent 的 id",
    "cue.file_store.store": "工作区文件的形状与路径规则",
    "cue.file_store.namespace": "工作区的命名空间规则",
    "cue.config.skills.schemas": "技能库管理接口的请求体",
    "cue.config.skills.models": "技能导入包的大小上限",
    "cue.config.model_providers.schemas": "模型供应商管理接口的请求体",
    "cue.config.model_providers.models": "模型类型的词表",
    "cue.config.mcp_servers.schemas": "MCP 服务管理接口的请求体",
    "cue.config.agent_config.schemas": "agent 配置管理接口的请求体",
    "cue.agent_usage": "管理接口答复里「谁在用」的形状，后端补名字的答复照用",
    "cue.config.agent_config.package": "agent 导出包的大小上限",
}


def test_the_server_imports_only_the_runtime_shapes_and_client() -> None:
    violations: list[str] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules = [node.module]
            elif isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            else:
                continue
            for module in modules:
                if module.split(".")[0] == "cue" and module not in RUNTIME_ALLOWLIST:
                    violations.append(f"{_rel(path)}: {module}")
    assert not violations, "后端引用了运行时的内部模块:\n" + "\n".join(violations)


RUNTIME_SCHEMA = "agent_runtime"


def _code_strings(tree: ast.AST) -> list[ast.Constant]:
    docstrings = {
        id(node.value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
    }
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_the_server_never_names_runtime_tables() -> None:
    violations: list[str] = []
    for path in _python_files():
        rel = _rel(path)
        for node in _code_strings(ast.parse(path.read_text(encoding="utf-8"))):
            value = str(node.value)
            if value == RUNTIME_SCHEMA or f"{RUNTIME_SCHEMA}." in value:
                violations.append(f"{rel}:{node.lineno} {value.strip()[:80]!r}")
    assert not violations, "后端写了运行时 schema 的表:\n" + "\n".join(violations)


def test_config_only_consumed_by_app() -> None:

    violations: list[str] = []
    for path in (SRC / "domains").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.ImportFrom)
                and node.module
                and node.module.startswith("iclip.config")
            ):
                violations.append(_rel(path))
    assert not violations, "\n".join(violations)

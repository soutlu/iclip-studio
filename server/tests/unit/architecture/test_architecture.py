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


SERVER = SRC.parents[1]


def test_the_server_never_imports_the_runtime() -> None:
    violations: list[str] = []
    for folder in ("src", "scripts", "migrations"):
        for path in sorted((SERVER / folder).rglob("*.py")):
            if "agent_runtime" in _imported_top_levels(path):
                violations.append(path.relative_to(SERVER).as_posix())
    assert not violations, "后端引用了运行时的代码:\n" + "\n".join(violations)


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

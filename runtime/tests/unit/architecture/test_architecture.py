from __future__ import annotations

import ast
import re
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
SRC = PROJECT / "src" / "cue"
TESTS = PROJECT / "tests"

HOST_PACKAGES = frozenset({"iclip", "iclip_video"})

FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("pydantic_ai",): ("harness/", "plugins/"),
    ("pydantic_ai_harness",): ("harness/",),
    ("openai",): ("harness/models.py",),
    ("fastmcp", "mcp"): ("harness/mcp.py",),
    ("fastapi", "starlette"): ("http/",),
    ("uvicorn",): ("main.py",),
    ("httpx_ws", "wsproto"): ("client/",),
    ("alembic",): ("migrations/",),
    ("sqlalchemy",): (
        "http/app.py",
        "admin.py",
        "migrations/",
        "assembly/config_services.py",
        "file_store/pg.py",
        "harness/step_store_pg.py",
        "harness/usage_ledger_pg.py",
        "harness/jobs.py",
        "harness/sessions.py",
        "harness/stats_pg.py",
        "config/skills/infra_sql.py",
        "config/model_providers/infra_sql.py",
        "config/mcp_servers/infra_sql.py",
        "config/agent_config/infra_sql.py",
    ),
}

CONFIG = SRC / "config"
CONFIG_PACKAGE = "cue.config"

LEAF_MODULES = frozenset(
    {
        "cue.errors",
        "cue.urls",
        "cue.model_vocab",
        "cue.model_connections",
        "cue.agent_usage",
        "cue.tool_args",
        "cue.secrets",
    }
)


CLIENT = SRC / "client"
CLIENT_PACKAGE = "cue.client"

CLIENT_RUNTIME_IMPORTS = frozenset(
    {
        "cue.errors",
        "cue.app_wire",
        "cue.transcript.wire",
        "cue.transcript.ops",
        "cue.live.frames",
        "cue.file_store.store",
    }
)
CLIENT_THIRD_PARTY = frozenset({"httpx", "httpx_ws", "wsproto", "pydantic"})

SERVER_SIDE_PACKAGES = (
    "fastapi",
    "starlette",
    "sqlalchemy",
    "pydantic_ai",
    "pydantic_ai_harness",
    "pydantic_settings",
)


def _python_files(root: Path) -> list[Path]:
    return sorted(root.rglob("*.py"))


def _imported_top_levels(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def test_runtime_never_imports_the_host() -> None:
    violations: list[str] = []
    for path in _python_files(SRC) + _python_files(TESTS):
        hit = _imported_top_levels(path) & HOST_PACKAGES
        if hit:
            violations.append(f"{path.relative_to(PROJECT).as_posix()}: import {sorted(hit)}")
    assert not violations, "运行时引用了宿主包:\n" + "\n".join(violations)


def test_framework_fences() -> None:
    violations: list[str] = []
    for path in _python_files(SRC):
        rel = path.relative_to(SRC).as_posix()
        imports = _imported_top_levels(path)
        for frameworks, allowed in FRAMEWORK_FENCES.items():
            hit = imports & set(frameworks)
            if hit and not any(rel == prefix or rel.startswith(prefix) for prefix in allowed):
                violations.append(f"{rel}: 越界 import {sorted(hit)}")
    assert not violations, "框架围栏违规:\n" + "\n".join(violations)


def test_client_imports_only_wire_shapes() -> None:
    import sys

    stdlib = set(sys.stdlib_module_names)
    violations: list[str] = []
    for path in _python_files(CLIENT):
        rel = path.relative_to(SRC).as_posix()
        for top in _imported_top_levels(path) - stdlib - CLIENT_THIRD_PARTY - {"cue"}:
            violations.append(f"{rel}: 第三方 {top}")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules = [node.module]
            elif isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            for module in modules:
                if (
                    module.startswith("cue")
                    and module not in CLIENT_RUNTIME_IMPORTS
                    and module != CLIENT_PACKAGE
                    and not module.startswith(f"{CLIENT_PACKAGE}.")
                ):
                    violations.append(f"{rel}: {module}")
    assert not violations, "客户端库越界:\n" + "\n".join(violations)


def test_importing_the_client_loads_no_server_side_package() -> None:
    import subprocess
    import sys

    probe = (
        "import sys, cue.client; "
        f"print(','.join(name for name in {SERVER_SIDE_PACKAGES!r} if name in sys.modules))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "", f"import cue.client 带进了 {result.stdout.strip()}"


def _config_domains() -> list[str]:
    return sorted(p.name for p in CONFIG.iterdir() if p.is_dir() and p.name != "__pycache__")


def test_cross_module_imports_only_public() -> None:
    violations: list[str] = []
    domains = _config_domains()
    for path in _python_files(SRC):
        rel = path.relative_to(SRC).as_posix()
        segments = rel.split("/")
        own = segments[1] if segments[0] == "config" and len(segments) > 2 else None
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or not node.module:
                continue
            parts = node.module.split(".")
            if parts[:2] == ["cue", "config"] and len(parts) >= 3:
                target = parts[2]
                if target in domains and target != own and (len(parts) < 4 or parts[3] != "public"):
                    violations.append(f"{rel}: 绕过 public 引 {node.module}")
    assert not violations, "\n".join(violations)


def test_models_and_commands_are_pure() -> None:
    import sys

    stdlib = set(sys.stdlib_module_names)
    violations: list[str] = []
    for name in ("models.py", "commands.py"):
        for path in CONFIG.rglob(name):
            rel = path.relative_to(SRC).as_posix()
            own = f"{CONFIG_PACKAGE}.{path.parent.name}"
            for top in _imported_top_levels(path):
                if top not in stdlib and top != "cue":
                    violations.append(f"{rel}: 第三方 {top}")
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or not node.module:
                    continue
                module = node.module
                if (
                    module.startswith("cue")
                    and module not in LEAF_MODULES
                    and module != own
                    and not module.startswith(f"{own}.")
                ):
                    violations.append(f"{rel}: {module}")
    assert not violations, "\n".join(violations)


HOST_SCHEMA = "iclip"
HOST_TABLE_IN_SQL = re.compile(
    rf"\b(from|join|into|update|table|references)\s+{HOST_SCHEMA}\.", re.IGNORECASE
)


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


def test_runtime_never_names_the_host_schema() -> None:
    violations: list[str] = []
    for path in _python_files(SRC):
        rel = path.relative_to(SRC).as_posix()
        for node in _code_strings(ast.parse(path.read_text(encoding="utf-8"))):
            value = str(node.value)
            if value == HOST_SCHEMA or HOST_TABLE_IN_SQL.search(value):
                violations.append(f"{rel}:{node.lineno} {value.strip()[:80]!r}")
    assert not violations, "运行时写了宿主 schema 的表:\n" + "\n".join(violations)


def test_no_silent_exception_fallbacks() -> None:
    violations: list[str] = []
    for path in _python_files(SRC):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ExceptHandler):
                continue
            rel = path.relative_to(SRC).as_posix()
            if node.type is None:
                violations.append(f"{rel}:{node.lineno} 裸 except")
            elif len(node.body) == 1 and isinstance(node.body[0], ast.Pass):
                violations.append(f"{rel}:{node.lineno} except: pass")
    assert not violations, "\n".join(violations)

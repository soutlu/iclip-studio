"""验证 tach 依赖图之外的约束：不依赖宿主、框架引用边界、配置模块的引用边界与纯度和异常处理。"""

from __future__ import annotations

import ast
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
SRC = PROJECT / "src" / "agent_runtime"
TESTS = PROJECT / "tests"

# 运行时被宿主与应用的插件包依赖，反过来不行：源码与测试都不得引用它们。
HOST_PACKAGES = frozenset({"iclip", "iclip_video"})

# 框架及允许直接导入它的路径前缀（相对 src/agent_runtime）。
FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("pydantic_ai",): ("harness/", "plugins/"),
    ("pydantic_ai_harness",): ("harness/",),
    ("openai",): ("harness/models.py",),
    # HTTP 入口在宿主，运行时不带 Web 框架。
    ("fastapi", "starlette"): (),
    ("sqlalchemy",): (
        "file_store/pg.py",
        "material_ledger/pg.py",
        # StepPersistence 协议后端归属使用该协议的 harness。
        "harness/step_store_pg.py",
        # 对话用量台账的 Postgres 实现，同样归属 harness，表在 agent_runtime schema。
        "harness/usage_ledger_pg.py",
        # prompt 队列归属运行驱动，使用 agent_runtime schema。
        "harness/jobs.py",
        # 运行时会话（对话固定的 agent 版本），同样在 agent_runtime schema。
        "harness/sessions.py",
        # 三块配置各自的表。
        "config/skills/infra_sql.py",
        "config/model_providers/infra_sql.py",
        "config/agent_config/infra_sql.py",
    ),
}

CONFIG = SRC / "config"
CONFIG_PACKAGE = "agent_runtime.config"

# 被各处共用、自身无依赖的叶子模块（tach.toml 里 utility = true 的那几个）。
LEAF_MODULES = frozenset(
    {
        "agent_runtime.errors",
        "agent_runtime.urls",
        "agent_runtime.model_vocab",
        "agent_runtime.agent_usage",
        "agent_runtime.tool_args",
    }
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
            if parts[:2] == ["agent_runtime", "config"] and len(parts) >= 3:
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
                if top not in stdlib and top != "agent_runtime":
                    violations.append(f"{rel}: 第三方 {top}")
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or not node.module:
                    continue
                module = node.module
                if (
                    module.startswith("agent_runtime")
                    and module not in LEAF_MODULES
                    and module != own
                    and not module.startswith(f"{own}.")
                ):
                    violations.append(f"{rel}: {module}")
    assert not violations, "\n".join(violations)


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

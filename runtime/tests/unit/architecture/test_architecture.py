"""验证 tach 依赖图之外的约束：不依赖宿主、框架引用边界和异常处理。"""

from __future__ import annotations

import ast
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
SRC = PROJECT / "src" / "agent_runtime"
TESTS = PROJECT / "tests"

# 运行时被宿主依赖，反过来不行：源码与测试都不得引用宿主包。
HOST_PACKAGES = frozenset({"iclip"})

# 框架及允许直接导入它的路径（相对 src/agent_runtime）。
FRAMEWORK_FENCES: dict[tuple[str, ...], tuple[str, ...]] = {
    ("sqlalchemy",): ("file_store/pg.py", "material_ledger/pg.py"),
}


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
            if hit and rel not in allowed:
                violations.append(f"{rel}: 越界 import {sorted(hit)}")
    assert not violations, "框架围栏违规:\n" + "\n".join(violations)


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

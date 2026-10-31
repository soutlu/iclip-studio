"""导出包：格式版本按 packaging.version 比较（新的与主版本旧的拒收，次版本旧的提醒），大小与 YAML 的问题
在读包时报出。"""

from __future__ import annotations

import pytest

from agent_runtime.config.agent_config.package import (
    MAX_PACKAGE_BYTES,
    read_package,
    version_check,
)


@pytest.mark.parametrize(
    ("imported", "current", "rejected", "warned"),
    [
        ("1.0.0", "1.0.0", False, False),
        ("1.2.3", "1.2.0", True, False),
        ("1.1.0", "1.2.0", False, True),
        ("1.3.0", "1.2.0", True, False),
        ("2.0.0", "1.2.0", True, False),
        ("0.9.0", "1.2.0", True, False),
        ("not-a-version", "1.0.0", True, False),
    ],
)
def test_version_check(imported: str, current: str, rejected: bool, warned: bool) -> None:
    problem, warning = version_check(imported, current=current)

    assert (problem is not None, warning is not None) == (rejected, warned)


def test_oversized_and_broken_files_are_problems() -> None:
    assert read_package(b"x" * (MAX_PACKAGE_BYTES + 1)).package is None
    assert read_package(b"agents: [unclosed").package is None
    assert read_package(b"- just\n- a list\n").package is None


def test_entry_must_be_in_the_package() -> None:
    read = read_package(
        b"format_version: '1.0.0'\nentry: ghost\nagents:\n  main: {name: x, config: {}}\n"
    )

    assert [one.path for one in read.problems] == ["entry"]

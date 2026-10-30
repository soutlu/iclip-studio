"""导出包：格式版本按 packaging.version 比较（新的与主版本旧的拒收，次版本旧的提醒），大小与 YAML 的问题
在读包时报出。"""

from __future__ import annotations

import pytest

from iclip.domains.agent_config.package import (
    FORMAT_VERSION,
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


def test_current_package_reads_without_problems() -> None:
    read = read_package(
        f"format_version: '{FORMAT_VERSION}'\nentry: main\n"
        "agents:\n  main: {name: 主, config: {schema_version: 1}}\n".encode()
    )

    assert read.package is not None
    assert read.problems == () and read.warnings == ()


def test_oversized_and_broken_files_are_problems() -> None:
    assert read_package(b"x" * (MAX_PACKAGE_BYTES + 1)).package is None
    assert read_package(b"agents: [unclosed").package is None
    assert read_package(b"- just\n- a list\n").package is None


def test_entry_must_be_in_the_package() -> None:
    read = read_package(
        b"format_version: '1.0.0'\nentry: ghost\nagents:\n  main: {name: x, config: {}}\n"
    )

    assert [one.path for one in read.problems] == ["entry"]


def test_newer_format_is_a_problem() -> None:
    read = read_package(
        b"format_version: '9.0.0'\nentry: main\nagents:\n  main: {name: x, config: {}}\n"
    )

    assert [one.path for one in read.problems] == ["format_version"]

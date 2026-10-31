"""技能压缩包：SKILL.md 在根目录或唯一顶层目录里都能读；符号链接、``..``、绝对路径、重复路径、二进制、
超出范围与超过上限的文件被拒绝并点名；导出的包再读回来是同一份文件。"""

from __future__ import annotations

import io
import stat
import warnings
import zipfile

import pytest

from agent_runtime.config.skills.archive import read_archive
from agent_runtime.config.skills.models import MAX_FILE_BYTES, MAX_FILES, SKILL_MD

SKILL = "---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\n# PDF 工具\n"

Entry = tuple[str, bytes] | tuple[str, bytes, int]
"""（压缩包里的名字，字节，可选的 Unix 文件类型与权限）。"""


def make_zip(*entries: Entry) -> bytes:
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # 重复名字时 zipfile 会警告，这里正是要造它。
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for entry in entries:
                info = zipfile.ZipInfo(entry[0])
                info.compress_type = zipfile.ZIP_DEFLATED
                if len(entry) == 3:
                    info.external_attr = entry[2] << 16
                archive.writestr(info, entry[1])
    return buffer.getvalue()


def problems_about(problems: tuple[str, ...], path: str) -> list[str]:
    return [problem for problem in problems if problem.startswith(f"{path}：")]


def test_skill_md_at_the_archive_root() -> None:
    parsed = read_archive(
        make_zip((SKILL_MD, SKILL.encode()), ("references/a.md", "参考".encode()))
    )

    assert parsed.problems == ()
    assert parsed.files == {SKILL_MD: SKILL, "references/a.md": "参考"}


def test_skill_md_inside_the_only_top_level_directory() -> None:
    parsed = read_archive(
        make_zip(
            ("pdf-tools/", b""),
            ("pdf-tools/SKILL.md", SKILL.encode()),
            ("pdf-tools/references/sub/b.md", b"b"),
            ("__MACOSX/pdf-tools/._SKILL.md", b"\x00\x05"),
            ("pdf-tools/.DS_Store", b"\x00\x00"),
        )
    )

    assert parsed.problems == ()
    assert parsed.files == {SKILL_MD: SKILL, "references/sub/b.md": "b"}


def test_without_a_findable_skill_md_nothing_is_read() -> None:
    parsed = read_archive(make_zip(("one/SKILL.md", SKILL.encode()), ("two/references/a.md", b"a")))

    assert parsed.files == {}
    assert len(parsed.problems) == 1


def test_symlinks_are_rejected() -> None:
    parsed = read_archive(
        make_zip(
            (SKILL_MD, SKILL.encode()),
            ("references/link.md", b"/etc/passwd", stat.S_IFLNK | 0o777),
        )
    )

    assert len(problems_about(parsed.problems, "references/link.md")) == 1
    assert parsed.files == {SKILL_MD: SKILL}


@pytest.mark.parametrize(
    "name", ["../evil.md", "references/../../evil.md", "/etc/passwd", "references\\a.md"]
)
def test_unsafe_names_are_rejected(name: str) -> None:
    parsed = read_archive(make_zip((SKILL_MD, SKILL.encode()), (name, b"x")))

    assert len(problems_about(parsed.problems, name)) == 1
    assert parsed.files == {SKILL_MD: SKILL}


def test_duplicate_paths_are_rejected_after_the_top_directory_is_stripped() -> None:
    parsed = read_archive(
        make_zip(
            ("pdf-tools/SKILL.md", SKILL.encode()),
            ("pdf-tools/references/a.md", b"first"),
            ("pdf-tools/references/a.md", b"second"),
        )
    )

    assert len(problems_about(parsed.problems, "references/a.md")) == 1
    assert parsed.files == {SKILL_MD: SKILL, "references/a.md": "first"}


def test_files_outside_the_allowed_range_are_rejected() -> None:
    parsed = read_archive(make_zip((SKILL_MD, SKILL.encode()), ("scripts/run.py", b"print(1)")))

    assert len(problems_about(parsed.problems, "scripts/run.py")) == 1
    assert parsed.files == {SKILL_MD: SKILL}


@pytest.mark.parametrize(
    "data", [b"\x89PNG\r\n\x1a\n\x00\x00", "中文".encode("gbk"), b"text\x00with nul"]
)
def test_binary_files_are_rejected(data: bytes) -> None:
    parsed = read_archive(make_zip((SKILL_MD, SKILL.encode()), ("references/logo.png", data)))

    assert len(problems_about(parsed.problems, "references/logo.png")) == 1
    assert parsed.files == {SKILL_MD: SKILL}


def test_a_file_over_the_single_file_limit_is_rejected() -> None:
    parsed = read_archive(
        make_zip((SKILL_MD, SKILL.encode()), ("references/big.md", b"a" * (MAX_FILE_BYTES + 1)))
    )

    assert len(problems_about(parsed.problems, "references/big.md")) == 1
    assert parsed.files == {SKILL_MD: SKILL}


def test_declared_total_over_the_limit_stops_before_reading() -> None:
    """六个 1 MB 的文件压缩后很小，解压前按声明的大小就拦下，一个都不读。"""

    big = [(f"references/{index}.md", b"a" * MAX_FILE_BYTES) for index in range(6)]
    data = make_zip((SKILL_MD, SKILL.encode()), *big)

    parsed = read_archive(data)

    assert len(data) < MAX_FILE_BYTES
    assert parsed.files == {}
    assert len(parsed.problems) == 1


def test_too_many_files_stop_before_reading() -> None:
    many = [(f"references/{index}.md", b"x") for index in range(MAX_FILES)]

    parsed = read_archive(make_zip((SKILL_MD, SKILL.encode()), *many))

    assert parsed.files == {}
    assert len(parsed.problems) == 1


def test_not_a_zip_is_reported() -> None:
    parsed = read_archive(b"definitely not a zip")

    assert parsed.files == {}
    assert len(parsed.problems) == 1

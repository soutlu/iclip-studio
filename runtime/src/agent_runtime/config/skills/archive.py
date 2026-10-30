"""技能的 zip 压缩包：导入时读出文件并查结构与安全，导出时把一份文件打成 ``<name>/`` 下的 zip。

读只做压缩包这一层的检查（结构、路径、符号链接、重复、大小、文本），frontmatter 由导入用例另查。
防压缩炸弹：解压任何文件之前先按每项声明的解压后大小累计核对，读取时再按上限截断，声明不实也读不爆。"""

from __future__ import annotations

import io
import stat
import zipfile
import zlib
from collections.abc import Mapping
from dataclasses import dataclass

from agent_runtime.config.skills.models import (
    MAX_ARCHIVE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_BYTES,
    SKILL_MD,
)
from agent_runtime.config.skills.rules import (
    content_problem,
    decode_text,
    limit_problems,
    path_problem,
    path_safety_problem,
)

_JUNK_DIR = "__MACOSX"
_JUNK_FILE = ".DS_Store"
"""macOS 压缩文件夹时顺带写进去的元数据，不算技能的文件，读的时候跳过。"""

_FIXED_DATE = (1980, 1, 1, 0, 0, 0)
"""导出时每项都记这个时刻，同一份文件打出来的包逐字节相同。"""


@dataclass(frozen=True, slots=True)
class ParsedArchive:
    """读出来的文件（技能内的路径 → 内容，只含合格的）与问题清单；没问题时 ``problems`` 为空。"""

    files: dict[str, str]
    problems: tuple[str, ...]


def _is_junk(name: str) -> bool:
    segments = name.split("/")
    return segments[0] == _JUNK_DIR or segments[-1] == _JUNK_FILE


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    """Unix 下打的包把文件类型放在 ``external_attr`` 的高 16 位。"""

    return stat.S_ISLNK(info.external_attr >> 16)


def _root(names: list[str]) -> str | None:
    """技能的根目录前缀：``SKILL.md`` 在包的根目录给 ``""``；全部文件都在同一个顶层目录里、且
    ``SKILL.md`` 就在那个目录下给 ``"<目录>/"``；都不是给 ``None``。"""

    if SKILL_MD in names:
        return ""
    tops = {name.split("/", 1)[0] for name in names}
    if len(tops) == 1:
        prefix = f"{next(iter(tops))}/"
        if f"{prefix}{SKILL_MD}" in names:
            return prefix
    return None


def read_archive(data: bytes) -> ParsedArchive:
    """读一个技能压缩包。不是 zip、超过压缩包或解压后的上限、找不到 ``SKILL.md`` 时只交回问题，不读
    文件；其余问题逐个文件记下，合格的文件照读。"""

    if len(data) > MAX_ARCHIVE_BYTES:
        return ParsedArchive({}, (f"压缩包超过上限 {MAX_ARCHIVE_BYTES // (1024 * 1024)} MB",))
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return ParsedArchive({}, ("不是有效的 zip 文件",))
    with archive:
        return _read_members(archive)


def _read_members(archive: zipfile.ZipFile) -> ParsedArchive:
    problems: list[str] = []
    members: list[zipfile.ZipInfo] = []
    for info in archive.infolist():
        if _is_junk(info.filename):
            continue
        if _is_symlink(info):
            problems.append(f"{info.filename}：是符号链接")
            continue
        if info.is_dir():
            continue
        if (unsafe := path_safety_problem(info.filename)) is not None:
            problems.append(f"{info.filename}：{unsafe}")
            continue
        members.append(info)

    if len(members) > MAX_FILES:
        return ParsedArchive({}, (*problems, f"文件数 {len(members)} 个，超过上限 {MAX_FILES} 个"))
    if sum(info.file_size for info in members) > MAX_TOTAL_BYTES:
        return ParsedArchive(
            {}, (*problems, f"解压后合计超过上限 {MAX_TOTAL_BYTES // (1024 * 1024)} MB")
        )
    prefix = _root([info.filename for info in members])
    if prefix is None:
        return ParsedArchive(
            {}, (*problems, f"找不到 {SKILL_MD}：它应在压缩包的根目录，或在唯一的顶层目录里")
        )

    files: dict[str, str] = {}
    seen: set[str] = set()
    for info in members:
        path = info.filename.removeprefix(prefix)
        if (outside := path_problem(path)) is not None:
            problems.append(f"{path}：{outside}")
            continue
        if path in seen:
            problems.append(f"{path}：路径重复")
            continue
        seen.add(path)
        problem, content = _read_text(archive, info)
        if problem is not None:
            problems.append(f"{path}：{problem}")
            continue
        files[path] = content
    problems += limit_problems([len(content.encode("utf-8")) for content in files.values()])
    return ParsedArchive(files, tuple(problems))


def _read_text(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> tuple[str | None, str]:
    """读一项并解成文本：交回（问题，内容），有问题时内容为空串。"""

    if info.file_size > MAX_FILE_BYTES:
        return f"超过单个文件的上限 {MAX_FILE_BYTES // (1024 * 1024)} MB", ""
    try:
        with archive.open(info) as member:
            data = member.read(info.file_size + 1)
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, zlib.error):
        return "读不出来（压缩包损坏、加密或用了不支持的压缩方式）", ""
    if len(data) != info.file_size:
        return "实际大小与压缩包里记的不符", ""
    content = decode_text(data)
    if content is None:
        return "不是 UTF-8 文本", ""
    if (problem := content_problem(content)) is not None:
        return problem, ""
    return None, content


def write_archive(name: str, files: Mapping[str, str]) -> bytes:
    """把一份文件打成 zip，全部放在顶层目录 ``<name>/`` 下，按路径排序、时刻固定。"""

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(files):
            info = zipfile.ZipInfo(f"{name}/{path}", date_time=_FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, files[path].encode("utf-8"))
    return buffer.getvalue()


__all__ = ["ParsedArchive", "read_archive", "write_archive"]

"""技能库的规则：标识、文件路径与内容、上限、``SKILL.md`` 的 frontmatter、清单与内容 hash、显示名。

都是纯函数。检查文件的函数交回问题清单，每条写明是哪个文件、为什么不行，调用方决定报错还是交给人看；
``check_*`` / ``clean_*`` 不合格直接抛 ``ValidationFailed``，消息给人看。"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection, Iterable, Mapping
from typing import Any

import yaml

from iclip.common.errors import ValidationFailed
from iclip.domains.skills.models import (
    MAX_DESCRIPTION_CHARS,
    MAX_DISPLAY_NAME_CHARS,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_NAME_CHARS,
    MAX_TOTAL_BYTES,
    REFERENCES_DIR,
    SKILL_MD,
    FileEntry,
)

_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
"""小写字母、数字与单个连字符，不以连字符开头或结尾。"""

_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*\r?$", re.DOTALL | re.MULTILINE)
_HEADING = re.compile(r"^# +(.+?)[ \t]*\r?$", re.MULTILINE)


def _mb(size: int) -> str:
    return f"{size // (1024 * 1024)} MB"


def name_problem(name: str) -> str | None:
    """不合 Agent Skills 规范的原因；合格给 ``None``。"""

    if not name:
        return "技能标识不能为空"
    if len(name) > MAX_NAME_CHARS:
        return f"技能标识最多 {MAX_NAME_CHARS} 个字符"
    if _NAME.fullmatch(name) is None:
        return "技能标识只能用小写字母、数字和连字符，不以连字符开头或结尾，也不能有连续的连字符"
    return None


def check_name(name: str) -> str:
    if (problem := name_problem(name)) is not None:
        raise ValidationFailed(problem)
    return name


def clean_display_name(display_name: str) -> str:
    """连续的空白（含换行）并成一个空格、去掉首尾；空的、超长的不收。"""

    cleaned = " ".join(display_name.split())
    if not cleaned:
        raise ValidationFailed("请填写显示名")
    if len(cleaned) > MAX_DISPLAY_NAME_CHARS:
        raise ValidationFailed(f"显示名最多 {MAX_DISPLAY_NAME_CHARS} 个字")
    return cleaned


def _description_problem(description: str) -> str | None:
    if not description.strip():
        return "description 不能为空"
    if len(description.strip()) > MAX_DESCRIPTION_CHARS:
        return f"description 最多 {MAX_DESCRIPTION_CHARS} 个字符"
    return None


def clean_description(description: str) -> str:
    """去掉首尾空白；空的、超长的不收。"""

    if (problem := _description_problem(description)) is not None:
        raise ValidationFailed(problem)
    return description.strip()


def clean_note(note: str | None) -> str | None:
    """去掉首尾空白，空的当作没有。"""

    if note is None:
        return None
    return note.strip() or None


def path_safety_problem(path: str) -> str | None:
    """路径本身不安全的原因：要相对的 posix 路径，不许绝对路径、``..``、反斜杠、空段与控制字符。"""

    if not path:
        return "路径为空"
    if "\\" in path:
        return "路径里不能有反斜杠"
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in path):
        return "路径里不能有控制字符"
    if path.startswith("/"):
        return "不能是绝对路径"
    segments = path.split("/")
    if any(segment in (".", "..") for segment in segments):
        return "路径里不能有 . 或 .."
    if any(not segment for segment in segments):
        return "路径里不能有空段"
    return None


def path_problem(path: str) -> str | None:
    """路径不收的原因：不安全，或不是 ``SKILL.md`` 也不在 ``references/`` 下。"""

    if (problem := path_safety_problem(path)) is not None:
        return problem
    if path != SKILL_MD and not path.startswith(REFERENCES_DIR):
        return f"只收 {SKILL_MD} 和 {REFERENCES_DIR} 下的文件"
    return None


def decode_text(data: bytes) -> str | None:
    """按 UTF-8 严格解码；不是 UTF-8 文本给 ``None``。"""

    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def content_problem(content: str) -> str | None:
    """内容不收的原因：含 NUL、编不成 UTF-8（孤立的代理字符），或超过单个文件的上限。"""

    if "\x00" in content:
        return "含 NUL 字符，不是文本"
    try:
        size = len(content.encode("utf-8"))
    except UnicodeEncodeError:
        return "不是合法的 UTF-8 文本"
    if size > MAX_FILE_BYTES:
        return f"超过单个文件的上限 {_mb(MAX_FILE_BYTES)}"
    return None


def limit_problems(sizes: Collection[int]) -> list[str]:
    """一组文件的文件数与总大小超没超上限。"""

    problems: list[str] = []
    if len(sizes) > MAX_FILES:
        problems.append(f"文件数 {len(sizes)} 个，超过上限 {MAX_FILES} 个")
    if sum(sizes) > MAX_TOTAL_BYTES:
        problems.append(f"文件合计超过上限 {_mb(MAX_TOTAL_BYTES)}")
    return problems


def file_problems(files: Mapping[str, str]) -> list[str]:
    """一整份文件（路径 → 内容）的全部问题：逐个文件的路径与内容、文件数与总大小、有没有 ``SKILL.md``。"""

    problems: list[str] = []
    for path in sorted(files):
        problem = path_problem(path) or content_problem(files[path])
        if problem is not None:
            problems.append(f"{path}：{problem}")
    problems += limit_problems([_size(content) for content in files.values()])
    if SKILL_MD not in files:
        problems.append(f"缺少 {SKILL_MD}")
    return problems


def _size(content: str) -> int:
    return len(content.encode("utf-8", errors="surrogatepass"))


def _frontmatter(skill_md: str) -> tuple[dict[str, Any] | None, str | None]:
    """frontmatter 解析成的映射，或解析不了的原因。"""

    match = _FRONTMATTER.match(skill_md)
    if match is None:
        return None, f"{SKILL_MD} 开头缺少 frontmatter（--- 包起来的 YAML）"
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None, f"{SKILL_MD} 的 frontmatter 不是合法的 YAML"
    if loaded is None:
        return {}, None
    if not isinstance(loaded, dict):
        return None, f"{SKILL_MD} 的 frontmatter 应是键值对"
    return loaded, None


def frontmatter_problems(skill_md: str, *, expected_name: str | None) -> list[str]:
    """frontmatter 的问题：要有 ``name``（给了 ``expected_name`` 就必须等于它，否则按标识规则查）与非空、
    不超长的 ``description``。"""

    found, problem = _frontmatter(skill_md)
    if found is None:
        return [problem or f"{SKILL_MD} 的 frontmatter 读不出来"]
    problems: list[str] = []
    name = found.get("name")
    if name is None:
        problems.append(f"{SKILL_MD} 的 frontmatter 缺少 name")
    elif not isinstance(name, str):
        problems.append(f"{SKILL_MD} 的 frontmatter 里 name 应是文字")
    elif expected_name is not None and name != expected_name:
        problems.append(
            f"{SKILL_MD} 的 frontmatter 里 name「{name}」与技能标识「{expected_name}」不一致"
        )
    elif expected_name is None and (name_issue := name_problem(name)) is not None:
        problems.append(f"{SKILL_MD} 的 frontmatter 里 name 不合格：{name_issue}")
    description = found.get("description")
    if description is None:
        problems.append(f"{SKILL_MD} 的 frontmatter 缺少 description")
    elif not isinstance(description, str):
        problems.append(f"{SKILL_MD} 的 frontmatter 里 description 应是文字")
    elif (description_issue := _description_problem(description)) is not None:
        problems.append(f"{SKILL_MD} 的 frontmatter 里 {description_issue}")
    return problems


def frontmatter_name(skill_md: str) -> str | None:
    """frontmatter 里合格的 ``name``；没有或不合格给 ``None``。"""

    found, _ = _frontmatter(skill_md)
    name = found.get("name") if found is not None else None
    if not isinstance(name, str) or name_problem(name) is not None:
        return None
    return name


def frontmatter_description(skill_md: str) -> str | None:
    """frontmatter 里合格的 ``description``（去掉首尾空白）；没有或不合格给 ``None``。"""

    found, _ = _frontmatter(skill_md)
    description = found.get("description") if found is not None else None
    if not isinstance(description, str) or _description_problem(description) is not None:
        return None
    return description.strip()


def default_display_name(skill_md: str, name: str) -> str:
    """frontmatter 之后第一个 ``# `` 标题（按显示名的规矩整理、截到上限）；没有标题就用 ``name``。"""

    match = _FRONTMATTER.match(skill_md)
    body = skill_md[match.end() :] if match is not None else skill_md
    heading = _HEADING.search(body)
    if heading is None:
        return name
    cleaned = " ".join(heading.group(1).split())[:MAX_DISPLAY_NAME_CHARS].strip()
    return cleaned or name


def initial_skill_md(*, name: str, display_name: str, description: str) -> str:
    """新建技能时的 ``SKILL.md`` 草稿：frontmatter 写 ``name`` 与 ``description``，正文是显示名作标题。"""

    frontmatter = yaml.safe_dump(
        {"name": name, "description": description},
        allow_unicode=True,
        sort_keys=False,
        width=1_000_000,
    )
    return f"---\n{frontmatter}---\n\n# {display_name}\n"


def file_hash(content: str) -> str:
    """内容按 UTF-8 编码后的 sha256，十六进制。"""

    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def file_entry(path: str, content: str) -> FileEntry:
    return FileEntry(path=path, size=len(content.encode("utf-8")), hash=file_hash(content))


def manifest(files: Mapping[str, str]) -> tuple[FileEntry, ...]:
    """一整份文件的清单，按 ``path`` 排。"""

    return tuple(file_entry(path, files[path]) for path in sorted(files))


def content_hash(entries: Iterable[FileEntry]) -> str:
    """清单的 hash：按 ``path`` 排好的 ``[{path, size, hash}]`` 规范化成 JSON（键排序、无空白、不转义
    非 ASCII）后的 sha256。已发布版本存着这个值，写法不能再改；草稿与版本都从 ``(path, size, hash)``
    现算，不从库里的 jsonb 回读再算。"""

    ordered = sorted(entries, key=lambda entry: entry.path)
    canonical = json.dumps(
        [{"path": entry.path, "size": entry.size, "hash": entry.hash} for entry in ordered],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def format_problems(problems: Iterable[str]) -> str:
    """把问题清单拼成一句给人看的报错。"""

    return "；".join(problems)


def check_publish(files: Mapping[str, str], *, name: str) -> str:
    """一份草稿能不能发布：文件、上限与 frontmatter 都合格时交回 frontmatter 的 ``description``（去掉
    首尾空白），否则 ``ValidationFailed`` 列出全部问题。"""

    problems = file_problems(files)
    if SKILL_MD in files:
        problems += frontmatter_problems(files[SKILL_MD], expected_name=name)
    if problems:
        raise ValidationFailed(format_problems(problems))
    description = frontmatter_description(files[SKILL_MD])
    if description is None:
        raise ValidationFailed(f"{SKILL_MD} 的 frontmatter 缺少 description")
    return description


__all__ = [
    "check_name",
    "check_publish",
    "clean_description",
    "clean_display_name",
    "clean_note",
    "content_hash",
    "content_problem",
    "decode_text",
    "default_display_name",
    "file_entry",
    "file_hash",
    "file_problems",
    "format_problems",
    "frontmatter_description",
    "frontmatter_name",
    "frontmatter_problems",
    "initial_skill_md",
    "limit_problems",
    "manifest",
    "name_problem",
    "path_problem",
    "path_safety_problem",
]

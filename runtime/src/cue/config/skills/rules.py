from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Collection, Iterable, Mapping
from typing import Any

import yaml

from cue.config.skills.models import (
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
from cue.errors import ValidationFailed

_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*\r?$", re.DOTALL | re.MULTILINE)
_NAME_KEY = re.compile(r"name[ \t]*:")


def _mb(size: int) -> str:
    return f"{size // (1024 * 1024)} MB"


def name_problem(name: str) -> str | None:
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
    if (problem := _description_problem(description)) is not None:
        raise ValidationFailed(problem)
    return description.strip()


def clean_note(note: str | None) -> str | None:
    if note is None:
        return None
    return note.strip() or None


def path_safety_problem(path: str) -> str | None:
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
    if (problem := path_safety_problem(path)) is not None:
        return problem
    if path != SKILL_MD and not path.startswith(REFERENCES_DIR):
        return f"只收 {SKILL_MD} 和 {REFERENCES_DIR} 下的文件"
    return None


def decode_text(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def content_problem(content: str) -> str | None:
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
    problems: list[str] = []
    if len(sizes) > MAX_FILES:
        problems.append(f"文件数 {len(sizes)} 个，超过上限 {MAX_FILES} 个")
    if sum(sizes) > MAX_TOTAL_BYTES:
        problems.append(f"文件合计超过上限 {_mb(MAX_TOTAL_BYTES)}")
    return problems


def file_problems(files: Mapping[str, str]) -> list[str]:
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


def _frontmatter_name_problem(name: object) -> str | None:
    if name is None:
        return f"{SKILL_MD} 的 frontmatter 缺少 name"
    if not isinstance(name, str):
        return f"{SKILL_MD} 的 frontmatter 里 name 应是文字"
    if (issue := name_problem(name)) is not None:
        return f"{SKILL_MD} 的 frontmatter 里 name 不合格：{issue}"
    return None


def frontmatter_problems(skill_md: str, *, require_name: bool) -> list[str]:
    found, problem = _frontmatter(skill_md)
    if found is None:
        return [problem or f"{SKILL_MD} 的 frontmatter 读不出来"]
    problems: list[str] = []
    if require_name and (name_issue := _frontmatter_name_problem(found.get("name"))) is not None:
        problems.append(name_issue)
    description = found.get("description")
    if description is None:
        problems.append(f"{SKILL_MD} 的 frontmatter 缺少 description")
    elif not isinstance(description, str):
        problems.append(f"{SKILL_MD} 的 frontmatter 里 description 应是文字")
    elif (description_issue := _description_problem(description)) is not None:
        problems.append(f"{SKILL_MD} 的 frontmatter 里 {description_issue}")
    return problems


def frontmatter_name(skill_md: str) -> str | None:
    found, _ = _frontmatter(skill_md)
    name = found.get("name") if found is not None else None
    if not isinstance(name, str) or name_problem(name) is not None:
        return None
    return name


def frontmatter_description(skill_md: str) -> str | None:
    found, _ = _frontmatter(skill_md)
    description = found.get("description") if found is not None else None
    if not isinstance(description, str) or _description_problem(description) is not None:
        return None
    return description.strip()


def with_frontmatter_name(skill_md: str, name: str) -> str:
    match = _FRONTMATTER.match(skill_md)
    if match is None:
        raise ValueError(f"{SKILL_MD} 开头缺少 frontmatter，写不进 name")
    found, _ = _frontmatter(skill_md)
    if found is not None and found.get("name") == name:
        return skill_md
    start, end = match.span(1)
    lines = skill_md[start:end].splitlines(keepends=True)
    eol = "\r\n" if "\r\n" in skill_md[: match.end()] else "\n"
    field = yaml.safe_dump({"name": name}, width=1_000_000).rstrip("\n") + eol
    first = next((index for index, line in enumerate(lines) if _NAME_KEY.match(line)), None)
    if first is None:
        lines.insert(0, field)
    else:
        last = first + 1
        while last < len(lines) and (lines[last][:1] in (" ", "\t") or not lines[last].strip()):
            last += 1
        while last > first + 1 and not lines[last - 1].strip():
            last -= 1
        lines[first:last] = [field]
    return skill_md[:start] + "".join(lines) + skill_md[end:]


def initial_skill_md(*, name: str, display_name: str, description: str) -> str:
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description},
        allow_unicode=True,
        sort_keys=False,
        width=1_000_000,
    )
    return f"---\n{frontmatter}---\n\n# {display_name}\n"


def file_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def file_entry(path: str, content: str) -> FileEntry:
    return FileEntry(path=path, size=len(content.encode("utf-8")), hash=file_hash(content))


def manifest(files: Mapping[str, str]) -> tuple[FileEntry, ...]:
    return tuple(file_entry(path, files[path]) for path in sorted(files))


def content_hash(entries: Iterable[FileEntry]) -> str:
    ordered = sorted(entries, key=lambda entry: entry.path)
    canonical = json.dumps(
        [{"path": entry.path, "size": entry.size, "hash": entry.hash} for entry in ordered],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def format_problems(problems: Iterable[str]) -> str:
    return "；".join(problems)


def check_publish(files: Mapping[str, str]) -> str:
    problems = file_problems(files)
    if SKILL_MD in files:
        problems += frontmatter_problems(files[SKILL_MD], require_name=False)
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
    "with_frontmatter_name",
]

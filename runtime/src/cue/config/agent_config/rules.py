from __future__ import annotations

from collections.abc import Iterable

from cue.config.agent_config.models import (
    AGENT_ID_PATTERN,
    MAX_DESCRIPTION_CHARS,
    MAX_NAME_CHARS,
    RESERVED_AGENT_IDS,
    Problem,
)
from cue.errors import ValidationFailed


def agent_id_problem(agent_id: str, *, new: bool = True) -> str | None:
    if AGENT_ID_PATTERN.fullmatch(agent_id) is None:
        return "标识只能用小写字母、数字和连字符，以小写字母开头，最多 40 个字符"
    if new and agent_id in RESERVED_AGENT_IDS:
        return f"{agent_id} 是保留词，不能用作标识"
    return None


def check_agent_id(agent_id: str) -> str:
    if (problem := agent_id_problem(agent_id)) is not None:
        raise ValidationFailed(problem)
    return agent_id


def clean_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned:
        raise ValidationFailed("请填写名称")
    if len(cleaned) > MAX_NAME_CHARS:
        raise ValidationFailed(f"名称最多 {MAX_NAME_CHARS} 个字")
    return cleaned


def clean_description(description: str) -> str:
    cleaned = description.strip()
    if len(cleaned) > MAX_DESCRIPTION_CHARS:
        raise ValidationFailed(f"描述最多 {MAX_DESCRIPTION_CHARS} 个字")
    return cleaned


def clean_note(note: str | None) -> str | None:
    if note is None:
        return None
    return note.strip() or None


def format_problems(problems: Iterable[Problem]) -> str:
    return "；".join(f"{one.path}：{one.message}" if one.path else one.message for one in problems)


__all__ = [
    "agent_id_problem",
    "check_agent_id",
    "clean_description",
    "clean_name",
    "clean_note",
    "format_problems",
]

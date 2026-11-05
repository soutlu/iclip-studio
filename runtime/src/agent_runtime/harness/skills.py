from __future__ import annotations

import shutil
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import RunContext, Tool
from pydantic_ai.workspaces import LocalWorkspaceBackend
from pydantic_ai_harness.skills import Skills

from agent_runtime.transcript.display import (
    DisplayFn,
    GenericDisplay,
    SkillCallDisplay,
    ToolDisplay,
    tool_note,
)

REFERENCES_DIRNAME = "references"

SKILL_FILENAME = "SKILL.md"

MAX_REFERENCE_CHARS = 40_000

TRUNCATION_MARKER = "\n\n[... 已截断，超出单次读取上限 ...]"


@dataclass(frozen=True, slots=True)
class CachedSkill:
    name: str
    library: str


def cached_skill(root: Path, *, name: str, key: str) -> CachedSkill | None:
    if (root / key / name / SKILL_FILENAME).is_file():
        return CachedSkill(name=name, library=key)
    return None


def materialize_skill(root: Path, *, name: str, key: str, files: Mapping[str, str]) -> CachedSkill:
    library = root / key
    if cached_skill(root, name=name, key=key) is None:
        root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{key}-", dir=root))
        try:
            skill_dir = staging / name
            for relative, content in files.items():
                parts = PurePosixPath(relative).parts
                if not parts or ".." in parts or PurePosixPath(relative).is_absolute():
                    raise ValueError(f"技能 {name} 的文件路径越界：{relative!r}")
                target = skill_dir.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            try:
                staging.rename(library)
            except OSError:
                if cached_skill(root, name=name, key=key) is None:
                    raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    return CachedSkill(name=name, library=key)


def build_skill_capabilities(
    root: Path, skills: Sequence[CachedSkill]
) -> tuple[AgentCapability[Any], ...]:
    granted = {skill.name: root / skill.library for skill in skills}
    if not granted:
        raise ValueError("build_skill_capabilities 至少要挑一个 skill；不挂就别调它。")
    loaded = Skills(
        list(dict.fromkeys(skill.library for skill in skills)),
        include=list(granted),
        workspace=LocalWorkspaceBackend(root),
    )
    return (loaded, _references_capability(granted))


def _references_capability(granted: Mapping[str, Path]) -> Capability[Any]:
    def validate_reference(ctx: RunContext[Any], skill: str, name: str) -> None:
        _ = ctx
        if skill not in granted:
            raise ModelRetry(f"没有挂载 skill {skill!r}。可读的是: {', '.join(granted)}。")
        if Path(name).suffix != ".md":
            raise ModelRetry(f"reference 只能是 .md 文档，收到 {name!r}。")

    def get_skill_reference(skill: str, name: str) -> ToolReturn[str]:
        """读取某个 skill 的一份 reference 文档。

        Args:
            skill: skill 名，即它在库里的目录名。
            name: reference 文件名（如 ``storyboard-spec.md``），不带目录前缀。
        """

        root = (granted[skill] / skill / REFERENCES_DIRNAME).resolve()
        target = (root / name).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            available = (
                sorted(str(item.relative_to(root)) for item in root.rglob("*.md"))
                if root.is_dir()
                else []
            )
            raise ModelRetry(
                f"skill {skill!r} 下没有 reference {name!r}。"
                + (f"它有: {', '.join(available)}。" if available else "它没有任何 reference。")
            )
        text = target.read_text(encoding="utf-8")
        if len(text) > MAX_REFERENCE_CHARS:
            text = text[:MAX_REFERENCE_CHARS] + TRUNCATION_MARKER
        return ToolReturn(return_value=text, metadata=tool_note(body="none"))

    return Capability[Any](
        id="skill-references",
        tools=[Tool(get_skill_reference, args_validator=validate_reference)],
    )


def skill_display_table() -> Mapping[str, DisplayFn]:
    return {"get_skill_reference": _reference_display, "load_capability": _load_display}


def _load_display(args: Any) -> ToolDisplay | None:
    loaded = args.get("id") if isinstance(args, dict) else None
    return GenericDisplay(summary="加载技能", detail=loaded if isinstance(loaded, str) else None)


def _reference_display(args: Any) -> ToolDisplay | None:
    if not isinstance(args, dict):
        return None
    skill = args.get("skill")
    name = args.get("name")
    if not isinstance(skill, str) or not skill:
        return None
    return SkillCallDisplay(skill_name=skill, args=name if isinstance(name, str) else None)


__all__ = [
    "MAX_REFERENCE_CHARS",
    "REFERENCES_DIRNAME",
    "TRUNCATION_MARKER",
    "CachedSkill",
    "build_skill_capabilities",
    "cached_skill",
    "materialize_skill",
    "skill_display_table",
]

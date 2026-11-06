from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_runtime.config.skills.rules import with_frontmatter_name
from agent_runtime.harness import skills as skills_module
from agent_runtime.harness.skills import (
    MAX_REFERENCE_CHARS,
    TRUNCATION_MARKER,
    CachedSkill,
    build_skill_capabilities,
    cached_skill,
    materialize_skill,
)

SKILL = "拆解素材"
OTHER = "镜头表"
TOOL = "get_skill_reference"


def skill_files(name: str, references: dict[str, str] | None = None) -> dict[str, str]:
    files = {"SKILL.md": f"---\nname: {name}\ndescription: 测试用 skill\n---\n\n照着 {name} 做。\n"}
    files.update({f"references/{path}": body for path, body in (references or {}).items()})
    return files


def make_skill(root: Path, name: str, *, references: dict[str, str] | None = None) -> CachedSkill:
    return materialize_skill(
        root,
        name=name,
        key=f"hash-{len(name)}-{name}",
        files=skill_files(name, references),
    )


async def read_reference(
    root: Path, skills: list[CachedSkill], *, skill: str, name: str
) -> ToolReturnPart:
    async def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(TOOL, {"skill": skill, "name": name})])
        return ModelResponse(parts=[TextPart("读完了")])

    agent = Agent(
        FunctionModel(call_once), capabilities=list(build_skill_capabilities(root, skills))
    )
    result = await agent.run("读一份 reference")
    parts = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == TOOL
    ]
    assert len(parts) == 1
    return parts[0]


def test_a_skill_is_written_once_under_its_key(tmp_path: Path) -> None:
    assert cached_skill(tmp_path, name=SKILL, key="h1") is None

    first = materialize_skill(tmp_path, name=SKILL, key="h1", files=skill_files(SKILL))
    again = materialize_skill(tmp_path, name=SKILL, key="h1", files={"SKILL.md": "不该写进去"})

    assert first == again == CachedSkill(name=SKILL, library="h1")
    assert cached_skill(tmp_path, name=SKILL, key="h1") == first
    assert "照着" in (tmp_path / "h1" / SKILL / "SKILL.md").read_text(encoding="utf-8")
    assert [path.name for path in tmp_path.iterdir()] == ["h1"], "临时目录不留在缓存里"


def test_a_new_version_lands_next_to_the_old_one(tmp_path: Path) -> None:
    materialize_skill(tmp_path, name=SKILL, key="h1", files=skill_files(SKILL))
    materialize_skill(tmp_path, name=SKILL, key="h2", files=skill_files(SKILL, {"新.md": "新"}))

    assert (tmp_path / "h1" / SKILL / "SKILL.md").is_file()
    assert (tmp_path / "h2" / SKILL / "references" / "新.md").read_text(encoding="utf-8") == "新"


def test_a_key_written_by_someone_else_in_between_is_reused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = materialize_skill(tmp_path, name=SKILL, key="h1", files=skill_files(SKILL))
    real = skills_module.cached_skill
    calls: list[str] = []

    def missing_once(root: Path, *, name: str, key: str) -> CachedSkill | None:
        calls.append(key)
        return None if len(calls) == 1 else real(root, name=name, key=key)

    monkeypatch.setattr(skills_module, "cached_skill", missing_once)
    again = materialize_skill(tmp_path, name=SKILL, key="h1", files={"SKILL.md": "后到的"})

    assert again == first
    assert len(calls) == 2, "改名失败后再查一次"
    assert "照着" in (tmp_path / "h1" / SKILL / "SKILL.md").read_text(encoding="utf-8")
    assert [path.name for path in tmp_path.iterdir()] == ["h1"]


async def test_a_renamed_skill_loads_under_its_new_name(tmp_path: Path) -> None:
    files = skill_files("old-name", {"规范.md": "规范正文"})
    files["SKILL.md"] = with_frontmatter_name(files["SKILL.md"], "new-name")
    cached = materialize_skill(tmp_path, name="new-name", key="k2", files=files)
    seen: list[str] = []

    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(info.instructions or "")
        return ModelResponse(parts=[TextPart("看完了")])

    await Agent(
        FunctionModel(peek), capabilities=list(build_skill_capabilities(tmp_path, [cached]))
    ).run("有哪些技能")
    part = await read_reference(tmp_path, [cached], skill="new-name", name="规范.md")

    assert "new-name" in seen[0]
    assert (part.outcome, part.content) == ("success", "规范正文")


@pytest.mark.parametrize("path", ["../逃出去.md", "/etc/passwd", "references/../../x.md"])
def test_files_outside_the_skill_directory_are_refused(tmp_path: Path, path: str) -> None:
    with pytest.raises(ValueError, match="越界"):
        materialize_skill(tmp_path, name=SKILL, key="h1", files={**skill_files(SKILL), path: "x"})
    assert cached_skill(tmp_path, name=SKILL, key="h1") is None


async def test_skills_from_different_versions_load_together(tmp_path: Path) -> None:
    seen: list[str] = []

    async def peek(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(info.instructions or "")
        return ModelResponse(parts=[TextPart("看完了")])

    skills = [make_skill(tmp_path, SKILL), make_skill(tmp_path, OTHER)]
    await Agent(
        FunctionModel(peek), capabilities=list(build_skill_capabilities(tmp_path, skills))
    ).run("有哪些技能")

    assert SKILL in seen[0] and OTHER in seen[0]


def test_mounting_zero_skills_is_a_caller_error(tmp_path: Path) -> None:

    with pytest.raises(ValueError, match="至少要挑一个 skill"):
        build_skill_capabilities(tmp_path, [])


async def test_granted_skill_reference_is_readable(tmp_path: Path) -> None:
    cached = make_skill(tmp_path, SKILL, references={"规范.md": "规范正文"})

    part = await read_reference(tmp_path, [cached], skill=SKILL, name="规范.md")

    assert part.outcome == "success"
    assert part.content == "规范正文"


async def test_ungranted_skill_references_are_refused(tmp_path: Path) -> None:

    cached = make_skill(tmp_path, SKILL)
    make_skill(tmp_path, OTHER, references={"规范.md": "别人的正文"})

    part = await read_reference(tmp_path, [cached], skill=OTHER, name="规范.md")

    assert part.outcome == "retried"
    assert "没有挂载 skill" in part.model_response_str()


@pytest.mark.parametrize(
    "name",
    ["../../etc/passwd", "../镜头表/references/规范.md", "/etc/passwd", "规范.txt", "不存在.md"],
)
async def test_reference_paths_outside_the_skill_are_refused(tmp_path: Path, name: str) -> None:

    skills = [
        make_skill(tmp_path, SKILL, references={"规范.md": "正文"}),
        make_skill(tmp_path, OTHER, references={"规范.md": "别人的正文"}),
    ]

    part = await read_reference(tmp_path, skills, skill=SKILL, name=name)

    assert part.outcome == "retried"


async def test_refusal_lists_the_available_references(tmp_path: Path) -> None:
    cached = make_skill(
        tmp_path,
        SKILL,
        references={"规范.md": "正文", "补充.md": "正文", "深处/细则.md": "正文"},
    )

    part = await read_reference(tmp_path, [cached], skill=SKILL, name="规范表.md")

    assert part.outcome == "retried"
    assert "它有: 深处/细则.md, 补充.md, 规范.md" in part.model_response_str()


async def test_nested_reference_is_readable(tmp_path: Path) -> None:
    cached = make_skill(tmp_path, SKILL, references={"深处/细则.md": "细则正文"})

    part = await read_reference(tmp_path, [cached], skill=SKILL, name="深处/细则.md")

    assert part.outcome == "success"
    assert part.content == "细则正文"


async def test_overlong_reference_is_truncated_loudly(tmp_path: Path) -> None:

    cached = make_skill(tmp_path, SKILL, references={"长文.md": "甲" * (MAX_REFERENCE_CHARS + 10)})

    part = await read_reference(tmp_path, [cached], skill=SKILL, name="长文.md")

    assert part.outcome == "success"
    text = part.content
    assert isinstance(text, str)
    assert text.endswith(TRUNCATION_MARKER)
    assert len(text) == MAX_REFERENCE_CHARS + len(TRUNCATION_MARKER)


async def test_broken_encoding_aborts_instead_of_retrying(tmp_path: Path) -> None:
    cached = make_skill(tmp_path, SKILL)
    references = tmp_path / cached.library / SKILL / "references"
    references.mkdir()
    (references / "坏.md").write_bytes(b"\xff\xfe\x00\x01")

    with pytest.raises(UnicodeDecodeError):
        await read_reference(tmp_path, [cached], skill=SKILL, name="坏.md")

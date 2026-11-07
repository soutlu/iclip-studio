from __future__ import annotations

import pytest

from cue.config.skills.models import (
    MAX_DESCRIPTION_CHARS,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_BYTES,
    SKILL_MD,
)
from cue.config.skills.rules import (
    check_name,
    check_publish,
    content_problem,
    decode_text,
    file_problems,
    frontmatter_description,
    frontmatter_name,
    frontmatter_problems,
    limit_problems,
    name_problem,
    path_problem,
    with_frontmatter_name,
)
from cue.errors import ValidationFailed


def skill_md(frontmatter: str, body: str = "\n# 标题\n") -> str:
    return f"---\n{frontmatter}---\n{body}"


GOOD = skill_md("name: pdf-tools\ndescription: 处理 PDF\n")


@pytest.mark.parametrize("name", ["a", "pdf-tools", "a1-b2-c3", "9", "x" * 64])
def test_names_following_the_agent_skills_spec_pass(name: str) -> None:
    assert name_problem(name) is None
    assert check_name(name) == name


@pytest.mark.parametrize(
    "name",
    ["", "x" * 65, "PDF", "pdf_tools", "pdf tools", "-pdf", "pdf-", "pdf--tools", "技能", "pdf.md"],
)
def test_names_outside_the_spec_are_rejected(name: str) -> None:
    assert name_problem(name) is not None
    with pytest.raises(ValidationFailed):
        check_name(name)


@pytest.mark.parametrize(
    "path", ["SKILL.md", "references/a.md", "references/sub/dir/b.txt", "references/中文.md"]
)
def test_skill_md_and_files_under_references_are_accepted(path: str) -> None:
    assert path_problem(path) is None


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/SKILL.md",
        "/references/a.md",
        "references/../SKILL.md",
        "../references/a.md",
        "./SKILL.md",
        "references\\a.md",
        "references//a.md",
        "references/",
        "references/a\x00.md",
        "references/a\n.md",
    ],
)
def test_unsafe_paths_are_rejected(path: str) -> None:
    assert path_problem(path) is not None


@pytest.mark.parametrize("path", ["scripts/run.py", "skill.md", "README.md", "assets/logo.svg"])
def test_paths_outside_the_allowed_range_are_rejected(path: str) -> None:
    assert path_problem(path) is not None


def test_only_utf8_text_without_nul_is_accepted() -> None:
    assert decode_text("中文".encode()) == "中文"
    assert decode_text(b"\xff\xfe\x00") is None
    assert decode_text("中文".encode("gbk")) is None
    assert content_problem("正文") is None
    assert content_problem("a\x00b") is not None
    assert content_problem("\ud800") is not None


def test_single_file_limit_counts_utf8_bytes() -> None:
    assert content_problem("a" * MAX_FILE_BYTES) is None
    assert content_problem("a" * (MAX_FILE_BYTES + 1)) is not None
    assert content_problem("中" * (MAX_FILE_BYTES // 3 + 1)) is not None


def test_file_count_and_total_size_limits() -> None:
    assert limit_problems([1] * MAX_FILES) == []
    assert len(limit_problems([1] * (MAX_FILES + 1))) == 1
    assert limit_problems([MAX_TOTAL_BYTES]) == []
    assert len(limit_problems([MAX_TOTAL_BYTES // 2, MAX_TOTAL_BYTES // 2 + 1])) == 1


def test_file_problems_name_every_bad_file_and_a_missing_skill_md() -> None:
    problems = file_problems({"scripts/run.py": "print(1)", "references/a.md": "a\x00"})

    assert len(problems) == 3
    assert [problem for problem in problems if problem.startswith("scripts/run.py")]
    assert [problem for problem in problems if problem.startswith("references/a.md")]
    assert file_problems({SKILL_MD: GOOD, "references/a.md": "ok"}) == []


def test_valid_frontmatter_has_no_problems() -> None:
    assert frontmatter_problems(GOOD, require_name=True) == []
    assert frontmatter_problems(GOOD, require_name=False) == []


@pytest.mark.parametrize(
    "content",
    [
        "# 没有 frontmatter\n",
        skill_md("name: pdf-tools\n"),
        skill_md("name: pdf-tools\ndescription: '   '\n"),
        skill_md(f"name: pdf-tools\ndescription: {'长' * (MAX_DESCRIPTION_CHARS + 1)}\n"),
        skill_md("name: pdf-tools\ndescription: [a, b]\n"),
        skill_md("name: [pdf-tools\ndescription: 处理 PDF\n"),
        skill_md("- just\n- a list\n"),
    ],
    ids=[
        "no-frontmatter",
        "missing-description",
        "blank-description",
        "description-too-long",
        "description-not-text",
        "invalid-yaml",
        "not-a-mapping",
    ],
)
def test_bad_frontmatter_is_reported(content: str) -> None:
    assert len(frontmatter_problems(content, require_name=True)) == 1
    assert len(frontmatter_problems(content, require_name=False)) == 1


def test_description_at_the_limit_passes() -> None:
    content = skill_md(f"name: pdf-tools\ndescription: {'长' * MAX_DESCRIPTION_CHARS}\n")
    assert frontmatter_problems(content, require_name=True) == []


@pytest.mark.parametrize(
    "frontmatter",
    [
        "description: 处理 PDF\n",
        "name: PDF_Tools\ndescription: 处理 PDF\n",
        "name: 1\ndescription: x\n",
    ],
    ids=["missing-name", "name-outside-the-spec", "name-not-text"],
)
def test_a_required_name_must_be_there_and_follow_the_spec(frontmatter: str) -> None:
    assert len(frontmatter_problems(skill_md(frontmatter), require_name=True)) == 1
    assert frontmatter_problems(skill_md(frontmatter), require_name=False) == []


@pytest.mark.parametrize(
    "frontmatter",
    ["name: other\ndescription: 处理 PDF\n", "description: 处理 PDF\n"],
    ids=["other-name", "no-name"],
)
def test_publishing_does_not_look_at_the_name(frontmatter: str) -> None:
    assert check_publish({SKILL_MD: skill_md(frontmatter)}) == "处理 PDF"


def test_check_publish_lists_every_problem() -> None:
    files = {SKILL_MD: skill_md("name: pdf-tools\n"), "scripts/run.py": "x"}

    with pytest.raises(ValidationFailed) as raised:
        check_publish(files)

    assert "scripts/run.py" in str(raised.value)
    assert "description" in str(raised.value)


def test_with_frontmatter_name_replaces_only_the_name_line() -> None:
    source = skill_md(
        "title: 工具\nname: old-name\ndescription: 处理 PDF\n", "\n# 正文\nname: 不动\n"
    )

    assert with_frontmatter_name(source, "new-name") == skill_md(
        "title: 工具\nname: new-name\ndescription: 处理 PDF\n", "\n# 正文\nname: 不动\n"
    )


def test_with_frontmatter_name_replaces_a_value_spread_over_lines() -> None:
    source = skill_md("name: >\n  old\n  name\n\ndescription: 处理 PDF\n")

    assert with_frontmatter_name(source, "new-name") == skill_md(
        "name: new-name\n\ndescription: 处理 PDF\n"
    )


def test_with_frontmatter_name_inserts_a_missing_name_first() -> None:
    source = "---\r\ndescription: 处理 PDF\r\nx: 1\r\n---\r\n\r\n正文\r\n"

    assert with_frontmatter_name(source, "pdf-tools") == (
        "---\r\nname: pdf-tools\r\ndescription: 处理 PDF\r\nx: 1\r\n---\r\n\r\n正文\r\n"
    )


def test_with_frontmatter_name_keeps_names_that_yaml_would_misread_as_text() -> None:
    renamed = with_frontmatter_name(GOOD, "123")

    assert frontmatter_name(renamed) == "123"
    assert frontmatter_description(renamed) == "处理 PDF"


def test_with_frontmatter_name_leaves_an_equal_name_untouched() -> None:
    source = skill_md("name: 'pdf-tools'\ndescription: 处理 PDF\n")

    assert with_frontmatter_name(source, "pdf-tools") is source


def test_with_frontmatter_name_refuses_a_file_without_frontmatter() -> None:
    with pytest.raises(ValueError, match="frontmatter"):
        with_frontmatter_name("# 没有 frontmatter\n", "pdf-tools")

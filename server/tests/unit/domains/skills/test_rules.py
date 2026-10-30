"""技能库规则：标识、路径安全与收录范围、文本与大小上限、frontmatter、清单与内容 hash、显示名默认值。"""

from __future__ import annotations

import hashlib

import pytest

from iclip.common.errors import ValidationFailed
from iclip.domains.skills.models import (
    MAX_DESCRIPTION_CHARS,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TOTAL_BYTES,
    SKILL_MD,
    FileEntry,
)
from iclip.domains.skills.rules import (
    check_name,
    check_publish,
    content_hash,
    content_problem,
    decode_text,
    default_display_name,
    file_problems,
    frontmatter_problems,
    initial_skill_md,
    limit_problems,
    manifest,
    name_problem,
    path_problem,
)


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
    assert frontmatter_problems(GOOD, expected_name="pdf-tools") == []
    assert frontmatter_problems(GOOD, expected_name=None) == []


@pytest.mark.parametrize(
    "content",
    [
        "# 没有 frontmatter\n",
        skill_md("description: 处理 PDF\n"),
        skill_md("name: other\ndescription: 处理 PDF\n"),
        skill_md("name: pdf-tools\n"),
        skill_md("name: pdf-tools\ndescription: '   '\n"),
        skill_md(f"name: pdf-tools\ndescription: {'长' * (MAX_DESCRIPTION_CHARS + 1)}\n"),
        skill_md("name: pdf-tools\ndescription: [a, b]\n"),
        skill_md("name: [pdf-tools\ndescription: 处理 PDF\n"),
        skill_md("- just\n- a list\n"),
    ],
    ids=[
        "no-frontmatter",
        "missing-name",
        "name-mismatch",
        "missing-description",
        "blank-description",
        "description-too-long",
        "description-not-text",
        "invalid-yaml",
        "not-a-mapping",
    ],
)
def test_bad_frontmatter_is_reported(content: str) -> None:
    assert len(frontmatter_problems(content, expected_name="pdf-tools")) == 1


def test_description_at_the_limit_passes() -> None:
    content = skill_md(f"name: pdf-tools\ndescription: {'长' * MAX_DESCRIPTION_CHARS}\n")
    assert frontmatter_problems(content, expected_name="pdf-tools") == []


def test_without_an_expected_name_the_name_itself_must_follow_the_spec() -> None:
    content = skill_md("name: PDF_Tools\ndescription: 处理 PDF\n")
    assert len(frontmatter_problems(content, expected_name=None)) == 1


def test_manifest_is_sorted_by_path_and_hash_is_order_independent() -> None:
    one = {"references/b.md": "b", SKILL_MD: GOOD, "references/a.md": "a"}
    other = {"references/a.md": "a", "references/b.md": "b", SKILL_MD: GOOD}

    assert [entry.path for entry in manifest(one)] == [
        SKILL_MD,
        "references/a.md",
        "references/b.md",
    ]
    assert manifest(one) == manifest(other)
    assert content_hash(manifest(one)) == content_hash(reversed(manifest(other)))
    assert content_hash(manifest(one)) != content_hash(manifest({**one, "references/a.md": "A"}))


def test_content_hash_is_sha256_of_the_canonical_manifest_json() -> None:
    """已发布版本存着这个值，规范化写法是持久化合同：键排序、无空白、不转义非 ASCII。"""

    entry = FileEntry(path="references/中.md", size=3, hash="ab")
    canonical = '[{"hash":"ab","path":"references/中.md","size":3}]'

    assert content_hash([entry]) == hashlib.sha256(canonical.encode()).hexdigest()
    assert manifest({"references/中.md": "中"}) == (
        FileEntry(path="references/中.md", size=3, hash=hashlib.sha256("中".encode()).hexdigest()),
    )


def test_display_name_defaults_to_the_first_h1_heading() -> None:
    content = skill_md(
        "name: pdf-tools\ndescription: x\n# YAML 注释不算\n",
        "\n## 小标题\n#   处理  PDF  \n# 第二个\n",
    )
    assert default_display_name(content, "pdf-tools") == "处理 PDF"


@pytest.mark.parametrize(
    "body", ["\n## 只有二级标题\n", "\n#没有空格\n", "\n正文\n", "\n#   \n"], ids=str
)
def test_display_name_falls_back_to_the_name(body: str) -> None:
    content = skill_md("name: pdf-tools\ndescription: x\n", body)
    assert default_display_name(content, "pdf-tools") == "pdf-tools"


def test_initial_skill_md_passes_publish_checks_and_keeps_the_display_name() -> None:
    content = initial_skill_md(
        name="pdf-tools", display_name="PDF 工具", description="读取: 'PDF' 与 \"表格\"\n第二行"
    )

    assert check_publish({SKILL_MD: content}, name="pdf-tools") == "读取: 'PDF' 与 \"表格\"\n第二行"
    assert default_display_name(content, "pdf-tools") == "PDF 工具"


def test_check_publish_lists_every_problem() -> None:
    files = {SKILL_MD: skill_md("name: other\n"), "scripts/run.py": "x"}

    with pytest.raises(ValidationFailed) as raised:
        check_publish(files, name="pdf-tools")

    assert "scripts/run.py" in str(raised.value)
    assert "other" in str(raised.value)

from __future__ import annotations

import io
import uuid
import zipfile
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
from cue.config.agent_config.infra_sql import SqlAgentStore
from cue.config.agent_config.public import AgentReferences
from cue.config.skills.infra_sql import SqlSkillStore
from cue.config.skills.schemas import (
    DraftFileWriteIn,
    SkillCreateIn,
    SkillPublishIn,
    SkillUpdateIn,
)
from cue.config.skills.service import SkillsService
from cue.errors import Conflict, NotFound, ValidationFailed
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.references import plant_user

TABLES = ("skills", "skill_draft_files", "skill_versions", "skill_version_files")


@pytest.fixture
def service(engine: AsyncEngine) -> SkillsService:
    return SkillsService(SqlSkillStore(engine), usages=AgentReferences(SqlAgentStore(engine)))


@pytest.fixture
async def author(engine: AsyncEngine) -> uuid.UUID:
    return await plant_user(engine, "skill-author")


@asynccontextmanager
async def failing_version_files(engine: AsyncEngine) -> AsyncGenerator[None]:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE FUNCTION agent_runtime.test_fail_skill_version_files() RETURNS trigger"
                " LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'version files refused'; END $$"
            )
        )
        await conn.execute(
            text(
                "CREATE TRIGGER test_fail_skill_version_files"
                " BEFORE INSERT ON agent_runtime.skill_version_files"
                " FOR EACH ROW EXECUTE FUNCTION agent_runtime.test_fail_skill_version_files()"
            )
        )
    try:
        yield
    finally:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "DROP TRIGGER test_fail_skill_version_files"
                    " ON agent_runtime.skill_version_files"
                )
            )
            await conn.execute(text("DROP FUNCTION agent_runtime.test_fail_skill_version_files()"))


async def row_counts(engine: AsyncEngine) -> dict[str, int]:
    async with engine.connect() as conn:
        return {
            table: (
                await conn.execute(text(f"SELECT count(*) FROM agent_runtime.{table}"))
            ).scalar_one()
            for table in TABLES
        }


def skill_md(name: str, description: str, heading: str = "PDF 工具") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n# {heading}\n"


def make_zip(files: dict[str, str], *, top: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in files.items():
            archive.writestr(f"{top}/{path}" if top else path, content.encode())
    return buffer.getvalue()


async def new_skill(
    service: SkillsService, author: uuid.UUID, name: str = "pdf-tools"
) -> uuid.UUID:
    created = await service.create(
        SkillCreateIn(name=name, display_name="PDF 工具", description="处理 PDF"), by=author
    )
    return created.id


async def draft_contents(service: SkillsService, skill_id: uuid.UUID) -> dict[str, str]:
    detail = await service.detail(skill_id)
    return {
        one.path: (await service.read_file(skill_id, one.path)).content
        for one in detail.draft_files
    }


async def put(
    service: SkillsService,
    skill_id: uuid.UUID,
    author: uuid.UUID,
    path: str,
    content: str,
) -> str:
    try:
        base: str | None = (await service.read_file(skill_id, path)).hash
    except NotFound:
        base = None
    written = await service.write_file(
        skill_id, path, DraftFileWriteIn(content=content, base_hash=base), by=author
    )
    return written.hash


async def test_failed_publish_leaves_no_version_and_keeps_the_pointer(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    skill_id = await new_skill(service, author)
    first = await service.publish(skill_id, SkillPublishIn(note="第一版"), by=author)
    await put(service, skill_id, author, "SKILL.md", skill_md("pdf-tools", "改过的描述"))
    before = await row_counts(engine)

    async with failing_version_files(engine):
        with pytest.raises(DBAPIError):
            await service.publish(skill_id, SkillPublishIn(), by=author)

    detail = await service.detail(skill_id)
    assert await row_counts(engine) == before
    assert (detail.latest_version_id, detail.latest_version) == (first.id, 1)
    assert detail.description == "处理 PDF"
    assert [one.version for one in (await service.versions(skill_id)).items] == [1]


async def test_draft_writes_and_deletes_check_the_base_hash(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    path = "references/sub/guide.md"

    created = await service.write_file(
        skill_id, path, DraftFileWriteIn(content="v1", base_hash=None), by=author
    )
    with pytest.raises(Conflict):
        await service.write_file(
            skill_id, path, DraftFileWriteIn(content="again", base_hash=None), by=author
        )
    with pytest.raises(Conflict):
        await service.write_file(
            skill_id, path, DraftFileWriteIn(content="stale", base_hash="0" * 64), by=author
        )
    updated = await service.write_file(
        skill_id, path, DraftFileWriteIn(content="v2", base_hash=created.hash), by=author
    )
    with pytest.raises(Conflict):
        await service.delete_file(skill_id, path, base_hash=created.hash)
    assert (await service.read_file(skill_id, path)).content == "v2"

    await service.delete_file(skill_id, path, base_hash=updated.hash)

    with pytest.raises(NotFound):
        await service.read_file(skill_id, path)
    with pytest.raises(Conflict):
        await service.write_file(
            skill_id, path, DraftFileWriteIn(content="v3", base_hash=updated.hash), by=author
        )


async def test_unchanged_draft_is_not_published_and_versions_count_up(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    skill_id = await new_skill(service, author)
    assert (await service.detail(skill_id)).has_unpublished_changes is True

    first = await service.publish(skill_id, SkillPublishIn(note="  "), by=author)
    assert (first.version, first.note) == (1, None)
    assert (await service.detail(skill_id)).has_unpublished_changes is False
    with pytest.raises(ValidationFailed):
        await service.publish(skill_id, SkillPublishIn(), by=author)
    assert (await row_counts(engine))["skill_versions"] == 1

    await put(service, skill_id, author, "references/a.md", "参考")
    assert (await service.list()).items[0].has_unpublished_changes is True
    second = await service.publish(skill_id, SkillPublishIn(note="加参考"), by=author)

    assert (second.version, second.note) == (2, "加参考")
    assert [one.version for one in (await service.versions(skill_id)).items] == [2, 1]
    detail = await service.detail(skill_id)
    assert (detail.latest_version_id, detail.latest_version) == (second.id, 2)
    assert detail.has_unpublished_changes is False
    assert [one.path for one in (await service.version(skill_id, second.id)).files] == [
        "SKILL.md",
        "references/a.md",
    ]
    assert (await service.version_file(skill_id, second.id, "references/a.md")).content == "参考"


async def test_publish_rejects_an_invalid_draft_and_description_follows_publishing(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    skill_id = await new_skill(service, author)
    await put(service, skill_id, author, "SKILL.md", skill_md("pdf-tools", "草稿描述"))
    assert (await service.detail(skill_id)).description == "草稿描述"
    await put(service, skill_id, author, "SKILL.md", "---\nname: pdf-tools\n---\n")
    assert (await service.detail(skill_id)).description == "草稿描述"
    with pytest.raises(ValidationFailed):
        await service.publish(skill_id, SkillPublishIn(), by=author)
    assert (await row_counts(engine))["skill_versions"] == 0

    await put(service, skill_id, author, "SKILL.md", skill_md("pdf-tools", "发布的描述"))
    await service.publish(skill_id, SkillPublishIn(), by=author)
    await put(service, skill_id, author, "SKILL.md", skill_md("pdf-tools", "还没发布的描述"))

    assert (await service.detail(skill_id)).description == "发布的描述"


async def test_restore_copies_the_version_back_over_the_whole_draft(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    await put(service, skill_id, author, "references/a.md", "a1")
    first = await service.publish(skill_id, SkillPublishIn(), by=author)
    v1 = await draft_contents(service, skill_id)
    await put(service, skill_id, author, "references/a.md", "a2")
    await put(service, skill_id, author, "references/b.md", "b")
    await service.publish(skill_id, SkillPublishIn(), by=author)

    restored = await service.restore(skill_id, first.id, by=author)

    assert await draft_contents(service, skill_id) == v1
    assert [(one.path, one.hash) for one in restored.draft_files] == [
        (one.path, one.hash) for one in (await service.version(skill_id, first.id)).files
    ]
    assert restored.latest_version == 2
    assert restored.has_unpublished_changes is True


async def test_import_check_writes_nothing_and_import_only_writes_the_draft(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    files = {"SKILL.md": skill_md("pdf-tools", "导入的描述"), "references/a.md": "a"}
    data = make_zip(files, top="pdf-tools")

    checked = await service.import_archive(data, dry_run=True, by=author)

    assert (checked.action, checked.skill_id, checked.problems) == ("create", None, [])
    assert (checked.name, checked.display_name, checked.description) == (
        "pdf-tools",
        "pdf-tools",
        "导入的描述",
    )
    assert [one.path for one in checked.files] == ["SKILL.md", "references/a.md"]
    assert await row_counts(engine) == dict.fromkeys(TABLES, 0)

    imported = await service.import_archive(data, dry_run=False, by=author)
    assert imported.skill_id is not None
    detail = await service.detail(imported.skill_id)
    assert await draft_contents(service, imported.skill_id) == files
    assert (detail.name, detail.display_name, detail.description) == (
        "pdf-tools",
        "pdf-tools",
        "导入的描述",
    )
    assert (detail.latest_version_id, detail.status) == (None, "active")
    assert (await row_counts(engine))["skill_versions"] == 0

    await service.rename(imported.skill_id, SkillUpdateIn(display_name="改过的名字"))
    changed = {"SKILL.md": skill_md("pdf-tools", "覆盖的描述", "别的标题")}
    again = make_zip(changed)
    assert (await service.import_archive(again, dry_run=True, by=author)).skill_id == (
        imported.skill_id
    )
    overwritten = await service.import_archive(again, dry_run=False, by=author)

    assert (overwritten.action, overwritten.skill_id) == ("overwrite", imported.skill_id)
    assert await draft_contents(service, imported.skill_id) == changed
    detail = await service.detail(imported.skill_id)
    assert (detail.display_name, detail.description) == ("改过的名字", "覆盖的描述")
    assert (await row_counts(engine))["skills"] == 1
    assert (await row_counts(engine))["skill_versions"] == 0


async def test_import_with_problems_is_rejected_without_writing(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    data = make_zip({"SKILL.md": skill_md("pdf-tools", "描述"), "scripts/run.py": "print(1)"})

    checked = await service.import_archive(data, dry_run=True, by=author)
    assert [problem for problem in checked.problems if "scripts/run.py" in problem]
    with pytest.raises(ValidationFailed):
        await service.import_archive(data, dry_run=False, by=author)

    assert await row_counts(engine) == dict.fromkeys(TABLES, 0)


async def test_exported_version_imports_back_to_the_same_files(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    await put(service, skill_id, author, "references/中文.md", "第一行\r\n第二行")
    await put(service, skill_id, author, "references/sub/b.txt", "")
    version = await service.publish(skill_id, SkillPublishIn(), by=author)
    await put(service, skill_id, author, "references/sub/b.txt", "改了但没发布")

    exported = await service.export(skill_id, None)

    assert exported.filename == "pdf-tools-v1.zip"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert {name.split("/", 1)[0] for name in archive.namelist()} == {"pdf-tools"}
    checked = await service.import_archive(exported.content, dry_run=True, by=author)
    assert checked.problems == []
    assert checked.files == (await service.version(skill_id, version.id)).files

    await service.import_archive(exported.content, dry_run=False, by=author)

    assert await draft_contents(service, skill_id) == {
        path: (await service.version_file(skill_id, version.id, path)).content
        for path in [one.path for one in checked.files]
    }
    assert (await service.detail(skill_id)).has_unpublished_changes is False


async def test_renaming_a_published_skill_leaves_versions_and_draft_alone(
    service: SkillsService, author: uuid.UUID, engine: AsyncEngine
) -> None:
    skill_id = await new_skill(service, author)
    await service.publish(skill_id, SkillPublishIn(), by=author)
    draft_before = await draft_contents(service, skill_id)
    counts_before = await row_counts(engine)

    renamed = await service.rename(skill_id, SkillUpdateIn(name="pdf-kit"))

    assert (renamed.name, renamed.display_name) == ("pdf-kit", "PDF 工具")
    assert (renamed.latest_version, renamed.has_unpublished_changes) == (1, False)
    assert await draft_contents(service, skill_id) == draft_before
    assert await row_counts(engine) == counts_before
    assert (await service.detail(skill_id)).name == "pdf-kit"


async def test_a_name_taken_by_another_skill_is_a_conflict_and_changes_nothing(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    other_id = await new_skill(service, author, name="pdf-kit")
    before = await service.detail(skill_id)

    with pytest.raises(Conflict, match="标识 pdf-kit 已被技能「PDF 工具」占用"):
        await service.rename(skill_id, SkillUpdateIn(name="pdf-kit", display_name="新名字"))

    assert await service.detail(skill_id) == before
    assert (await service.detail(other_id)).name == "pdf-kit"


async def test_rename_checks_the_name_and_needs_at_least_one_field(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)

    with pytest.raises(ValidationFailed):
        await service.rename(skill_id, SkillUpdateIn())
    with pytest.raises(ValidationFailed):
        await service.rename(skill_id, SkillUpdateIn(name="PDF_Kit"))
    renamed = await service.rename(
        skill_id, SkillUpdateIn(display_name="  新的  名字 ", name="pdf-tools")
    )

    assert (renamed.name, renamed.display_name) == ("pdf-tools", "新的 名字")


async def test_a_renamed_skill_publishes_with_the_old_name_in_its_draft(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    await service.rename(skill_id, SkillUpdateIn(name="pdf-kit"))
    assert "name: pdf-tools\n" in (await service.read_file(skill_id, "SKILL.md")).content

    version = await service.publish(skill_id, SkillPublishIn(), by=author)

    assert version.version == 1
    stored = await service.version_file(skill_id, version.id, "SKILL.md")
    assert "name: pdf-tools\n" in stored.content, "版本里的文件原样存，不改 name"


async def test_export_uses_the_current_name_even_for_an_older_version(
    service: SkillsService, author: uuid.UUID
) -> None:
    skill_id = await new_skill(service, author)
    first = await service.publish(skill_id, SkillPublishIn(), by=author)
    await put(service, skill_id, author, "references/a.md", "参考")
    await service.publish(skill_id, SkillPublishIn(), by=author)
    await service.rename(skill_id, SkillUpdateIn(name="pdf-kit"))

    exported = await service.export(skill_id, first.id)

    assert exported.filename == "pdf-kit-v1.zip"
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        assert archive.namelist() == ["pdf-kit/SKILL.md"]
        skill_md_text = archive.read("pdf-kit/SKILL.md").decode()
    assert skill_md_text == skill_md("pdf-kit", "处理 PDF")
    checked = await service.import_archive(exported.content, dry_run=True, by=author)
    assert (checked.action, checked.skill_id, checked.name) == ("overwrite", skill_id, "pdf-kit")

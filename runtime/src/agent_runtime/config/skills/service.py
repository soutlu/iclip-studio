"""技能库用例：建技能、改草稿、发布与读版本、恢复到草稿、归档，以及 zip 导入导出。

同一技能的草稿修改、发布、恢复与覆盖导入都在锁住这个技能行的事务里做，判断与写入看到的是同一份草稿。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from agent_runtime.agent_usage import AgentUsage, in_use_message, usages_out
from agent_runtime.config.skills.archive import read_archive, write_archive
from agent_runtime.config.skills.models import (
    SKILL_MD,
    STATUS_ACTIVE,
    STATUS_ARCHIVED,
    DraftFileInfo,
    FileEntry,
    Skill,
    SkillStatus,
    SkillVersion,
)
from agent_runtime.config.skills.repository import SkillStore, SkillUsages, SkillWriter
from agent_runtime.config.skills.rules import (
    check_name,
    check_publish,
    clean_description,
    clean_display_name,
    clean_note,
    content_hash,
    content_problem,
    default_display_name,
    file_entry,
    format_problems,
    frontmatter_description,
    frontmatter_name,
    frontmatter_problems,
    initial_skill_md,
    limit_problems,
    manifest,
    path_problem,
)
from agent_runtime.config.skills.schemas import (
    DraftFileInfoOut,
    DraftFileOut,
    DraftFileRenameIn,
    DraftFileWriteIn,
    SkillCreateIn,
    SkillDetailOut,
    SkillFileOut,
    SkillImportOut,
    SkillOut,
    SkillPublishIn,
    SkillsOut,
    SkillUpdateIn,
    SkillVersionDetailOut,
    SkillVersionFileOut,
    SkillVersionOut,
    SkillVersionsOut,
)
from agent_runtime.errors import Conflict, NotFound, ValidationFailed


@dataclass(frozen=True, slots=True)
class SkillArchive:
    """导出的压缩包：下载用的文件名与 zip 的字节。"""

    filename: str
    content: bytes


def _has_unpublished_changes(skill: Skill, draft_hash: str) -> bool:
    return skill.latest_content_hash is None or draft_hash != skill.latest_content_hash


def _skill_out(skill: Skill, draft_hash: str) -> SkillOut:
    return SkillOut(
        id=skill.id,
        name=skill.name,
        display_name=skill.display_name,
        description=skill.description,
        status=skill.status,
        latest_version_id=skill.latest_version_id,
        latest_version=skill.latest_version,
        has_unpublished_changes=_has_unpublished_changes(skill, draft_hash),
        created_by=skill.created_by,
        created_at=skill.created_at,
        updated_at=skill.updated_at,
    )


def _detail_out(
    skill: Skill, draft: Sequence[DraftFileInfo], users: Sequence[AgentUsage]
) -> SkillDetailOut:
    entries = [FileEntry(path=info.path, size=info.size, hash=info.hash) for info in draft]
    summary = _skill_out(skill, content_hash(entries))
    return SkillDetailOut(
        **summary.model_dump(),
        draft_files=[
            DraftFileInfoOut(
                path=info.path, size=info.size, hash=info.hash, updated_at=info.updated_at
            )
            for info in draft
        ],
        used_by=usages_out(users),
    )


def _file_out(entry: FileEntry) -> SkillFileOut:
    return SkillFileOut(path=entry.path, size=entry.size, hash=entry.hash)


def _version_out(version: SkillVersion) -> SkillVersionOut:
    return SkillVersionOut(
        id=version.id,
        version=version.version,
        note=version.note,
        content_hash=version.content_hash,
        created_by=version.created_by,
        created_at=version.created_at,
    )


def _check_draft_path(path: str) -> None:
    if (problem := path_problem(path)) is not None:
        raise ValidationFailed(f"{path}：{problem}")


async def _sync_unpublished_description(writer: SkillWriter, skill_md: str) -> None:
    """还没发布过的技能，``description`` 跟着草稿里的 ``SKILL.md`` 走；frontmatter 不合格时不动。"""

    if writer.skill.latest_version_id is not None:
        return
    description = frontmatter_description(skill_md)
    if description is not None and description != writer.skill.description:
        await writer.update(description=description)


class SkillsService:
    """``usages`` 由组合根接到 agent 配置域，回答哪些 agent 在用一个技能。"""

    def __init__(self, store: SkillStore, *, usages: SkillUsages) -> None:
        self._store = store
        self._usages = usages

    async def list(self) -> SkillsOut:
        """全部技能，带有没有未发布的修改。"""

        summaries = await self._store.list()
        return SkillsOut(
            items=[_skill_out(summary.skill, summary.draft_hash) for summary in summaries]
        )

    async def detail(self, skill_id: uuid.UUID) -> SkillDetailOut:
        """一个技能连同草稿的文件清单与在用它的 agent；没有这个技能是 ``NotFound``。"""

        skill = await self._require(skill_id)
        return _detail_out(
            skill, await self._store.draft(skill_id), await self._usages.skill_users(skill_id)
        )

    async def catalog(self) -> tuple[Skill, ...]:
        """全部技能，含已归档的，供别的模块查标识、状态与最新版。"""

        return tuple(summary.skill for summary in await self._store.list())

    async def version_files(self, version_id: uuid.UUID) -> Mapping[str, str]:
        """一个已发布版本的全部文件（路径 → 内容），供运行时写进本机缓存；版本发布后不再变。"""

        return await self._store.version_files(version_id)

    async def create(self, body: SkillCreateIn, *, by: uuid.UUID) -> SkillDetailOut:
        """建一个技能，草稿里只有按标识、显示名与描述生成的 ``SKILL.md``。标识不合规矩、显示名或描述
        为空或超长是 ``ValidationFailed``，标识已被占用是 ``Conflict``。"""

        name = check_name(body.name)
        display_name = clean_display_name(body.display_name)
        description = clean_description(body.description)
        skill_id = uuid.uuid4()
        await self._store.create(
            skill_id,
            name=name,
            display_name=display_name,
            description=description,
            files={
                SKILL_MD: initial_skill_md(
                    name=name, display_name=display_name, description=description
                )
            },
            by=by,
        )
        return await self.detail(skill_id)

    async def rename(self, skill_id: uuid.UUID, body: SkillUpdateIn) -> SkillDetailOut:
        """改显示名；标识不能改。"""

        display_name = clean_display_name(body.display_name)
        async with self._store.edit(skill_id) as writer:
            await writer.update(display_name=display_name)
        return await self.detail(skill_id)

    async def read_file(self, skill_id: uuid.UUID, path: str) -> DraftFileOut:
        """草稿里的一个文件；没有这个技能或文件是 ``NotFound``。"""

        await self._require(skill_id)
        found = await self._store.draft_file(skill_id, path)
        if found is None:
            raise NotFound("文件不存在")
        return DraftFileOut(
            path=found.path,
            content=found.content,
            size=found.size,
            hash=found.hash,
            updated_at=found.updated_at,
        )

    async def write_file(
        self, skill_id: uuid.UUID, path: str, body: DraftFileWriteIn, *, by: uuid.UUID
    ) -> DraftFileOut:
        """写草稿里的一个文件。``base_hash`` 为 ``None`` 是新建，文件已存在是 ``Conflict``；否则要与库里
        的 ``hash`` 一致，不一致或文件已被删掉是 ``Conflict``。路径、内容或写完后的文件数与总大小不合格是
        ``ValidationFailed``；``SKILL.md`` 的 frontmatter 发布时才查。"""

        _check_draft_path(path)
        if (problem := content_problem(body.content)) is not None:
            raise ValidationFailed(f"{path}：{problem}")
        entry = file_entry(path, body.content)
        async with self._store.edit(skill_id) as writer:
            draft = {info.path: info for info in await writer.draft()}
            current = draft.get(path)
            if body.base_hash is None and current is not None:
                raise Conflict("文件已存在，请读取最新内容后再改")
            if body.base_hash is not None and (current is None or current.hash != body.base_hash):
                raise Conflict("文件已被改动或删除，请读取最新内容后再改")
            sizes = [info.size for other, info in draft.items() if other != path]
            if problems := limit_problems([*sizes, entry.size]):
                raise ValidationFailed(format_problems(problems))
            await writer.put_file(path, body.content, by=by)
            if path == SKILL_MD:
                await _sync_unpublished_description(writer, body.content)
        return await self.read_file(skill_id, path)

    async def delete_file(self, skill_id: uuid.UUID, path: str, *, base_hash: str) -> None:
        """删草稿里的一个文件。``SKILL.md`` 不能删（``ValidationFailed``）；文件不存在是 ``NotFound``，
        ``base_hash`` 与库里的不一致是 ``Conflict``。"""

        if path == SKILL_MD:
            raise ValidationFailed(f"{SKILL_MD} 不能删")
        async with self._store.edit(skill_id) as writer:
            current = {info.path: info for info in await writer.draft()}.get(path)
            if current is None:
                raise NotFound("文件不存在")
            if current.hash != base_hash:
                raise Conflict("文件已被改动，请读取最新内容后再删")
            await writer.delete_file(path)

    async def move_file(
        self, skill_id: uuid.UUID, body: DraftFileRenameIn, *, by: uuid.UUID
    ) -> DraftFileOut:
        """把草稿里的一个文件改到新路径，内容不变，一次写完。``SKILL.md`` 不能改名、新路径不合格或与原路径
        相同是 ``ValidationFailed``；原文件不存在是 ``NotFound``；``base_hash`` 与库里的不一致、新路径已有
        文件是 ``Conflict``。"""

        if body.source == SKILL_MD:
            raise ValidationFailed(f"{SKILL_MD} 不能改名")
        _check_draft_path(body.target)
        if body.target == body.source:
            raise ValidationFailed("新路径与原路径相同")
        async with self._store.edit(skill_id) as writer:
            draft = {info.path: info for info in await writer.draft()}
            current = draft.get(body.source)
            if current is None:
                raise NotFound("文件不存在")
            if current.hash != body.base_hash:
                raise Conflict("文件已被改动，请读取最新内容后再改名")
            if body.target in draft:
                raise Conflict(f"{body.target} 已存在")
            await writer.move_file(body.source, body.target, by=by)
        return await self.read_file(skill_id, body.target)

    async def publish(
        self, skill_id: uuid.UUID, body: SkillPublishIn, *, by: uuid.UUID
    ) -> SkillVersionOut:
        """把草稿发布成一个新版本：校验草稿，算清单与内容 hash，与最新版相同就拒绝，再在同一个事务里
        写版本与文件、移动最新版、更新 ``description``。草稿不合格、没有改动都是 ``ValidationFailed``。"""

        note = clean_note(body.note)
        version_id = uuid.uuid4()
        async with self._store.edit(skill_id) as writer:
            files = await writer.draft_contents()
            description = check_publish(files, name=writer.skill.name)
            entries = manifest(files)
            digest = content_hash(entries)
            if digest == writer.skill.latest_content_hash:
                raise ValidationFailed("没有可发布的改动")
            await writer.add_version(
                version_id,
                note=note,
                files=files,
                manifest=entries,
                content_hash=digest,
                description=description,
                by=by,
            )
        return _version_out(await self._require_version(skill_id, version_id))

    async def versions(self, skill_id: uuid.UUID) -> SkillVersionsOut:
        await self._require(skill_id)
        return SkillVersionsOut(
            items=[_version_out(version) for version in await self._store.versions(skill_id)]
        )

    async def version(self, skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersionDetailOut:
        """一个版本连同它的清单；没有这个技能或版本是 ``NotFound``。"""

        version = await self._require_version(skill_id, version_id)
        return SkillVersionDetailOut(
            **_version_out(version).model_dump(),
            files=[_file_out(entry) for entry in version.manifest],
        )

    async def version_file(
        self, skill_id: uuid.UUID, version_id: uuid.UUID, path: str
    ) -> SkillVersionFileOut:
        version = await self._require_version(skill_id, version_id)
        content = await self._store.version_file(version.id, path)
        if content is None:
            raise NotFound("文件不存在")
        entry = file_entry(path, content)
        return SkillVersionFileOut(path=path, size=entry.size, hash=entry.hash, content=content)

    async def restore(
        self, skill_id: uuid.UUID, version_id: uuid.UUID, *, by: uuid.UUID
    ) -> SkillDetailOut:
        """把一个版本的文件整份抄回草稿，替换草稿里的全部文件；不发布。"""

        version = await self._require_version(skill_id, version_id)
        files = await self._store.version_files(version.id)
        async with self._store.edit(skill_id) as writer:
            await writer.replace_draft(files, by=by)
        return await self.detail(skill_id)

    async def archive(self, skill_id: uuid.UUID) -> SkillDetailOut:
        """归档；已归档的原样不动。某个 agent 的草稿或当前版本还绑定着它是 ``Conflict``，列出那些 agent；
        只被旧版本用到的不拦。"""

        async with self._store.edit(skill_id) as writer:
            if writer.skill.status != STATUS_ARCHIVED:
                users = await self._usages.skill_users(skill_id)
                if users:
                    raise Conflict(in_use_message(f"技能 {writer.skill.name} ", users))
                await writer.update(status=STATUS_ARCHIVED)
        return await self.detail(skill_id)

    async def unarchive(self, skill_id: uuid.UUID) -> SkillDetailOut:
        """取消归档；在用的原样不动。"""

        return await self._set_status(skill_id, STATUS_ACTIVE)

    async def import_archive(self, data: bytes, *, dry_run: bool, by: uuid.UUID) -> SkillImportOut:
        """导入一个技能压缩包。``dry_run`` 只读不写：交回读出来的标识、显示名、描述、文件清单、全部问题，
        以及会新建技能还是覆盖同名技能的草稿。正式导入时有问题是 ``ValidationFailed``，否则新建一个只有
        草稿的技能，或整份替换同名技能的草稿（显示名不动），都不发布。"""

        parsed = read_archive(data)
        problems = list(parsed.problems)
        skill_md = parsed.files.get(SKILL_MD)
        name = description = display_name = None
        if skill_md is not None:
            problems += frontmatter_problems(skill_md, expected_name=None)
            name = frontmatter_name(skill_md)
            description = frontmatter_description(skill_md)
            if name is not None:
                display_name = default_display_name(skill_md, name)
        existing = await self._store.by_name(name) if name is not None else None
        result = SkillImportOut(
            action=None if name is None else ("overwrite" if existing is not None else "create"),
            skill_id=existing.id if existing is not None else None,
            name=name,
            display_name=display_name,
            description=description,
            files=[_file_out(entry) for entry in manifest(parsed.files)],
            problems=problems,
        )
        if dry_run:
            return result
        if problems or name is None or description is None or display_name is None:
            raise ValidationFailed(format_problems(problems) or "压缩包里的技能不完整")
        if existing is None:
            skill_id = uuid.uuid4()
            await self._store.create(
                skill_id,
                name=name,
                display_name=display_name,
                description=description,
                files=parsed.files,
                by=by,
            )
            return result.model_copy(update={"skill_id": skill_id})
        async with self._store.edit(existing.id) as writer:
            await writer.replace_draft(parsed.files, by=by)
            await _sync_unpublished_description(writer, parsed.files[SKILL_MD])
        return result

    async def export(self, skill_id: uuid.UUID, version_id: uuid.UUID | None) -> SkillArchive:
        """把一个版本（不给就是最新版）打成 zip，顶层目录是 ``<name>/``。没发布过、没有这个技能或版本
        是 ``NotFound``。"""

        skill = await self._require(skill_id)
        if version_id is None:
            if skill.latest_version_id is None:
                raise NotFound("还没有发布过版本")
            version_id = skill.latest_version_id
        version = await self._require_version(skill_id, version_id)
        files = await self._store.version_files(version.id)
        return SkillArchive(
            filename=f"{skill.name}-v{version.version}.zip",
            content=write_archive(skill.name, files),
        )

    async def _set_status(self, skill_id: uuid.UUID, status: SkillStatus) -> SkillDetailOut:
        async with self._store.edit(skill_id) as writer:
            if writer.skill.status != status:
                await writer.update(status=status)
        return await self.detail(skill_id)

    async def _require(self, skill_id: uuid.UUID) -> Skill:
        skill = await self._store.get(skill_id)
        if skill is None:
            raise NotFound("技能不存在")
        return skill

    async def _require_version(self, skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersion:
        await self._require(skill_id)
        version = await self._store.version(skill_id, version_id)
        if version is None:
            raise NotFound("版本不存在")
        return version


__all__ = ["SkillArchive", "SkillsService"]

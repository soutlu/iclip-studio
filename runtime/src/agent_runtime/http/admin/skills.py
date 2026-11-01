"""技能库管理接口，挂在 ``/v1/admin/skills``。术语见 docs/CONTEXT.md「技能库」。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Query, Response, UploadFile

from agent_runtime.config.skills.public import (
    MAX_ARCHIVE_BYTES,
    DraftFileOut,
    DraftFileRenameIn,
    DraftFileWriteIn,
    SkillCreateIn,
    SkillDetailOut,
    SkillImportOut,
    SkillPublishIn,
    SkillsOut,
    SkillsService,
    SkillUpdateIn,
    SkillVersionDetailOut,
    SkillVersionFileOut,
    SkillVersionOut,
    SkillVersionsOut,
)
from agent_runtime.http.auth import EndUser


def create_skills_router(service: SkillsService) -> APIRouter:
    router = APIRouter(prefix="/skills", tags=["skills"])

    @router.get("", response_model=SkillsOut)
    async def list_skills() -> SkillsOut:
        """全部技能，含已归档的，每个带有没有未发布的修改。"""

        return await service.list()

    @router.post("", response_model=SkillDetailOut, status_code=201)
    async def create_skill(body: SkillCreateIn, actor: EndUser) -> SkillDetailOut:
        """新建一个技能，草稿里生成一份带 frontmatter 的 ``SKILL.md``；标识已被占用是 409。"""

        return await service.create(body, by=actor)

    @router.post("/import", response_model=SkillImportOut)
    async def import_skill(
        file: Annotated[UploadFile, File(description="技能的 zip 压缩包")],
        actor: EndUser,
        dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    ) -> SkillImportOut:
        """导入一个技能压缩包：``dryRun=true`` 只检查不写；否则新建技能或覆盖同名技能的草稿，都不
        发布，有问题是 422。"""

        data = await file.read(MAX_ARCHIVE_BYTES + 1)
        return await service.import_archive(data, dry_run=dry_run, by=actor)

    @router.get("/{skill_id}", response_model=SkillDetailOut)
    async def skill_detail(skill_id: uuid.UUID) -> SkillDetailOut:
        """一个技能连同草稿的文件清单。"""

        return await service.detail(skill_id)

    @router.patch("/{skill_id}", response_model=SkillDetailOut)
    async def update_skill(
        skill_id: uuid.UUID, body: SkillUpdateIn, _actor: EndUser
    ) -> SkillDetailOut:
        """改显示名；标识不能改。"""

        return await service.rename(skill_id, body)

    # 合法的草稿路径只有 SKILL.md 与 references/ 下的，rename 不会与 {path} 撞名；照样登记在它前面。
    @router.post("/{skill_id}/draft/files/rename", response_model=DraftFileOut)
    async def rename_draft_file(
        skill_id: uuid.UUID, body: DraftFileRenameIn, actor: EndUser
    ) -> DraftFileOut:
        """把草稿里的一个文件改到新路径，内容不变；``baseHash`` 对不上或新路径已有文件是 409。"""

        return await service.move_file(skill_id, body, by=actor)

    @router.get("/{skill_id}/draft/files/{path:path}", response_model=DraftFileOut)
    async def read_draft_file(skill_id: uuid.UUID, path: str) -> DraftFileOut:
        """草稿里的一个文件，带内容与 ``hash``。"""

        return await service.read_file(skill_id, path)

    @router.put("/{skill_id}/draft/files/{path:path}", response_model=DraftFileOut)
    async def write_draft_file(
        skill_id: uuid.UUID, path: str, body: DraftFileWriteIn, actor: EndUser
    ) -> DraftFileOut:
        """写草稿里的一个文件：新建给 ``baseHash: null``，改给读到的 ``hash``，对不上是 409。"""

        return await service.write_file(skill_id, path, body, by=actor)

    @router.delete("/{skill_id}/draft/files/{path:path}", status_code=204)
    async def delete_draft_file(
        skill_id: uuid.UUID,
        path: str,
        base_hash: Annotated[str, Query(alias="baseHash")],
        _actor: EndUser,
    ) -> Response:
        """删草稿里的一个文件，``baseHash`` 与库里对不上是 409；``SKILL.md`` 不能删。"""

        await service.delete_file(skill_id, path, base_hash=base_hash)
        return Response(status_code=204)

    @router.post("/{skill_id}/versions", response_model=SkillVersionOut, status_code=201)
    async def publish_skill(
        skill_id: uuid.UUID, body: SkillPublishIn, actor: EndUser
    ) -> SkillVersionOut:
        """把草稿发布成新版本；草稿不合格或与最新版相同是 422。"""

        return await service.publish(skill_id, body, by=actor)

    @router.get("/{skill_id}/versions", response_model=SkillVersionsOut)
    async def skill_versions(skill_id: uuid.UUID) -> SkillVersionsOut:
        return await service.versions(skill_id)

    @router.get("/{skill_id}/versions/{version_id}", response_model=SkillVersionDetailOut)
    async def skill_version(skill_id: uuid.UUID, version_id: uuid.UUID) -> SkillVersionDetailOut:
        """一个版本连同它的文件清单。"""

        return await service.version(skill_id, version_id)

    @router.get(
        "/{skill_id}/versions/{version_id}/files/{path:path}",
        response_model=SkillVersionFileOut,
    )
    async def skill_version_file(
        skill_id: uuid.UUID, version_id: uuid.UUID, path: str
    ) -> SkillVersionFileOut:
        return await service.version_file(skill_id, version_id, path)

    @router.post("/{skill_id}/versions/{version_id}/restore", response_model=SkillDetailOut)
    async def restore_skill_version(
        skill_id: uuid.UUID, version_id: uuid.UUID, actor: EndUser
    ) -> SkillDetailOut:
        """把这个版本的文件整份抄回草稿，替换草稿里的全部文件；不发布。"""

        return await service.restore(skill_id, version_id, by=actor)

    @router.post("/{skill_id}/archive", response_model=SkillDetailOut)
    async def archive_skill(skill_id: uuid.UUID, _actor: EndUser) -> SkillDetailOut:
        return await service.archive(skill_id)

    @router.post("/{skill_id}/unarchive", response_model=SkillDetailOut)
    async def unarchive_skill(skill_id: uuid.UUID, _actor: EndUser) -> SkillDetailOut:
        return await service.unarchive(skill_id)

    @router.get(
        "/{skill_id}/export",
        response_class=Response,
        responses={200: {"content": {"application/zip": {}}, "description": "技能的 zip 压缩包"}},
    )
    async def export_skill(
        skill_id: uuid.UUID,
        version_id: Annotated[uuid.UUID | None, Query(alias="versionId")] = None,
    ) -> Response:
        """把一个版本（不给就是最新版）打成 zip，顶层目录是技能标识；没发布过是 404。"""

        archive = await service.export(skill_id, version_id)
        return Response(
            content=archive.content,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{archive.filename}"'},
        )

    return router


__all__ = ["create_skills_router"]

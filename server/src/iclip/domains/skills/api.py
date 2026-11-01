"""技能库 HTTP 端点，全部要求 ``agent:manage``。术语见 docs/CONTEXT.md「技能库」。

业务在运行时服务：每个端点验完权限与请求体，按同一个子路径转给它的 ``/v1/admin/skills``（见
``iclip.platform.runtime_admin``）。答复里带操作人 id 的端点补上操作人的显示名，其余原样交回。请求与答复的
声明照旧写在这里，合同由它们导出。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from agent_runtime.client import RuntimeClient
from agent_runtime.config.skills.models import MAX_ARCHIVE_BYTES
from agent_runtime.config.skills.schemas import (
    DraftFileOut,
    DraftFileRenameIn,
    DraftFileWriteIn,
    SkillCreateIn,
    SkillImportOut,
    SkillPublishIn,
    SkillUpdateIn,
    SkillVersionFileOut,
)
from fastapi import APIRouter, File, Query, Response, UploadFile
from pydantic import BaseModel

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.skills.schemas import (
    SkillDetailOut,
    SkillsOut,
    SkillVersionDetailOut,
    SkillVersionOut,
    SkillVersionsOut,
)
from iclip.platform.runtime_admin import UserNames, admin_path, relay, relay_named, upload_of

_MANAGE = "agent:manage"


def create_skills_router(runtime: RuntimeClient, user_names: UserNames) -> APIRouter:
    """``user_names`` 给答复里的操作人补显示名。"""

    router = APIRouter(prefix="/skills", tags=["skills"])

    async def named(
        out: type[BaseModel],
        method: str,
        path: str,
        principal: Principal,
        body: BaseModel | None = None,
    ) -> Response:
        return await relay_named(
            runtime, user_names, out, method, path, actor=principal.user_id, body=body
        )

    @router.get("", response_model=SkillsOut)
    async def list_skills(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """全部技能，含已归档的，每个带有没有未发布的修改。"""

        return await named(SkillsOut, "GET", "skills", principal)

    @router.post("", response_model=SkillDetailOut, status_code=201)
    async def create_skill(
        body: SkillCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """新建一个技能，草稿里生成一份带 frontmatter 的 ``SKILL.md``；标识已被占用是 409。"""

        return await named(SkillDetailOut, "POST", "skills", principal, body)

    @router.post("/import", response_model=SkillImportOut)
    async def import_skill(
        file: Annotated[UploadFile, File(description="技能的 zip 压缩包")],
        principal: Annotated[Principal, require_permission(_MANAGE)],
        dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    ) -> Response:
        """导入一个技能压缩包：``dryRun=true`` 只检查不写；否则新建技能或覆盖同名技能的草稿，都不
        发布，有问题是 422。"""

        return await relay(
            runtime,
            "POST",
            "skills/import",
            actor=principal.user_id,
            params={"dryRun": "true" if dry_run else "false"},
            files=await upload_of(file, limit=MAX_ARCHIVE_BYTES),
        )

    @router.get("/{skill_id}", response_model=SkillDetailOut)
    async def skill_detail(
        skill_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """一个技能连同草稿的文件清单。"""

        return await named(SkillDetailOut, "GET", admin_path("skills", str(skill_id)), principal)

    @router.patch("/{skill_id}", response_model=SkillDetailOut)
    async def update_skill(
        skill_id: uuid.UUID,
        body: SkillUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """改显示名；标识不能改。"""

        return await named(
            SkillDetailOut, "PATCH", admin_path("skills", str(skill_id)), principal, body
        )

    # 合法的草稿路径只有 SKILL.md 与 references/ 下的，rename 不会与 {path} 撞名；照样登记在它前面。
    @router.post("/{skill_id}/draft/files/rename", response_model=DraftFileOut)
    async def rename_draft_file(
        skill_id: uuid.UUID,
        body: DraftFileRenameIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把草稿里的一个文件改到新路径，内容不变，一次写完：``baseHash`` 对不上或新路径已有文件是 409，
        ``SKILL.md`` 不能改名、新路径不合格是 422。"""

        return await relay(
            runtime,
            "POST",
            admin_path("skills", str(skill_id), "draft/files/rename"),
            actor=principal.user_id,
            body=body,
        )

    @router.get("/{skill_id}/draft/files/{path:path}", response_model=DraftFileOut)
    async def read_draft_file(
        skill_id: uuid.UUID,
        path: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """草稿里的一个文件，带内容与 ``hash``。"""

        return await relay(
            runtime,
            "GET",
            admin_path("skills", str(skill_id), "draft/files", path),
            actor=principal.user_id,
        )

    @router.put("/{skill_id}/draft/files/{path:path}", response_model=DraftFileOut)
    async def write_draft_file(
        skill_id: uuid.UUID,
        path: str,
        body: DraftFileWriteIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """写草稿里的一个文件：新建给 ``baseHash: null``，改给读到的 ``hash``，对不上是 409。"""

        return await relay(
            runtime,
            "PUT",
            admin_path("skills", str(skill_id), "draft/files", path),
            actor=principal.user_id,
            body=body,
        )

    @router.delete("/{skill_id}/draft/files/{path:path}", status_code=204)
    async def delete_draft_file(
        skill_id: uuid.UUID,
        path: str,
        base_hash: Annotated[str, Query(alias="baseHash")],
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删草稿里的一个文件，``baseHash`` 与库里对不上是 409；``SKILL.md`` 不能删。"""

        return await relay(
            runtime,
            "DELETE",
            admin_path("skills", str(skill_id), "draft/files", path),
            actor=principal.user_id,
            params={"baseHash": base_hash},
        )

    @router.post("/{skill_id}/versions", response_model=SkillVersionOut, status_code=201)
    async def publish_skill(
        skill_id: uuid.UUID,
        body: SkillPublishIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把草稿发布成新版本；草稿不合格或与最新版相同是 422。"""

        return await named(
            SkillVersionOut,
            "POST",
            admin_path("skills", str(skill_id), "versions"),
            principal,
            body,
        )

    @router.get("/{skill_id}/versions", response_model=SkillVersionsOut)
    async def skill_versions(
        skill_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await named(
            SkillVersionsOut, "GET", admin_path("skills", str(skill_id), "versions"), principal
        )

    @router.get("/{skill_id}/versions/{version_id}", response_model=SkillVersionDetailOut)
    async def skill_version(
        skill_id: uuid.UUID,
        version_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """一个版本连同它的文件清单。"""

        return await named(
            SkillVersionDetailOut,
            "GET",
            admin_path("skills", str(skill_id), "versions", str(version_id)),
            principal,
        )

    @router.get(
        "/{skill_id}/versions/{version_id}/files/{path:path}",
        response_model=SkillVersionFileOut,
    )
    async def skill_version_file(
        skill_id: uuid.UUID,
        version_id: uuid.UUID,
        path: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await relay(
            runtime,
            "GET",
            admin_path("skills", str(skill_id), "versions", str(version_id), "files", path),
            actor=principal.user_id,
        )

    @router.post("/{skill_id}/versions/{version_id}/restore", response_model=SkillDetailOut)
    async def restore_skill_version(
        skill_id: uuid.UUID,
        version_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把这个版本的文件整份抄回草稿，替换草稿里的全部文件；不发布。"""

        return await named(
            SkillDetailOut,
            "POST",
            admin_path("skills", str(skill_id), "versions", str(version_id), "restore"),
            principal,
        )

    @router.post("/{skill_id}/archive", response_model=SkillDetailOut)
    async def archive_skill(
        skill_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await named(
            SkillDetailOut, "POST", admin_path("skills", str(skill_id), "archive"), principal
        )

    @router.post("/{skill_id}/unarchive", response_model=SkillDetailOut)
    async def unarchive_skill(
        skill_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await named(
            SkillDetailOut, "POST", admin_path("skills", str(skill_id), "unarchive"), principal
        )

    @router.get(
        "/{skill_id}/export",
        response_class=Response,
        responses={200: {"content": {"application/zip": {}}, "description": "技能的 zip 压缩包"}},
    )
    async def export_skill(
        skill_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
        version_id: Annotated[uuid.UUID | None, Query(alias="versionId")] = None,
    ) -> Response:
        """把一个版本（不给就是最新版）打成 zip，顶层目录是技能标识；没发布过是 404。"""

        return await relay(
            runtime,
            "GET",
            admin_path("skills", str(skill_id), "export"),
            actor=principal.user_id,
            params={} if version_id is None else {"versionId": str(version_id)},
        )

    return router


__all__ = ["create_skills_router"]

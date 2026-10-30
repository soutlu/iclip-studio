"""Agent 配置 HTTP 端点，全部要求 ``agent:manage``。约定见合同「Agent 配置」一节。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, Query, Response, UploadFile
from fastapi.responses import JSONResponse

from iclip.domains.agent_config.package import MAX_PACKAGE_BYTES
from iclip.domains.agent_config.schemas import (
    AgentCreateIn,
    AgentDetailOut,
    AgentDraftIn,
    AgentImportOut,
    AgentOrderIn,
    AgentPluginsOut,
    AgentProblemOut,
    AgentPublishIn,
    AgentPublishProblemsOut,
    AgentRestoreIn,
    AgentsOut,
    AgentUpdateIn,
    AgentVersionDetailOut,
    AgentVersionOut,
    AgentVersionsOut,
)
from iclip.domains.agent_config.service import AgentConfigService, AgentPublishBlocked
from iclip.domains.identity.public import Principal, require_permission

_MANAGE = "agent:manage"


def create_agent_config_router(service: AgentConfigService) -> APIRouter:
    router = APIRouter(prefix="/agents", tags=["agents"])

    @router.get("", response_model=AgentsOut)
    async def list_agents(
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentsOut:
        """全部 agent，含已归档的，每个带当前版本摘要与有没有未发布的修改。"""

        return await service.list()

    @router.post("", response_model=AgentDetailOut, status_code=201)
    async def create_agent(
        body: AgentCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """新建一个 agent，草稿是空配置；标识已被占用是 409。"""

        return await service.create(body, by=principal.user_id)

    @router.put("/order", response_model=AgentsOut)
    async def reorder_agents(
        body: AgentOrderIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentsOut:
        """按给的先后排；要给出全部 agent 的标识。"""

        return await service.reorder(body)

    # 要登记在 /{agent_id} 之前，不然 plugins 会被当成 agent 标识。
    @router.get("/plugins", response_model=AgentPluginsOut)
    async def list_agent_plugins(
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentPluginsOut:
        """本部署能挂的全部插件：插件名、名字、说明、要求一起启用的插件与参数的 JSON Schema。"""

        return service.plugins()

    @router.post("/import", response_model=AgentImportOut)
    async def import_agents(
        file: Annotated[UploadFile, File(description="agent 的导出包（YAML）")],
        principal: Annotated[Principal, require_permission(_MANAGE)],
        dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    ) -> AgentImportOut:
        """导入一个导出包：``dryRun=true`` 只检查不写；否则覆盖同标识 agent 的草稿、新建没有的，都不
        发布，有问题是 422。"""

        data = await file.read(MAX_PACKAGE_BYTES + 1)
        return await service.import_package(data, dry_run=dry_run, by=principal.user_id)

    @router.get("/{agent_id}", response_model=AgentDetailOut)
    async def agent_detail(
        agent_id: str,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """一个 agent 连同草稿、技能绑定、``lockVersion`` 与当前版本摘要。"""

        return await service.detail(agent_id)

    @router.patch("/{agent_id}", response_model=AgentDetailOut)
    async def update_agent(
        agent_id: str,
        body: AgentUpdateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """改名称、描述或上不上菜单；标识不能改。"""

        return await service.update(agent_id, body)

    @router.put("/{agent_id}/draft", response_model=AgentDetailOut)
    async def save_agent_draft(
        agent_id: str,
        body: AgentDraftIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """整份保存草稿；``lockVersion`` 对不上是 409。只查结构，不查引用。"""

        return await service.save_draft(agent_id, body, by=principal.user_id)

    @router.post(
        "/{agent_id}/versions",
        response_model=AgentVersionOut,
        status_code=201,
        responses={422: {"model": AgentPublishProblemsOut, "description": "发布被拦下"}},
    )
    async def publish_agent(
        agent_id: str,
        body: AgentPublishIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentVersionOut | JSONResponse:
        """把草稿发布成新版本。``lockVersion`` 对不上是 409；编译没通过是 422，带全部问题；与当前版本
        相同是 422「没有可发布的改动」，``problems`` 为空。"""

        try:
            return await service.publish(agent_id, body, by=principal.user_id)
        except AgentPublishBlocked as exc:
            return JSONResponse(
                status_code=422,
                content=AgentPublishProblemsOut(
                    detail=str(exc),
                    problems=[
                        AgentProblemOut(path=one.path, message=one.message) for one in exc.problems
                    ],
                ).model_dump(mode="json", by_alias=True),
            )

    @router.get("/{agent_id}/versions", response_model=AgentVersionsOut)
    async def agent_versions(
        agent_id: str,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentVersionsOut:
        return await service.versions(agent_id)

    @router.get("/{agent_id}/versions/{version_id}", response_model=AgentVersionDetailOut)
    async def agent_version(
        agent_id: str,
        version_id: uuid.UUID,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentVersionDetailOut:
        """一个版本连同它的配置与技能名单。"""

        return await service.version(agent_id, version_id)

    @router.post("/{agent_id}/versions/{version_id}/restore", response_model=AgentDetailOut)
    async def restore_agent_version(
        agent_id: str,
        version_id: uuid.UUID,
        body: AgentRestoreIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """把这个版本的配置与技能名单抄回草稿；不发布。``lockVersion`` 对不上是 409。"""

        return await service.restore(agent_id, version_id, body, by=principal.user_id)

    @router.post("/{agent_id}/archive", response_model=AgentDetailOut)
    async def archive_agent(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        """归档；别的 agent 的草稿或当前版本还把它当作子 agent 是 409。"""

        return await service.archive(agent_id, by=principal.user_id)

    @router.post("/{agent_id}/unarchive", response_model=AgentDetailOut)
    async def unarchive_agent(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> AgentDetailOut:
        return await service.unarchive(agent_id, by=principal.user_id)

    @router.get(
        "/{agent_id}/export",
        response_class=Response,
        responses={200: {"content": {"application/yaml": {}}, "description": "agent 的导出包"}},
    )
    async def export_agent(
        agent_id: str,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把它与它的子 agent 各自的当前版本写成导出包；没发布过是 404。"""

        exported = await service.export(agent_id)
        return Response(
            content=exported.content.encode("utf-8"),
            media_type="application/yaml",
            headers={"Content-Disposition": f'attachment; filename="{exported.filename}"'},
        )

    return router


__all__ = ["create_agent_config_router"]

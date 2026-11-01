"""Agent 配置 HTTP 端点，全部要求 ``agent:manage``。约定见合同「Agent 配置」一节。

业务在运行时服务：每个端点验完权限与请求体，按同一个子路径转给它的 ``/v1/admin/agents``（见
``iclip.platform.runtime_admin``）。答复里带操作人 id 的端点补上操作人的显示名，其余原样交回。请求与答复的
声明照旧写在这里，合同由它们导出。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from agent_runtime.client import RuntimeClient
from agent_runtime.config.agent_config.package import MAX_PACKAGE_BYTES
from agent_runtime.config.agent_config.schemas import (
    AgentCreateIn,
    AgentDraftIn,
    AgentImportOut,
    AgentOrderIn,
    AgentPluginsOut,
    AgentPublishIn,
    AgentPublishProblemsOut,
    AgentRestoreIn,
    AgentUpdateIn,
)
from agent_runtime.config.model_providers.schemas import ModelOptionsOut
from fastapi import APIRouter, File, Query, Response, UploadFile
from pydantic import BaseModel

from iclip.domains.agent_config.schemas import (
    AgentDetailOut,
    AgentsOut,
    AgentVersionDetailOut,
    AgentVersionOut,
    AgentVersionsOut,
)
from iclip.domains.identity.public import Principal, require_permission
from iclip.platform.runtime_admin import UserNames, admin_path, relay, relay_named, upload_of

_MANAGE = "agent:manage"


def create_agent_config_router(runtime: RuntimeClient, user_names: UserNames) -> APIRouter:
    """``user_names`` 给答复里的操作人补显示名。"""

    router = APIRouter(prefix="/agents", tags=["agents"])

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

    @router.get("", response_model=AgentsOut)
    async def list_agents(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """全部 agent，含已归档的，每个带当前版本摘要、有没有未发布的修改与子 agent 的两个标记。"""

        return await named(AgentsOut, "GET", "agents", principal)

    @router.post("", response_model=AgentDetailOut, status_code=201)
    async def create_agent(
        body: AgentCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """新建一个 agent，草稿是空配置；``listed`` 不给就不上首页菜单。标识已被占用是 409。"""

        return await named(AgentDetailOut, "POST", "agents", principal, body)

    @router.put("/order", response_model=AgentsOut)
    async def reorder_agents(
        body: AgentOrderIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """按给的先后排；要给出全部 agent 的标识。"""

        return await named(AgentsOut, "PUT", "agents/order", principal, body)

    # 要登记在 /{agent_id} 之前，不然 plugins、model-options 会被当成 agent 标识。
    @router.get("/plugins", response_model=AgentPluginsOut)
    async def list_agent_plugins(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """本部署能挂的全部插件：插件名、名字、说明、要求一起启用的插件与参数的 JSON Schema。"""

        return await relay(runtime, "GET", "agents/plugins", actor=principal.user_id)

    @router.get("/model-options", response_model=ModelOptionsOut)
    async def agent_model_options(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """agent 能选的模型：启用的供应商，各带启用的对话模型与打码的密钥。只读，不要 ``model:manage``。"""

        return await relay(runtime, "GET", "agents/model-options", actor=principal.user_id)

    @router.post("/import", response_model=AgentImportOut)
    async def import_agents(
        file: Annotated[UploadFile, File(description="agent 的导出包（YAML）")],
        principal: Annotated[Principal, require_permission(_MANAGE)],
        dry_run: Annotated[bool, Query(alias="dryRun")] = False,
    ) -> Response:
        """导入一个导出包：``dryRun=true`` 只检查不写；否则覆盖同标识 agent 的草稿、新建没有的，都不
        发布，有问题是 422。"""

        return await relay(
            runtime,
            "POST",
            "agents/import",
            actor=principal.user_id,
            params={"dryRun": "true" if dry_run else "false"},
            files=await upload_of(file, limit=MAX_PACKAGE_BYTES),
        )

    @router.get("/{agent_id}", response_model=AgentDetailOut)
    async def agent_detail(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """一个 agent 连同草稿、技能绑定、``lockVersion`` 与当前版本摘要。"""

        return await named(AgentDetailOut, "GET", admin_path("agents", agent_id), principal)

    @router.patch("/{agent_id}", response_model=AgentDetailOut)
    async def update_agent(
        agent_id: str,
        body: AgentUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """改名称、描述或上不上菜单；标识不能改。"""

        return await named(AgentDetailOut, "PATCH", admin_path("agents", agent_id), principal, body)

    @router.put("/{agent_id}/draft", response_model=AgentDetailOut)
    async def save_agent_draft(
        agent_id: str,
        body: AgentDraftIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """整份保存草稿；``lockVersion`` 对不上是 409。只查结构，不查引用。"""

        return await named(
            AgentDetailOut, "PUT", admin_path("agents", agent_id, "draft"), principal, body
        )

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
    ) -> Response:
        """把草稿发布成新版本。``lockVersion`` 对不上是 409；编译没通过是 422，带全部问题；与当前版本
        相同是 422「没有可发布的改动」，``problems`` 为空。"""

        return await named(
            AgentVersionOut, "POST", admin_path("agents", agent_id, "versions"), principal, body
        )

    @router.get("/{agent_id}/versions", response_model=AgentVersionsOut)
    async def agent_versions(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await named(
            AgentVersionsOut, "GET", admin_path("agents", agent_id, "versions"), principal
        )

    @router.get("/{agent_id}/versions/{version_id}", response_model=AgentVersionDetailOut)
    async def agent_version(
        agent_id: str,
        version_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """一个版本连同它的配置与技能名单。"""

        return await named(
            AgentVersionDetailOut,
            "GET",
            admin_path("agents", agent_id, "versions", str(version_id)),
            principal,
        )

    @router.post("/{agent_id}/versions/{version_id}/restore", response_model=AgentDetailOut)
    async def restore_agent_version(
        agent_id: str,
        version_id: uuid.UUID,
        body: AgentRestoreIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把这个版本的配置与技能名单抄回草稿；不发布。``lockVersion`` 对不上是 409。"""

        return await named(
            AgentDetailOut,
            "POST",
            admin_path("agents", agent_id, "versions", str(version_id), "restore"),
            principal,
            body,
        )

    @router.post("/{agent_id}/archive", response_model=AgentDetailOut)
    async def archive_agent(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """归档；别的 agent 的草稿或当前版本还把它当作子 agent 是 409。"""

        return await named(
            AgentDetailOut, "POST", admin_path("agents", agent_id, "archive"), principal
        )

    @router.post("/{agent_id}/unarchive", response_model=AgentDetailOut)
    async def unarchive_agent(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        return await named(
            AgentDetailOut, "POST", admin_path("agents", agent_id, "unarchive"), principal
        )

    @router.get(
        "/{agent_id}/export",
        response_class=Response,
        responses={200: {"content": {"application/yaml": {}}, "description": "agent 的导出包"}},
    )
    async def export_agent(
        agent_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把它与它的子 agent 各自的当前版本写成导出包；没发布过是 404。"""

        return await relay(
            runtime, "GET", admin_path("agents", agent_id, "export"), actor=principal.user_id
        )

    return router


__all__ = ["create_agent_config_router"]

"""给应用的 agent 名册与起标题：首页能选的顶层 agent，以及用默认对话模型给一段用户消息起标题。"""

from __future__ import annotations

from fastapi import APIRouter

from agent_runtime.app_wire import AgentDirectoryOut, AgentEntryOut, TitleIn, TitleOut
from agent_runtime.assembly.agents import AgentRuntime


def create_agents_router(runtime: AgentRuntime) -> APIRouter:
    router = APIRouter(tags=["agents"])

    @router.get("/agents", response_model=AgentDirectoryOut)
    async def directory() -> AgentDirectoryOut:
        found = await runtime.directory()
        return AgentDirectoryOut(
            items=tuple(AgentEntryOut(id=item.id, name=item.name) for item in found.items),
            default=found.default,
        )

    @router.post("/titles", response_model=TitleOut)
    async def generate_title(body: TitleIn) -> TitleOut:
        return TitleOut(title=await runtime.generate_title(body.text))

    return router


__all__ = ["create_agents_router"]

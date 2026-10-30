"""给应用的 agent 名册与起标题：首页能选的顶层 agent，以及用默认对话模型给一段用户消息起标题。"""

from __future__ import annotations

from fastapi import APIRouter

from agent_runtime.assembly.agents import AgentRuntime
from agent_runtime.transcript.wire import Envelope


class AgentEntryOut(Envelope):
    id: str
    name: str
    """给人看的名字。"""


class AgentDirectoryOut(Envelope):
    """上菜单、在用、发布过的 agent，按配置里的先后；``default`` 是第一个，名册空着为空。"""

    items: tuple[AgentEntryOut, ...]
    default: str | None


class TitleIn(Envelope):
    text: str
    """这一轮的用户消息。"""


class TitleOut(Envelope):
    title: str | None
    """没设默认对话模型、建不出模型或模型没给出标题时为空，应用照旧用默认名。"""


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


__all__ = [
    "AgentDirectoryOut",
    "AgentEntryOut",
    "TitleIn",
    "TitleOut",
    "create_agents_router",
]

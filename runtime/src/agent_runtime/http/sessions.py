"""会话接口：开会话、分叉、按清单拷文件，以及按会话读活动与正占着执行位的会话。

会话 id 等于应用那一侧的对话 id，路径上按 UUID 解析后规范成带横线的写法：工作区与素材台账的命名空间、
队列里的会话 id 都只认这一种拼写。``X-End-User`` 是新会话（分叉与拷文件的目标）的属主。

会话归开它的应用：带会话 id 的路由先认归属，不存在与归别的应用一样答 404；按会话读活动与此刻在跑的会话
只算调用方应用自己的会话。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from agent_runtime.harness.jobs import JobQueue
from agent_runtime.http.auth import CallingApp, SessionOwner
from agent_runtime.service.sessions import SessionService
from agent_runtime.transcript.wire import Envelope, LastTurnReason, PendingInteraction

MAX_AGENT_ID_CHARS = 128
"""agent 标识的长度上限，与后端建对话的请求体一致。"""

AgentIdField = Annotated[str, Field(min_length=1, max_length=MAX_AGENT_ID_CHARS)]


class SessionOpenIn(Envelope):
    """开一个会话：固定这个 agent 此刻的当前版本。"""

    id: uuid.UUID
    agent_id: AgentIdField


class SessionForkIn(Envelope):
    """从路径上的源会话第 ``turn`` 轮分叉出 ``target_id``；目标的属主是 ``X-End-User``。"""

    target_id: uuid.UUID
    source_user: uuid.UUID
    """源会话的属主。"""
    turn: Annotated[int, Field(ge=1)]
    """从第几轮分叉，从 1 数，这一轮包含在副本里。"""
    agent_id: AgentIdField | None = None
    """不给照抄源会话固定的版本；给了按开会话的规矩固定那个 agent 的当前版本。"""


class FilesCopyIn(Envelope):
    """按清单把源会话的几份文件拷进 ``target_id``，连同整份素材台账；目标的属主是 ``X-End-User``。"""

    target_id: uuid.UUID
    source_user: uuid.UUID
    """源会话的属主。"""
    files: tuple[tuple[str, str], ...]
    """（源路径，目标路径）；源里没有的跳过。"""
    require_any: tuple[str, ...] = ()
    """这些源路径一个都不在时什么都不写，答 ``copied: false``。"""


class FilesCopyOut(Envelope):
    copied: bool


class ActivitiesIn(Envelope):
    ids: tuple[uuid.UUID, ...]


class SessionActivityOut(Envelope):
    """一段会话此刻的活动：三项各自独立，等审批时 ``busy`` 仍为真。"""

    busy: bool
    pending_interaction: PendingInteraction
    last_turn_reason: LastTurnReason | None = None
    """最近完成那一轮的结局；还没有结局为空。"""


class ActivitiesOut(Envelope):
    items: dict[uuid.UUID, SessionActivityOut]
    """按会话 id；只有调用方应用自己的会话，不存在的与别的应用的都不在，没跑过的是空闲。"""


class BusyOut(Envelope):
    ids: tuple[uuid.UUID, ...]


def create_sessions_router(
    sessions: SessionService,
    queue: JobQueue,
    calling_app: Callable[..., Awaitable[CallingApp]],
) -> APIRouter:
    router = APIRouter(tags=["sessions"])
    caller = Depends(calling_app)

    @router.post("/sessions", status_code=204)
    async def open_session(body: SessionOpenIn, app: CallingApp = caller) -> None:
        """给调用方应用开会话。没有这个 agent 或它不上首页菜单是 422，已归档或还没发布过是 409；这个 id
        已有本应用的会话就按这次的版本改写，已归别的应用是 409。"""

        await sessions.open(body.id, app_id=app.id, agent_id=body.agent_id)

    @router.post("/sessions/{session_id}:fork", status_code=204)
    async def fork_session(
        session_id: uuid.UUID, body: SessionForkIn, end_user: SessionOwner, app: CallingApp = caller
    ) -> None:
        """从源会话分叉出调用方应用的新会话：固定版本、拷工作区文件与整份素材台账、写种子快照。

        源不是调用方应用的会话是 404，目标 id 已归别的应用是 409；源有没跑完或排着队的消息是 409，
        源没跑过、轮号越界是 422；数完轮数后源又跑了一轮是 409，那时会话、文件与素材已经写了。"""

        await sessions.fork(
            app_id=app.id,
            source_id=session_id,
            source_user=body.source_user,
            target_id=body.target_id,
            target_user=end_user,
            turn=body.turn,
            agent_id=body.agent_id,
        )

    @router.post("/sessions/{session_id}/files:copy", response_model=FilesCopyOut)
    async def copy_files(
        session_id: uuid.UUID, body: FilesCopyIn, end_user: SessionOwner, app: CallingApp = caller
    ) -> FilesCopyOut:
        """按清单拷文件与整份素材台账；``require_any`` 一个都不在时什么都不写。源与目标都要是调用方应用
        的会话（目标先开好），任一不是答 404。"""

        copied = await sessions.copy_files(
            app_id=app.id,
            source_id=session_id,
            source_user=body.source_user,
            target_id=body.target_id,
            target_user=end_user,
            files=body.files,
            require_any=frozenset(body.require_any),
        )
        return FilesCopyOut(copied=copied)

    @router.post("/sessions:activities", response_model=ActivitiesOut)
    async def activities(body: ActivitiesIn, app: CallingApp = caller) -> ActivitiesOut:
        """这几段会话此刻的活动，按持久化队列算；只答调用方应用自己的会话。"""

        owned = await sessions.owned(body.ids, app_id=app.id)
        asked = [one for one in body.ids if one in owned]
        states = await queue.activities([str(one) for one in asked])
        return ActivitiesOut(
            items={
                one: SessionActivityOut(
                    busy=state.busy,
                    pending_interaction=state.pending_interaction,
                    last_turn_reason=state.last_turn_reason,
                )
                for one, state in ((one, states[str(one)]) for one in asked)
            }
        )

    @router.get("/sessions:busy", response_model=BusyOut)
    async def busy(
        end_user: Annotated[
            uuid.UUID | None, Query(description="只算这个属主的会话；不给算全部。")
        ] = None,
        app: CallingApp = caller,
    ) -> BusyOut:
        """调用方应用的会话里，此刻占着执行位（在跑或等审批）的那些。"""

        found = await queue.busy_conversation_ids(end_user)
        owned = await sessions.owned([uuid.UUID(one) for one in found], app_id=app.id)
        return BusyOut(ids=tuple(sorted(owned)))

    return router


__all__ = [
    "MAX_AGENT_ID_CHARS",
    "ActivitiesIn",
    "ActivitiesOut",
    "AgentIdField",
    "BusyOut",
    "FilesCopyIn",
    "FilesCopyOut",
    "SessionActivityOut",
    "SessionForkIn",
    "SessionOpenIn",
    "create_sessions_router",
]

"""会话的消息与 transcript 接口：发消息、停、插队、重新生成、审批，读队列、运行状态、一页 transcript 与补批。

请求与答复照用 transcript 的信封（``agent_runtime.transcript.wire``），状态码与报错同后端的同名端点。
应用先在自己那一侧判完谁看得见、谁能写，再转发到这里；这里不认识应用的对话表。每个路由在请求形状校验之后
先认会话归属：不是调用方应用的会话（含不存在）答 404。
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from agent_runtime.app_wire import MAX_AGENT_ID_CHARS, SessionPromptIn
from agent_runtime.harness.transcript.service import (
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    TranscriptService,
)
from agent_runtime.http.auth import CallingApp, SessionOwner
from agent_runtime.service.sessions import SessionService
from agent_runtime.transcript.ops import MAIN_AGENT_ID, Prompt
from agent_runtime.transcript.wire import (
    ApprovalRequest,
    OpsCatchup,
    PromptQueueOut,
    RegenerateBody,
    RunStatusOut,
    SteerRequest,
    TranscriptPage,
)

_PROTOCOL_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
"""协议里由客户端铸的标识（消息 id、交互 id、轮 id）与 agent id 的形状：主 agent 是 main，子代理是它的
run id。"""

ProtocolId = Annotated[str, Path(pattern=_PROTOCOL_ID.pattern)]

StreamAgent = Annotated[
    str,
    Query(
        alias="agent",
        pattern=_PROTOCOL_ID.pattern,
        description="读哪条流：main 是主 agent，子代理给它的 id。",
    ),
]


def create_transcript_router(
    transcripts: TranscriptService,
    sessions: SessionService,
    calling_app: Callable[..., Awaitable[CallingApp]],
) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}", tags=["transcript"])
    caller = Depends(calling_app)
    # :abort 紧跟会话 id，挂不到带尾部斜杠的前缀下。
    outer = APIRouter(tags=["transcript"])

    @router.post("/prompts", response_model=Prompt)
    async def submit(
        session_id: uuid.UUID, body: SessionPromptIn, owner: SessionOwner, app: CallingApp = caller
    ) -> Prompt:
        """发一条消息。``prompt_id`` 由客户端铸，重发同一个不会多起一次运行。

        受理前先装一次这段会话固定的 agent 版本，装不起来是 409（``agent_unavailable``），什么都不写；
        带地址的图片与视频附件在入队前登记进会话的素材台账。"""

        await sessions.require_owned(session_id, app_id=app.id)
        return await transcripts.submit(
            prompt_id=body.prompt_id,
            conversation_id=str(session_id),
            agent_id=body.agent_id,
            owner_user_id=owner,
            user_name=body.user_name,
            content=body.content,
        )

    @router.get("/prompts", response_model=PromptQueueOut)
    async def queue_view(session_id: uuid.UUID, app: CallingApp = caller) -> PromptQueueOut:
        await sessions.require_owned(session_id, app_id=app.id)
        return await transcripts.queue_view(str(session_id))

    @router.get("/status", response_model=RunStatusOut)
    async def run_status(session_id: uuid.UUID, app: CallingApp = caller) -> RunStatusOut:
        """这段会话跑没跑完、有没有出错；排队中的算在跑。"""

        await sessions.require_owned(session_id, app_id=app.id)
        return await transcripts.run_status(str(session_id))

    @router.post("/prompts/{prompt_id}:abort", status_code=204)
    async def abort(session_id: uuid.UUID, prompt_id: ProtocolId, app: CallingApp = caller) -> None:
        """停掉一条消息。排队的直接撤，在跑的发第一方取消让它自己收尾。"""

        await sessions.require_owned(session_id, app_id=app.id)
        await transcripts.abort(str(session_id), prompt_id)

    @router.post("/turns/{turn_id}:regenerate", response_model=Prompt)
    async def regenerate(
        session_id: uuid.UUID,
        turn_id: ProtocolId,
        body: RegenerateBody | None = None,
        app: CallingApp = caller,
    ) -> Prompt:
        """重新生成最后一轮，答复是重跑那条的记录。轮 id 不合形状 422，会话在忙或不是末轮 409，
        末轮是分叉带过来的 404。"""

        await sessions.require_owned(session_id, app_id=app.id)
        return await transcripts.regenerate(
            conversation_id=str(session_id),
            turn_id=turn_id,
            prompt_id=None if body is None else body.prompt_id,
            content=None if body is None else body.content,
        )

    @outer.post("/sessions/{session_id}:abort", status_code=204)
    async def abort_session(session_id: uuid.UUID, app: CallingApp = caller) -> None:
        """停掉整段会话：排着的全撤，在跑的发第一方取消；什么都没有也是 204。"""

        await sessions.require_owned(session_id, app_id=app.id)
        await transcripts.abort_conversation(str(session_id))

    @router.post("/prompts:steer", status_code=204)
    async def steer(session_id: uuid.UUID, body: SteerRequest, app: CallingApp = caller) -> None:
        """把排队中的几条插进正在跑的那一轮。"""

        await sessions.require_owned(session_id, app_id=app.id)
        await transcripts.steer(str(session_id), body.prompt_ids)

    @router.post("/interactions/{interaction_id}", status_code=204)
    async def approve(
        session_id: uuid.UUID,
        interaction_id: ProtocolId,
        body: ApprovalRequest,
        app: CallingApp = caller,
    ) -> None:
        """对一张审批卡点同意或拒绝。重复同一个决定 204，改主意 409，卡不在等回应的那几张里 404。"""

        await sessions.require_owned(session_id, app_id=app.id)
        await transcripts.approve(str(session_id), interaction_id, approved=body.approved)

    @router.get("/transcript", response_model=TranscriptPage)
    async def page(
        session_id: uuid.UUID,
        session_agent: Annotated[
            str,
            Query(
                min_length=1,
                max_length=MAX_AGENT_ID_CHARS,
                description="这段会话的 agent id，读用量仪表要按它装出的模型算窗口。",
            ),
        ],
        agent: StreamAgent = MAIN_AGENT_ID,
        before_turn: Annotated[str | None, Query()] = None,
        after_turn: Annotated[str | None, Query()] = None,
        page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
        app: CallingApp = caller,
    ) -> TranscriptPage:
        """一页轮子。不给位置就是最新那几轮，往上翻给 ``before_turn``；子代理的 id 不属于这段会话是 404。"""

        await sessions.require_owned(session_id, app_id=app.id)
        conversation_id = str(session_id)
        await transcripts.verify_agent(conversation_id, agent)
        return await transcripts.page(
            conversation_id,
            agent_id=agent,
            runtime_agent_id=session_agent,
            before_turn=before_turn,
            after_turn=after_turn,
            page_size=page_size,
        )

    @router.get("/transcript/ops", response_model=OpsCatchup)
    async def catchup(
        session_id: uuid.UUID,
        since_seq: Annotated[int, Query(ge=0)],
        agent: StreamAgent = MAIN_AGENT_ID,
        stream_epoch: Annotated[str | None, Query(max_length=64)] = None,
        app: CallingApp = caller,
    ) -> OpsCatchup:
        """补上 ``since_seq`` 之后的批次。``complete`` 为假（出了日志窗口，或 ``stream_epoch`` 对不上
        当前实时流）就整页重拉。"""

        await sessions.require_owned(session_id, app_id=app.id)
        conversation_id = str(session_id)
        await transcripts.verify_agent(conversation_id, agent)
        return transcripts.catchup(
            conversation_id, agent_id=agent, since=since_seq, epoch=stream_epoch
        )

    combined = APIRouter()
    combined.include_router(router)
    combined.include_router(outer)
    return combined


__all__ = ["create_transcript_router"]

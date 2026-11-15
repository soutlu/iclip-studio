from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal, Protocol

import structlog
from fastapi import APIRouter, Depends, Path, Query, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState
from pydantic import TypeAdapter, ValidationError

from iclip.common.errors import DomainError
from iclip.common.generation_vocab import GenerationKind, GenerationOperation, GenerationStatus
from iclip.domains.identity.public import (
    MANAGE_PERMISSION,
    ActAs,
    Principal,
    origin_allowed,
    require_permission,
    resolve_user_name,
    websocket_principal,
)
from iclip.platform.live.frames import (
    ClientFrame,
    GenerationChanged,
    GenerationChangedPayload,
    ServerHello,
    ServerHelloPayload,
    SessionCreated,
    SessionDeleted,
    SessionMetaPayload,
    SessionMetaUpdated,
    SessionUpdated,
)
from iclip.platform.runtime_api.app_wire import SessionPromptIn
from iclip.platform.runtime_api.client import (
    RawFrame,
    RuntimeClient,
    RuntimeUnavailable,
    TranscriptChannel,
    WorkChangedFrame,
)
from iclip.platform.runtime_api.live.frames import (
    Ack,
    Ping,
    PingPayload,
    SubscribeAckPayload,
    timestamp_now,
)
from iclip.platform.runtime_api.transcript.ops import MAIN_AGENT_ID, Prompt, PromptContent
from iclip.platform.runtime_api.transcript.wire import (
    ApprovalRequest,
    OpsCatchup,
    PromptQueueOut,
    PromptSubmission,
    RegenerateBody,
    RunStatusOut,
    SteerRequest,
    Subscribe,
    Unsubscribe,
)
from iclip.platform.runtime_api.transcript.wire import TranscriptPage as SessionTranscriptPage

_logger = structlog.stdlib.get_logger(__name__)

HEARTBEAT_SECONDS = 10.0

HEARTBEAT_MISS_LIMIT = 2

MAX_EVENT_BUFFER = 2048

GOING_AWAY: Final = 1001

_CLIENT_FRAME = TypeAdapter[Any](ClientFrame)


class TranscriptPage(SessionTranscriptPage):
    """``GET /transcript`` 的一页。

    ``agents`` 与 ``pending_interactions`` 是协议要求的字段：前者是主 agent 加各子代理，后者从
    待回应的交互里取。
    """

    title: str = ""
    owner_user_id: str | None = None
    deleted_at: str | None = None
    forked_from: str | None = None
    fork_turn: int | None = None


class ImportAttachments(Protocol):
    async def __call__(
        self,
        principal: Principal,
        *,
        conversation_id: str,
        prompt_id: str | None,
        content: tuple[PromptContent, ...],
    ) -> tuple[PromptContent, ...]: ...


class ConversationHeader(Protocol):
    @property
    def agent_id(self) -> str: ...

    @property
    def title(self) -> str: ...

    @property
    def owner_user_id(self) -> uuid.UUID: ...

    @property
    def deleted_at(self) -> datetime | None: ...

    @property
    def forked_from(self) -> uuid.UUID | None: ...

    @property
    def fork_turn(self) -> int | None: ...


class Conversations(Protocol):
    async def agent_of(
        self, principal: Principal, conversation_id: str, *, writing: bool
    ) -> str: ...

    async def header_of(self, principal: Principal, conversation_id: str) -> ConversationHeader: ...


ProtocolId = Annotated[str, Path(pattern=r"^[A-Za-z0-9._-]{1,128}$")]


def _canonical_conversation_id(conversation_id: uuid.UUID) -> str:
    return str(conversation_id)


ConversationId = Annotated[str, Depends(_canonical_conversation_id)]


def _canonical_session_id(session_id: str) -> str | None:
    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return None


AgentId = Annotated[str, Query(pattern=r"^[A-Za-z0-9._-]{1,128}$")]


class LiveConnections:
    def __init__(self) -> None:
        self._connections: set[_Connection] = set()

    def add(self, connection: _Connection) -> None:
        self._connections.add(connection)

    def discard(self, connection: _Connection) -> None:
        self._connections.discard(connection)

    def close_all(self, code: int) -> None:
        for connection in tuple(self._connections):
            connection.drop(code)

    def announce_title(self, owner: uuid.UUID, conversation_id: uuid.UUID, title: str) -> None:
        self._announce(
            owner,
            SessionMetaUpdated(
                session_id=str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
                payload=SessionMetaPayload(title=title),
            ),
        )

    def announce_activity(self, frame: WorkChangedFrame) -> None:
        if frame.event.preview:
            return
        self._announce(
            uuid.UUID(frame.event.owner_user_id), RawFrame(type=frame.event.type, text=frame.text)
        )

    def announce_generation_changed(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID | None,
        *,
        job_id: uuid.UUID,
        kind: GenerationKind,
        operation: GenerationOperation,
        status: GenerationStatus,
        shot_index: int | None,
        metadata: Mapping[str, Any] | None,
    ) -> None:
        self._announce(
            owner,
            GenerationChanged(
                session_id=None if conversation_id is None else str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
                payload=GenerationChangedPayload(
                    id=str(job_id),
                    kind=kind,
                    operation=operation,
                    status=status,
                    shot_index=shot_index,
                    metadata=None if metadata is None else dict(metadata),
                ),
            ),
        )

    def announce_session_row(
        self,
        kind: Literal["created", "updated"],
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        row: Mapping[str, Any],
    ) -> None:
        frame_type = SessionCreated if kind == "created" else SessionUpdated
        self._announce(
            owner,
            frame_type(
                session_id=str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
                payload=dict(row),
            ),
        )

    def announce_session_deleted(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        self._announce(
            owner,
            SessionDeleted(
                session_id=str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
            ),
        )

    def _announce(self, owner: uuid.UUID, frame: Any) -> None:
        for connection in tuple(self._connections):
            if connection.receives(owner):
                connection.offer(frame)


def create_transcript_router(
    runtime: RuntimeClient,
    conversations: Conversations,
    *,
    act_as: ActAs,
    allowed_origins: tuple[str, ...],
    live: LiveConnections,
    import_attachments: ImportAttachments | None = None,
) -> APIRouter:
    outer = APIRouter(tags=["transcript"])
    router = APIRouter(prefix="/conversations/{conversation_id}", tags=["transcript"])

    async def _writable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=True)

    async def _readable(principal: Principal, conversation_id: str) -> str:
        return await conversations.agent_of(principal, conversation_id, writing=False)

    async def _imported(
        principal: Principal,
        conversation_id: str,
        prompt_id: str | None,
        content: tuple[PromptContent, ...],
    ) -> tuple[PromptContent, ...]:
        if import_attachments is None:
            return content
        return await import_attachments(
            principal, conversation_id=conversation_id, prompt_id=prompt_id, content=content
        )

    @router.post("/prompts", response_model=Prompt)
    async def submit(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: PromptSubmission,
    ) -> Prompt:
        """发一条消息。``prompt_id`` 由客户端铸，重发同一个不会多起一次运行。

        ``user_name`` 是这条消息替谁发的：API key 调用方必须给，浏览器会话默认是登录用户名。

        图片附件的地址挂不上 OSS 处理参数时，受理前先转存进本桶、记成发消息那个人的一条上传，
        消息里存新地址；转存失败是 422，说明第几张附件。
        """

        user_name = resolve_user_name(principal, body.user_name)
        principal = await act_as(principal, user_name)
        agent_id = await _writable(principal, conversation_id)
        content = await _imported(principal, conversation_id, body.prompt_id, body.content)
        return await runtime.submit_prompt(
            uuid.UUID(conversation_id),
            SessionPromptIn(
                prompt_id=body.prompt_id, content=content, user_name=user_name, agent_id=agent_id
            ),
            owner=principal.user_id,
        )

    @router.get("/prompts", response_model=PromptQueueOut)
    async def queue_view(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> PromptQueueOut:
        await _readable(principal, conversation_id)
        return await runtime.prompt_queue(uuid.UUID(conversation_id))

    @router.get("/status", response_model=RunStatusOut)
    async def run_status(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:read")],
    ) -> RunStatusOut:
        """这段对话跑没跑完、有没有出错。只读，凭 API key 可单独轮询。"""

        await _readable(principal, conversation_id)
        return await runtime.run_status(uuid.UUID(conversation_id))

    @router.post("/prompts/{prompt_id}:abort", status_code=204)
    async def abort(
        conversation_id: ConversationId,
        prompt_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> None:
        """停掉一条消息。排队的直接撤，在跑的发第一方取消让它自己收尾。"""

        await _writable(principal, conversation_id)
        await runtime.abort_prompt(uuid.UUID(conversation_id), prompt_id)

    @router.post("/turns/{turn_id}:regenerate", response_model=Prompt)
    async def regenerate(
        conversation_id: ConversationId,
        turn_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: RegenerateBody | None = None,
    ) -> Prompt:
        """重新生成最后一轮：把它从历史里抹掉重跑一次，答复是重跑那条的记录。

        ``turn_id`` 是协议里的轮 id（``t{N}``），客户端从轮头部直接拿得到。请求体可以不带：
        带 ``content`` 就换成新内容重跑，带 ``prompt_id`` 就与发消息同一套幂等；新内容里的图片附件
        与发消息一样先转存。
        """

        await _writable(principal, conversation_id)
        if body is not None and body.content is not None:
            content = await _imported(principal, conversation_id, body.prompt_id, body.content)
            body = body.model_copy(update={"content": content})
        return await runtime.regenerate(uuid.UUID(conversation_id), turn_id, body)

    @outer.post("/conversations/{conversation_id}:abort", status_code=204)
    async def abort_conversation(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
    ) -> None:
        """停掉整段对话：排着的全撤，在跑的发第一方取消。

        没有在跑的、也没有排着的照样是 204：「停止」是用户按一次的动作，不该因为刚好停在
        什么都没有的那一刻而报错。
        """

        await _writable(principal, conversation_id)
        await runtime.abort_session(uuid.UUID(conversation_id))

    @router.post("/prompts:steer", status_code=204)
    async def steer(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: SteerRequest,
    ) -> None:
        """把排队中的几条插进正在跑的那一轮，不必等它跑完。"""

        await _writable(principal, conversation_id)
        await runtime.steer(uuid.UUID(conversation_id), body)

    @router.post("/interactions/{interaction_id}", status_code=204)
    async def approve(
        conversation_id: ConversationId,
        interaction_id: ProtocolId,
        principal: Annotated[Principal, require_permission("agent:run")],
        body: ApprovalRequest,
    ) -> None:
        """对一张审批卡点同意或拒绝。

        决定记下就返回 204：那次运行已经以「等审批」结束了，凑齐这一批之后服务端自己起续跑。
        重复点同一个决定照样 204；改主意是 409；卡不在等回应的那几张里是 404。
        """

        await _writable(principal, conversation_id)
        await runtime.approve(uuid.UUID(conversation_id), interaction_id, body)

    @router.get("/transcript", response_model=TranscriptPage)
    async def page(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        agent_id: AgentId = MAIN_AGENT_ID,
        before_turn: Annotated[str | None, Query()] = None,
        after_turn: Annotated[str | None, Query()] = None,
        page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> TranscriptPage:
        """一页轮子。不给位置就是最新那几轮，往上翻给 ``before_turn``。

        ``agent_id`` 默认主 agent；给子代理的 id 就读它那条流，不属于这段对话的 id 是 404。
        标题在这里贴上：引擎那一侧不认识对话表，而首屏得有个名字显示（之后的改名走
        ``session.meta.updated`` 推送，不再问这里）。
        """

        header = await conversations.header_of(principal, conversation_id)
        page = await runtime.transcript_page(
            uuid.UUID(conversation_id),
            session_agent=header.agent_id,
            agent=agent_id,
            before_turn=before_turn,
            after_turn=after_turn,
            page_size=page_size,
        )
        return TranscriptPage(
            **dict(page),
            title=header.title,
            owner_user_id=str(header.owner_user_id),
            deleted_at=None if header.deleted_at is None else header.deleted_at.isoformat(),
            forked_from=None if header.forked_from is None else str(header.forked_from),
            fork_turn=header.fork_turn,
        )

    @router.get("/transcript/ops", response_model=OpsCatchup)
    async def catchup(
        conversation_id: ConversationId,
        principal: Annotated[Principal, require_permission("agent:run")],
        since_seq: Annotated[int, Query(ge=0)],
        agent_id: AgentId = MAIN_AGENT_ID,
        stream_epoch: Annotated[str | None, Query(max_length=64)] = None,
    ) -> OpsCatchup:
        """补上断线期间漏掉的批次。``complete`` 为假就整页重拉。

        给机器调用方用，浏览器不走这里。``stream_epoch`` 是手上水位所属的实时流，给了且对不上也是
        ``complete`` 为假；不给只按序号判，分不出服务重启后重新编号的批次。"""

        await _readable(principal, conversation_id)
        return await runtime.transcript_ops(
            uuid.UUID(conversation_id),
            since_seq=since_seq,
            agent=agent_id,
            stream_epoch=stream_epoch,
        )

    @outer.websocket("/ws")
    async def subscribe(websocket: WebSocket) -> None:
        if not origin_allowed(websocket.headers, allowed_origins):
            _logger.info(
                "订阅连接被拒：Origin 不同源",
                origin=websocket.headers.get("origin"),
                host=websocket.headers.get("host"),
            )
            await websocket.close(code=1008)
            return
        principal = websocket_principal(websocket)
        if principal is None:
            _logger.info(
                "订阅连接被拒：没有身份",
                has_cookie="cookie" in websocket.headers,
                has_authorization="authorization" in websocket.headers,
            )
            await websocket.close(code=1008)
            return
        if not principal.has("agent:run"):
            _logger.info("订阅连接被拒：没有 agent:run", user_id=principal.user_id)
            await websocket.close(code=1008)
            return
        await _serve(websocket, runtime, conversations, principal, live)

    outer.include_router(router)
    return outer


class _Drop:
    def __init__(self, code: int) -> None:
        self.code = code


class _Connection:
    def __init__(
        self,
        websocket: WebSocket,
        runtime: RuntimeClient,
        conversations: Conversations,
        principal: Principal,
    ):
        self._ws = websocket
        self._runtime = runtime
        self._conversations = conversations
        self._principal = principal
        self._outbound: asyncio.Queue[Any] = asyncio.Queue(maxsize=MAX_EVENT_BUFFER)
        self._overflowed = False
        self._last_inbound = datetime.now(UTC)

    async def serve(self) -> None:
        await self._ws.accept()
        try:
            async with self._runtime.connect_transcript() as upstream:
                await self._serve_with(upstream)
        except RuntimeUnavailable as exc:
            _logger.warning("对话内容流连不上运行时，关掉这条订阅连接", reason=str(exc))
            with contextlib.suppress(RuntimeError):
                await self._ws.close(code=GOING_AWAY)

    async def _serve_with(self, upstream: TranscriptChannel) -> None:
        await self._send(
            ServerHello(
                timestamp=timestamp_now(),
                payload=ServerHelloPayload(
                    ws_connection_id=uuid.uuid4().hex,
                    heartbeat_ms=int(HEARTBEAT_SECONDS * 1000),
                ),
            )
        )
        helpers = (
            asyncio.create_task(self._pump()),
            asyncio.create_task(self._heartbeat()),
            asyncio.create_task(self._relay(upstream)),
        )
        try:
            await self._read(upstream)
        except (WebSocketDisconnect, ConnectionError):
            _logger.debug("订阅连接断开")
        finally:
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)

    async def _read(self, upstream: TranscriptChannel) -> None:
        while True:
            raw = await self._receive()
            self._last_inbound = datetime.now(UTC)
            try:
                frame = _CLIENT_FRAME.validate_json(raw)
            except ValidationError:
                continue
            try:
                await self._handle(frame, upstream)
            except RuntimeUnavailable as exc:
                _logger.warning("订阅转不到运行时，关掉这条订阅连接", reason=str(exc))
                self.drop(GOING_AWAY)

    async def _handle(self, frame: Any, upstream: TranscriptChannel) -> None:
        if isinstance(frame, Subscribe):
            await self._subscribe(frame, upstream)
        elif isinstance(frame, Unsubscribe):
            raw = frame.payload.session_id
            payload = frame.payload.model_copy(
                update={"session_id": _canonical_session_id(raw) or raw}
            )
            await upstream.unsubscribe(frame.model_copy(update={"payload": payload}))

    async def _visible(self, session_id: str) -> str | None:
        conversation_id = _canonical_session_id(session_id)
        if conversation_id is None:
            return None
        try:
            await self._conversations.agent_of(self._principal, conversation_id, writing=False)
        except DomainError:
            return None
        return conversation_id

    async def _subscribe(self, frame: Subscribe, upstream: TranscriptChannel) -> None:
        conversation_id = await self._visible(frame.payload.session_id)
        if conversation_id is None:
            self.offer(
                Ack(
                    id=frame.id,
                    payload=SubscribeAckPayload(not_found=(frame.payload.session_id,)),
                )
            )
            return
        payload = frame.payload.model_copy(update={"session_id": conversation_id})
        await upstream.subscribe(frame.model_copy(update={"payload": payload}))

    async def _relay(self, upstream: TranscriptChannel) -> None:
        try:
            while True:
                self.offer(await upstream.receive())
        except RuntimeUnavailable as exc:
            _logger.warning("运行时的对话内容流断了，关掉这条订阅连接", reason=str(exc))
            self.drop(GOING_AWAY)

    def receives(self, owner: uuid.UUID) -> bool:
        return self._principal.user_id == owner or self._principal.has(MANAGE_PERMISSION)

    def offer(self, frame: Any) -> None:
        try:
            self._outbound.put_nowait(frame)
        except asyncio.QueueFull:
            self._overflowed = True

    def drop(self, code: int) -> None:
        self.offer(_Drop(code))

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
                await self._ws.close(code=1013)
                return
            if isinstance(frame, _Drop):
                await self._ws.close(code=frame.code)
                return
            await self._send(frame)

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            idle = (datetime.now(UTC) - self._last_inbound).total_seconds()
            if idle >= HEARTBEAT_SECONDS * HEARTBEAT_MISS_LIMIT:
                await self._ws.close(code=1001)
                return
            with contextlib.suppress(asyncio.QueueFull):
                self._outbound.put_nowait(
                    Ping(timestamp=timestamp_now(), payload=PingPayload(nonce=uuid.uuid4().hex[:8]))
                )

    async def _send(self, frame: Any) -> None:
        text = (
            frame.text
            if isinstance(frame, RawFrame)
            else frame.model_dump_json(exclude_none=True, by_alias=True)
        )
        try:
            await self._ws.send_text(text)
        except RuntimeError as exc:
            raise WebSocketDisconnect(code=1006) from exc

    async def _receive(self) -> str:
        if self._ws.application_state == WebSocketState.DISCONNECTED:
            raise WebSocketDisconnect(code=1006)
        return await self._ws.receive_text()


async def _serve(
    websocket: WebSocket,
    runtime: RuntimeClient,
    conversations: Conversations,
    principal: Principal,
    live: LiveConnections,
) -> None:
    connection = _Connection(websocket, runtime, conversations, principal)
    live.add(connection)
    try:
        await connection.serve()
    finally:
        live.discard(connection)


__all__ = [
    "GOING_AWAY",
    "HEARTBEAT_MISS_LIMIT",
    "HEARTBEAT_SECONDS",
    "MAX_EVENT_BUFFER",
    "ConversationHeader",
    "Conversations",
    "ImportAttachments",
    "LiveConnections",
    "TranscriptPage",
    "create_transcript_router",
]

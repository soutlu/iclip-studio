"""Transcript REST 端点与多对话 WebSocket：逐对话校验权限，transcript 本身经运行时服务的客户端读写与订阅。

REST 端点判完谁看得见、谁能写，再转给运行时服务的会话接口，会话的属主放进 ``X-End-User``。WebSocket 是一条
转发：每条浏览器连接对应一条运行时的对话内容流，订阅在这里核可见性后才转过去，运行时发来的帧不解析、原文
发给浏览器；全局帧在本进程里。

WebSocket 握手不受 CORS 约束且会携带 cookie，必须独立校验 Origin，防止跨站劫持。"""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal, Protocol

import structlog
from agent_runtime.app_wire import SessionPromptIn
from agent_runtime.client import RawFrame, RuntimeClient, RuntimeUnavailable, TranscriptChannel
from agent_runtime.errors import DomainError
from agent_runtime.live.frames import (
    Ack,
    Ping,
    PingPayload,
    SessionWorkChanged,
    SubscribeAckPayload,
    timestamp_now,
)
from agent_runtime.transcript.ops import MAIN_AGENT_ID, Prompt, PromptContent
from agent_runtime.transcript.wire import (
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
from agent_runtime.transcript.wire import TranscriptPage as SessionTranscriptPage
from fastapi import APIRouter, Depends, Path, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState
from pydantic import TypeAdapter, ValidationError

from iclip.common.generation_vocab import GenerationKind, GenerationOperation, GenerationStatus
from iclip.domains.identity.public import (
    MANAGE_PERMISSION,
    ActAs,
    Principal,
    require_permission,
    resolve_user_name,
    websocket_origin_allowed,
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

_logger = structlog.stdlib.get_logger(__name__)

HEARTBEAT_SECONDS = 10.0
"""心跳间隔，与 kimi DEFAULT_HEARTBEAT_INTERVAL_MS 对齐。"""

HEARTBEAT_MISS_LIMIT = 2
"""连续无入站帧达到此周期数时断开；任意客户端帧均可证明连接存活。"""

MAX_EVENT_BUFFER = 2048
"""多对话共享的连接出站缓冲上限；溢出时断开并要求重连补批，避免阻塞运行。"""

GOING_AWAY: Final = 1001
"""运行时那一头断了（对话内容流或应用事件流）时关浏览器连接用的关闭码：客户端照常重连、重订、重拉。"""

_CLIENT_FRAME = TypeAdapter[Any](ClientFrame)


# 运行时那一页加上对话行的几项信封字段。文档字符串是合同里这个 schema 的说明，改它就改了合同。
class TranscriptPage(SessionTranscriptPage):
    """``GET /transcript`` 的一页。

    ``agents`` 与 ``pending_interactions`` 是协议要求的字段：前者是主 agent 加各子代理，后者从
    待回应的交互里取。
    """

    title: str = ""
    """标题位于信封顶层，避免被协议 meta schema 丢弃；后续更新通过 session.meta.updated 发送。"""
    owner_user_id: str | None = None
    """属主：会话页据此判断这是不是自己的对话。"""
    deleted_at: str | None = None
    """属主删掉这段对话的 ISO 时刻；只有治理者复盘墓碑时非空。"""
    forked_from: str | None = None
    """这段对话分叉自哪一段；会话页据此画血缘提示，不是分叉来的为空。"""
    fork_turn: int | None = None
    """分叉自源对话的第几轮，与 ``forked_from`` 同时有值。"""


class ImportAttachments(Protocol):
    """受理消息前处理附件：挂不上 OSS 处理参数的图片地址转存进本桶、记成 ``principal`` 的上传，
    交回换过地址的 content，其余 part 原样。``prompt_id`` 让重发同一条消息时复用已转存的那份，
    为 None（不带 id 的重新生成）时每次都重新转存。转存失败抛 ``ValidationFailed``，说明第几张
    附件。实现由组合根接到 uploads。"""

    async def __call__(
        self,
        principal: Principal,
        *,
        conversation_id: str,
        prompt_id: str | None,
        content: tuple[PromptContent, ...],
    ) -> tuple[PromptContent, ...]: ...


class ConversationHeader(Protocol):
    """会话页首屏要贴在信封顶层的几项，外加读这一页要用的 Agent id。"""

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
    """对话可见性与 Agent 绑定查询协议。"""

    async def agent_of(self, principal: Principal, conversation_id: str, *, writing: bool) -> str:
        """读取可见对话的 Agent id；writing=True 时仅允许属主，不可见时抛 NotFound。"""
        ...

    async def header_of(self, principal: Principal, conversation_id: str) -> ConversationHeader:
        """读取可见对话的首屏信息，可见范围同 ``agent_of(writing=False)``；不可见时抛 NotFound。"""
        ...


ProtocolId = Annotated[str, Path(pattern=r"^[A-Za-z0-9._-]{1,128}$")]
"""协议里由客户端铸的路径标识：消息 id、交互 id 与轮 id，不是 UUID（轮 id 长 ``t1`` 这样）。"""


def _canonical_conversation_id(conversation_id: uuid.UUID) -> str:
    """路径上的对话 id 按 UUID 解析后规范化。

    调用方写不写横线都命中同一段对话，而工作区与实时状态只见到一种拼写
    （见 ``ConversationService`` 对规范写法的要求）。"""

    return str(conversation_id)


ConversationId = Annotated[str, Depends(_canonical_conversation_id)]


def _canonical_session_id(session_id: str) -> str | None:
    """WS 帧里的对话 id 按 UUID 解析后规范化；不是 UUID 就是 ``None``。

    与 REST 路径同一条规则，无横线写法照样命中那段对话；调用方按 ``None`` 走不可见的同一个
    应答，不区分「写法不对」和「看不见」。"""

    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return None


AgentId = Annotated[str, Query(pattern=r"^[A-Za-z0-9._-]{1,128}$")]
"""协议的 agent id 形状：主 agent 是 main，子代理是它的 run id。"""


class LiveConnections:
    """当前进程的 WebSocket 连接集合。

    标题、活动、生成任务与会话生命周期广播不依赖对话订阅，发给属主的连接和治理者的连接，范围由
    握手主体定。每一帧带属主，客户端据此分清自己的对话与别人的对话。
    多 worker 各自持有连接集合，未收到广播的客户端需重新读取数据库状态。

    帧上没有序号，客户端按到达先后生效：所有 ``announce_*`` 都在写入提交之后调用，同步入队、不 await，
    调用的先后就是每条连接上的到达先后。"""

    def __init__(self) -> None:
        self._connections: set[_Connection] = set()

    def add(self, connection: _Connection) -> None:
        self._connections.add(connection)

    def discard(self, connection: _Connection) -> None:
        self._connections.discard(connection)

    def close_all(self, code: int) -> None:
        """以 ``code`` 关掉此刻的每一条连接；客户端重连后重订、重拉列表对齐。"""

        for connection in tuple(self._connections):
            connection.drop(code)

    def announce_title(self, owner: uuid.UUID, conversation_id: uuid.UUID, title: str) -> None:
        """向属主与治理者的连接广播标题更新。"""

        self._announce(
            owner,
            SessionMetaUpdated(
                session_id=str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
                payload=SessionMetaPayload(title=title),
            ),
        )

    def announce_activity(self, frame: SessionWorkChanged) -> None:
        """把运行时的活动帧原样发给属主与治理者的连接。"""

        self._announce(uuid.UUID(frame.owner_user_id), frame)

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
        """向属主与治理者的连接广播生成任务状态跳转；只收基础字段与 common 的词表，不依赖生成域类型。"""

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
        """广播新出现或变化了的整行 ``ConversationOut``（camelCase 字典）。

        照 Kimi 的 ``event.session.created`` / ``updated``。调用方在提交之后、按提交先后调用：帧按到达先后
        生效，同一段对话的整行帧晚发的就是新的。"""

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
        """广播属主删掉了一段对话。"""

        self._announce(
            owner,
            SessionDeleted(
                session_id=str(conversation_id),
                owner_user_id=str(owner),
                timestamp=timestamp_now(),
            ),
        )

    def _announce(self, owner: uuid.UUID, frame: Any) -> None:
        # 回调可能移除连接，遍历副本避免迭代集合被修改。
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
    """挂 transcript 的读写端点与订阅连接，transcript 经 ``runtime`` 读写与订阅。``import_attachments``
    在发消息与带新内容的重新生成受理前转存图片附件；没配对象存储时为 None，不转存。"""

    # :abort 紧跟对话 id，无法复用带尾部斜杠的前缀；与 /ws 一起挂在外层路由。
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
        # 能写的只有属主，换过主体之后的这个人就是会话的属主。
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
    ) -> Response:
        """一页轮子。不给位置就是最新那几轮，往上翻给 ``before_turn``。

        ``agent_id`` 默认主 agent；给子代理的 id 就读它那条流，不属于这段对话的 id 是 404。
        标题在这里贴上：引擎那一侧不认识对话表，而首屏得有个名字显示（之后的改名走
        ``session.meta.updated`` 推送，不再问这里）。
        """

        header = await conversations.header_of(principal, conversation_id)
        # 子代理流属不属于这段对话由运行时核，不属于是 404。
        page = await runtime.transcript_page(
            uuid.UUID(conversation_id),
            session_agent=header.agent_id,
            agent=agent_id,
            before_turn=before_turn,
            after_turn=after_turn,
            page_size=page_size,
        )
        # 一页可能有几百 KB：客户端库已经解析过一次，这里不再校验地贴上页头字段、直接答 JSON，FastAPI
        # 也就不按 response_model 再校验一遍。序列化同它的默认：按别名、保留 null。
        enveloped = TranscriptPage.model_construct(
            **dict(page),
            title=header.title,
            owner_user_id=str(header.owner_user_id),
            deleted_at=None if header.deleted_at is None else header.deleted_at.isoformat(),
            forked_from=None if header.forked_from is None else str(header.forked_from),
            fork_turn=header.fork_turn,
        )
        return Response(
            content=enveloped.model_dump_json(by_alias=True), media_type="application/json"
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
        """一条连接管这个人的所有对话。哪几段由 ``subscribe_v2`` 说，逐段核权。"""

        if not websocket_origin_allowed(websocket, allowed_origins):
            # 握手前以 policy violation 拒绝连接。
            _logger.info(
                "订阅连接被拒：Origin 不同源",
                origin=websocket.headers.get("origin"),
                host=websocket.headers.get("host"),
            )
            await websocket.close(code=1008)
            return
        principal = websocket_principal(websocket)
        if principal is None:
            # 仅记录凭证是否存在，区分缺失与解析失败，避免泄露凭证。
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
    """出站队列里的关连接标记：发送泵取到它就以 ``code`` 关掉连接。"""

    def __init__(self, code: int) -> None:
        self.code = code


class _Connection:
    """多对话 WebSocket 连接，帧通过 session_id 分流。

    transcript 订阅转给这条连接独占的一条运行时对话内容流：``subscribe_v2`` 先在这里核可见性，看不见的
    就地回 ``not_found``、不转过去，看得见的原样（换成规范写法的 id）转过去，回执由运行时给，一帧一个；
    ``unsubscribe_v2`` 原样转过去。运行时发来的回执、reset / ops、订着的对话的文件变化与它新加的帧都不解析，
    原文发出。运行时那一头断了就以 1001 关掉这条连接。

    出站经有界队列，回调、转发与就地回执都只往里放、不等发送；缓冲溢出时断开以便重连补批。

    帧里的对话 id 两种写法都收，订阅与回发的 ``session_id`` 一律用规范写法：客户端按 ``session_id``
    分流，全局帧与 REST 也只给这一种拼写，多一种会让同一段对话在客户端裂成两份。"""

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
            # 连不上运行时，或连接在收尾时才报断开：关掉浏览器这一头，客户端照常重连。
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
        # 显式管理发送、心跳与转发任务，将客户端断开统一作为连接正常结束处理。
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
            # 这一头没有要放开的实时状态：订阅在运行时那边，随下面关掉对话内容流一起撤掉。先同步取消
            # 各任务再 await，连接任务被取消时 finally 里的 await 会被再次取消。
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
                # 忽略未知帧类型，兼容新增协议帧。
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
            # 退订本就幂等，不核可见性；回执由运行时给。
            raw = frame.payload.session_id
            payload = frame.payload.model_copy(
                update={"session_id": _canonical_session_id(raw) or raw}
            )
            await upstream.unsubscribe(frame.model_copy(update={"payload": payload}))

    async def _visible(self, session_id: str) -> str | None:
        """帧里的对话 id 规范化并核可见性，拿不到就是 ``None``。

        写法不是 UUID、对话不存在、对当前主体不可见，三者同一个结果，不泄露存在性。"""

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
            # 不泄露不可见对话的存在性，也不影响连接上的其他订阅；不转给运行时，回执就这一个。
            # 拒了的写法没有规范形式，回执里原样带回客户端问的那个。
            # 不等队列空位：发送泵溢出退出后没人再取，等就再也读不到下一帧、连接收不了尾。
            self.offer(
                Ack(
                    id=frame.id,
                    payload=SubscribeAckPayload(not_found=(frame.payload.session_id,)),
                )
            )
            return
        # 档位、水位与子代理流的归属由运行时照同一套规则处理；它回这一帧的回执。
        payload = frame.payload.model_copy(update={"session_id": conversation_id})
        await upstream.subscribe(frame.model_copy(update={"payload": payload}))

    async def _relay(self, upstream: TranscriptChannel) -> None:
        """把运行时发来的帧原文转给浏览器；运行时那一头断了就以 1001 关掉这条连接。对话的帧只来自这条上游
        订着的对话，订阅前已经核过可见性。"""

        try:
            while True:
                self.offer(await upstream.receive())
        except RuntimeUnavailable as exc:
            _logger.warning("运行时的对话内容流断了，关掉这条订阅连接", reason=str(exc))
            self.drop(GOING_AWAY)

    def receives(self, owner: uuid.UUID) -> bool:
        """全局帧发给谁：属主自己的连接，和治理者的连接。

        权限按握手时的主体快照，吊销后要重连才生效。"""

        return self._principal.user_id == owner or self._principal.has(MANAGE_PERMISSION)

    def offer(self, frame: Any) -> None:
        """加入出站队列，容量不足时标记溢出。"""

        try:
            self._outbound.put_nowait(frame)
        except asyncio.QueueFull:
            self._overflowed = True

    def drop(self, code: int) -> None:
        """排在已入队的帧后面以 ``code`` 关掉连接；队列满时按溢出以 1013 关。"""

        self.offer(_Drop(code))

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
                # 溢出后流已存在缺口，以 1013 断开，要求客户端重连补批。
                await self._ws.close(code=1013)
                return
            if isinstance(frame, _Drop):
                await self._ws.close(code=frame.code)
                return
            await self._send(frame)

    async def _heartbeat(self) -> None:
        """定期发送 ping，连续多个周期没有任何入站帧时断开。"""

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
        """运行时的帧发原文；本进程的帧按字段别名序列化实体和操作，以匹配客户端协议，WebSocket 不经过
        FastAPI 响应序列化。"""

        text = (
            frame.text
            if isinstance(frame, RawFrame)
            else frame.model_dump_json(exclude_none=True, by_alias=True)
        )
        try:
            await self._ws.send_text(text)
        except RuntimeError as exc:
            # Starlette 在关闭后发送时抛 RuntimeError，统一转换为连接断开。
            raise WebSocketDisconnect(code=1006) from exc

    async def _receive(self) -> str:
        if self._ws.application_state == WebSocketState.DISCONNECTED:
            # 发送泵或心跳已经关了连接（溢出、上游断开、心跳超时），Starlette 不让再收、会抛 RuntimeError；
            # 当作连接断开，读循环就此收尾。别的 RuntimeError 照常抛。
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

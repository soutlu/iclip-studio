"""给应用的两条 WebSocket：应用事件流 ``/v1/events`` 与对话内容流 ``/v1/ws``，帧见 ``agent_runtime.live.frames``。

握手带 ``Authorization: Bearer <应用密钥>``，认不出是哪个应用就在握手前以 ``1008`` 关闭。两条都是：

- 出站经一条有界队列（``MAX_OUTBOUND`` 帧，按连接算），同步回调只往里放、不等发送；放不下就记溢出，发送
  方随后以 ``1013`` 关连接，对方重连再对齐。
- 每 ``HEARTBEAT_SECONDS`` 秒发一帧 ``ping``；连着 ``HEARTBEAT_MISS_LIMIT`` 个周期没收到任何入站帧就以
  ``1001`` 关闭。

事件流：一条连接收调用方应用所有会话的活动，先到的先发，别的应用的收不到；入站只看是不是活着。

对话内容流：照后端浏览器那条连接的 transcript 一半，每段会话发一帧 ``subscribe_v2``，规则相同（档位、
先监听再取快照、补批帧筛空了也发、实时批筛空了不发、升档先 reset、子代理流要能回溯到这段会话）。
会话不归调用方应用与不存在一样答 ``not_found``。帧上没有会话事件序号。订着一段会话（任何档位，含
``off``）的连接还收它的工作区文件变化 ``event.fs.changed``。连接断开时撤掉它的全部监听，最后一个撤掉时
放开这段会话的实时状态、不再收它的文件变化。
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import uuid
from collections.abc import Callable, Mapping, Sequence

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from agent_runtime.errors import DomainError
from agent_runtime.harness.transcript.service import TranscriptService
from agent_runtime.harness.transcript.store import OpBatch
from agent_runtime.http.auth import CallingApp
from agent_runtime.live.frames import (
    Ack,
    Ping,
    PingPayload,
    Pong,
    SubscribeAckPayload,
    TranscriptClientFrame,
    TranscriptOpsFrame,
    TranscriptResetFrame,
    timestamp_now,
)
from agent_runtime.live.hub import AppEventHub, SessionFileChanges
from agent_runtime.service.sessions import SessionService
from agent_runtime.transcript.granularity import (
    TranscriptGrade,
    filter_ops_for_grade,
    grade_for,
    needs_reset_on_transition,
)
from agent_runtime.transcript.ops import MAIN_AGENT_ID
from agent_runtime.transcript.wire import (
    Envelope,
    OpsPayload,
    ResetPayload,
    Subscribe,
    SubscribePayload,
    Unsubscribe,
)

_logger = structlog.stdlib.get_logger(__name__)

HEARTBEAT_SECONDS = 10.0
"""发 ``ping`` 的间隔，与后端浏览器那条连接相同。"""

HEARTBEAT_MISS_LIMIT = 2
"""连着这么多个周期没有任何入站帧就断开。"""

MAX_OUTBOUND = 2048
"""一条连接的出站积压上限，与后端浏览器那条连接相同。"""

_AGENT_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
"""协议的 agent id 形状：主 agent 是 main，子代理是它的 run id。"""

_CLIENT_FRAME = TypeAdapter[Subscribe | Unsubscribe | Pong](TranscriptClientFrame)

Identify = Callable[[str | None], CallingApp | None]


def _canonical_session_id(session_id: str) -> str | None:
    """帧里的会话 id 按 UUID 解析后规范成带横线的写法；不是 UUID 就是 ``None``。"""

    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return None


def _subscribed_agents(spec: Mapping[str, TranscriptGrade]) -> tuple[str, ...]:
    """订阅表里点名的 agent；``*`` 只落到主 agent 上，子代理要点名订。"""

    named = [agent_id for agent_id in spec if agent_id != "*"]
    if "*" in spec and MAIN_AGENT_ID not in named:
        named.insert(0, MAIN_AGENT_ID)
    return tuple(named)


async def _accepted_app(websocket: WebSocket, identify: Identify, stream: str) -> CallingApp | None:
    app = identify(websocket.headers.get("authorization"))
    if app is None:
        # 只记有没有带凭证，不记凭证本身。
        _logger.info(
            "实时连接被拒：认不出应用",
            stream=stream,
            has_authorization="authorization" in websocket.headers,
        )
        await websocket.close(code=1008)
    return app


class _Channel:
    """一条 WebSocket 的出站队列、发送泵与心跳；入站帧交给 ``_handle``，断开后调 ``_release``。"""

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket
        self._outbound: asyncio.Queue[Envelope] = asyncio.Queue(maxsize=MAX_OUTBOUND)
        self._overflowed = False
        self._last_inbound = asyncio.get_running_loop().time()

    def offer(self, frame: Envelope) -> None:
        """同步放进出站队列；放不下记溢出，发送泵随后以 1013 断开。"""

        try:
            self._outbound.put_nowait(frame)
        except asyncio.QueueFull:
            self._overflowed = True

    async def serve(self) -> None:
        await self._ws.accept()
        helpers = (asyncio.create_task(self._pump()), asyncio.create_task(self._heartbeat()))
        try:
            await self._read()
        except (WebSocketDisconnect, ConnectionError):
            _logger.debug("实时连接断开")
        finally:
            # 先同步放开占着的东西再 await：连接任务被取消时（服务关停、对端断开后宿主取消任务），
            # finally 里的 await 会被再次取消，排在它后面的清理就不跑了。
            self._release()
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)

    async def _handle(self, raw: str) -> None:
        """一帧入站文本；默认只用它证明连接活着。"""

    def _release(self) -> None:
        """连接结束后撤掉它占着的东西。"""

    async def _read(self) -> None:
        while True:
            raw = await self._ws.receive_text()
            self._last_inbound = asyncio.get_running_loop().time()
            await self._handle(raw)

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
                # 溢出后流已有缺口，以 1013 断开，要对方重连对齐。
                await self._ws.close(code=1013)
                return
            await self._send(frame)

    async def _heartbeat(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            if loop.time() - self._last_inbound >= HEARTBEAT_SECONDS * HEARTBEAT_MISS_LIMIT:
                await self._ws.close(code=1001)
                return
            with contextlib.suppress(asyncio.QueueFull):
                self._outbound.put_nowait(
                    Ping(timestamp=timestamp_now(), payload=PingPayload(nonce=uuid.uuid4().hex[:8]))
                )

    async def _send(self, frame: Envelope) -> None:
        """嵌套的 transcript 实体与操作按别名（camelCase）序列化；WebSocket 不经 FastAPI 的响应序列化。"""

        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except RuntimeError as exc:
            # Starlette 在关闭后发送时抛 RuntimeError，统一当作连接断开。
            raise WebSocketDisconnect(code=1006) from exc


class _TranscriptConnection(_Channel):
    """对话内容流的一条连接：按（会话，agent）各订各的，帧按 ``session_id`` 分流。

    订着一段会话（不论几个 agent、什么档位）的期间，这条连接在 ``file_changes`` 里登记着这段会话，收它的
    文件变化帧。"""

    def __init__(
        self,
        websocket: WebSocket,
        app: CallingApp,
        transcripts: TranscriptService,
        sessions: SessionService,
        file_changes: SessionFileChanges,
    ) -> None:
        super().__init__(websocket)
        self._app = app
        self._transcripts = transcripts
        self._sessions = sessions
        self._file_changes = file_changes
        self._listeners: dict[tuple[str, str], Callable[[OpBatch], None]] = {}
        self._grades: dict[tuple[str, str], TranscriptGrade] = {}

    async def _handle(self, raw: str) -> None:
        try:
            frame = _CLIENT_FRAME.validate_json(raw)
        except ValidationError:
            # 认不出的帧忽略，新增的协议帧不至于断连。
            return
        if isinstance(frame, Subscribe):
            await self._subscribe(frame)
        elif isinstance(frame, Unsubscribe):
            # 退订本就幂等，写法不对的 id 记账里必然没有，撤不到什么照样回执。
            raw_id = frame.payload.session_id
            self._unlisten(_canonical_session_id(raw_id) or raw_id, frame.payload.agent_ids)
            await self._outbound.put(Ack(id=frame.id))

    def _release(self) -> None:
        for session_id in {key[0] for key in self._listeners}:
            self._unlisten(session_id)

    async def _owned(self, session_id: str) -> str | None:
        """帧里的会话 id 规范化并核归属；写法不对、不存在、归别的应用三者同一个结果。"""

        canonical = _canonical_session_id(session_id)
        if canonical is None:
            return None
        owned = await self._sessions.owned((uuid.UUID(canonical),), app_id=self._app.id)
        return canonical if owned else None

    async def _subscribe(self, frame: Subscribe) -> None:
        session_id = await self._owned(frame.payload.session_id)
        if session_id is None:
            # 拒了的写法没有规范形式，回执里原样带回对方问的那个；连接上的其他订阅不动。
            await self._outbound.put(
                Ack(id=frame.id, payload=SubscribeAckPayload(not_found=(frame.payload.session_id,)))
            )
            return
        agent_ids = _subscribed_agents(frame.payload.transcript)
        for agent_id in agent_ids:
            # 陌生或不属于这段会话的 agent：整帧不生效，已有订阅保持原样。
            known = _AGENT_ID.fullmatch(agent_id) is not None
            if not known or not await self._owns_agent(session_id, agent_id):
                await self._outbound.put(
                    Ack(id=frame.id, code=404, msg=f"agent not in session: {agent_id}")
                )
                return
        for agent_id in agent_ids:
            await self._subscribe_agent(session_id, agent_id, frame.payload)
        await self._outbound.put(
            Ack(id=frame.id, payload=SubscribeAckPayload(accepted=(session_id,)))
        )

    async def _owns_agent(self, session_id: str, agent_id: str) -> bool:
        try:
            await self._transcripts.verify_agent(session_id, agent_id)
        except DomainError:
            return False
        return True

    async def _subscribe_agent(
        self, session_id: str, agent_id: str, payload: SubscribePayload
    ) -> None:
        key = (session_id, agent_id)
        grade = grade_for(payload.transcript, agent_id)
        previous = self._grades.get(key)
        self._grades[key] = grade
        since = payload.transcript_since.get(agent_id)
        epoch = payload.transcript_epoch.get(agent_id)
        if previous is not None and needs_reset_on_transition(previous, grade):
            # 调高档位后缺着低档时筛掉的操作，只能重置，不能沿用旧水位。
            since = None
        # 先监听再取快照，不漏两步之间的批次；重复的批次可安全重放。
        if key not in self._listeners:
            if not self._listening(session_id):
                self._transcripts.pin(session_id)
                # 订阅时已核过会话归调用方应用，文件变化跟着订阅走，off 档也收。
                self._file_changes.attach(session_id, self)
            listener = self._listener_for(session_id, agent_id)
            self._listeners[key] = listener
            self._transcripts.listen(session_id, listener, agent_id=agent_id)
        # off 保留订阅，只是不发这个 agent 的帧。
        if grade != "off":
            subscribed = self._transcripts.subscribe(
                session_id, agent_id=agent_id, since=since, epoch=epoch
            )
            for item in subscribed.frames:
                # 补批帧筛空了也发：它推进对方的水位。
                await self._outbound.put(
                    _wrap(session_id, _graded(item, grade), subscribed.stream_epoch)
                )

    def _listening(self, session_id: str) -> bool:
        return any(key[0] == session_id for key in self._listeners)

    def _listener_for(self, session_id: str, agent_id: str) -> Callable[[OpBatch], None]:
        def on_batch(batch: OpBatch) -> None:
            grade = self._grades.get((session_id, agent_id), "off")
            ops = filter_ops_for_grade(grade, batch.ops)
            if not ops:
                # 实时批筛空了不发；筛掉的操作可重放，重连时重复读取安全。
                return
            payload = OpsPayload(agent_id=agent_id, ops=ops, seq=batch.seq)
            self.offer(_wrap(session_id, payload, batch.epoch))

        return on_batch

    def _unlisten(self, session_id: str, agent_ids: Sequence[str] = ()) -> None:
        """幂等退订；不点名就撤这段会话的全部 agent，最后一个撤掉时放开实时状态的固定、注销文件变化。"""

        keys = [
            key
            for key in self._listeners
            if key[0] == session_id and (not agent_ids or key[1] in agent_ids)
        ]
        for key in keys:
            self._grades.pop(key, None)
            self._transcripts.unlisten(session_id, self._listeners.pop(key), agent_id=key[1])
        if keys and not self._listening(session_id):
            self._transcripts.unpin(session_id)
            self._file_changes.detach(session_id, self)


Catchup = ResetPayload | OpsPayload


def _graded(payload: Catchup, grade: TranscriptGrade) -> Catchup:
    """按档位筛补批；reset 的 items 恒为空，原样保留。"""

    if isinstance(payload, ResetPayload):
        return payload
    return payload.model_copy(update={"ops": filter_ops_for_grade(grade, payload.ops)})


def _wrap(
    session_id: str, payload: Catchup, epoch: str
) -> TranscriptResetFrame | TranscriptOpsFrame:
    if isinstance(payload, ResetPayload):
        return TranscriptResetFrame(
            session_id=session_id, timestamp=timestamp_now(), stream_epoch=epoch, payload=payload
        )
    return TranscriptOpsFrame(
        session_id=session_id, timestamp=timestamp_now(), stream_epoch=epoch, payload=payload
    )


def create_events_router(identify: Identify, hub: AppEventHub) -> APIRouter:
    """``/v1/events``：不在 ``/v1`` 的 HTTP 路由组里，鉴权自己做。"""

    router = APIRouter()

    @router.websocket("/v1/events")
    async def events(websocket: WebSocket) -> None:
        app = await _accepted_app(websocket, identify, "events")
        if app is None:
            return
        # 事件流的入站只用来证明活着，集线器经 offer 交来这个应用的会话活动。
        connection = _Channel(websocket)
        hub.attach(app.id, connection)
        try:
            await connection.serve()
        finally:
            hub.detach(app.id, connection)

    return router


def create_transcript_ws_router(
    identify: Identify,
    transcripts: TranscriptService,
    sessions: SessionService,
    file_changes: SessionFileChanges,
) -> APIRouter:
    """``/v1/ws``：不在 ``/v1`` 的 HTTP 路由组里，鉴权自己做。``file_changes`` 是会通知的文件存储交出
    变化的那一处，连接按订阅在里面登记。"""

    router = APIRouter()

    @router.websocket("/v1/ws")
    async def transcript_stream(websocket: WebSocket) -> None:
        app = await _accepted_app(websocket, identify, "transcript")
        if app is None:
            return
        await _TranscriptConnection(websocket, app, transcripts, sessions, file_changes).serve()

    return router


__all__ = [
    "HEARTBEAT_MISS_LIMIT",
    "HEARTBEAT_SECONDS",
    "MAX_OUTBOUND",
    "create_events_router",
    "create_transcript_ws_router",
]

from __future__ import annotations

import asyncio
import contextlib
import re
import uuid
from collections.abc import Callable, Mapping, Sequence

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError
from starlette.websockets import WebSocketState

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

HEARTBEAT_MISS_LIMIT = 2

MAX_OUTBOUND = 2048

_AGENT_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

_CLIENT_FRAME = TypeAdapter[Subscribe | Unsubscribe | Pong](TranscriptClientFrame)

Identify = Callable[[str | None], CallingApp | None]


def _canonical_session_id(session_id: str) -> str | None:
    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return None


def _subscribed_agents(spec: Mapping[str, TranscriptGrade]) -> tuple[str, ...]:
    named = [agent_id for agent_id in spec if agent_id != "*"]
    if "*" in spec and MAIN_AGENT_ID not in named:
        named.insert(0, MAIN_AGENT_ID)
    return tuple(named)


async def _accepted_app(websocket: WebSocket, identify: Identify, stream: str) -> CallingApp | None:
    app = identify(websocket.headers.get("authorization"))
    if app is None:
        _logger.info(
            "实时连接被拒：认不出应用",
            stream=stream,
            has_authorization="authorization" in websocket.headers,
        )
        await websocket.close(code=1008)
    return app


class _Channel:
    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket
        self._outbound: asyncio.Queue[Envelope] = asyncio.Queue(maxsize=MAX_OUTBOUND)
        self._overflowed = False
        self._last_inbound = asyncio.get_running_loop().time()

    def offer(self, frame: Envelope) -> None:
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
            self._release()
            for helper in helpers:
                helper.cancel()
            await asyncio.gather(*helpers, return_exceptions=True)

    async def _handle(self, raw: str) -> None: ...

    def _release(self) -> None: ...

    async def _read(self) -> None:
        while True:
            try:
                raw = await self._ws.receive_text()
            except RuntimeError as exc:
                if self._ws.application_state is not WebSocketState.DISCONNECTED:
                    raise
                raise WebSocketDisconnect(code=1006) from exc
            self._last_inbound = asyncio.get_running_loop().time()
            await self._handle(raw)

    async def _pump(self) -> None:
        while True:
            frame = await self._outbound.get()
            if self._overflowed:
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
        try:
            await self._ws.send_text(frame.model_dump_json(exclude_none=True, by_alias=True))
        except RuntimeError as exc:
            raise WebSocketDisconnect(code=1006) from exc


class _TranscriptConnection(_Channel):
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
            return
        if isinstance(frame, Subscribe):
            await self._subscribe(frame)
        elif isinstance(frame, Unsubscribe):
            raw_id = frame.payload.session_id
            self._unlisten(_canonical_session_id(raw_id) or raw_id, frame.payload.agent_ids)
            self.offer(Ack(id=frame.id))

    def _release(self) -> None:
        for session_id in {key[0] for key in self._listeners}:
            self._unlisten(session_id)

    async def _owned(self, session_id: str) -> str | None:
        canonical = _canonical_session_id(session_id)
        if canonical is None:
            return None
        owned = await self._sessions.owned((uuid.UUID(canonical),), app_id=self._app.id)
        return canonical if owned else None

    async def _subscribe(self, frame: Subscribe) -> None:
        session_id = await self._owned(frame.payload.session_id)
        if session_id is None:
            self.offer(
                Ack(id=frame.id, payload=SubscribeAckPayload(not_found=(frame.payload.session_id,)))
            )
            return
        agent_ids = _subscribed_agents(frame.payload.transcript)
        for agent_id in agent_ids:
            known = _AGENT_ID.fullmatch(agent_id) is not None
            if not known or not await self._owns_agent(session_id, agent_id):
                self.offer(Ack(id=frame.id, code=404, msg=f"agent not in session: {agent_id}"))
                return
        for index, agent_id in enumerate(agent_ids):
            reserve = len(agent_ids) - index
            self._subscribe_agent(session_id, agent_id, frame.payload, reserve=reserve)
        self.offer(Ack(id=frame.id, payload=SubscribeAckPayload(accepted=(session_id,))))

    async def _owns_agent(self, session_id: str, agent_id: str) -> bool:
        try:
            await self._transcripts.verify_agent(session_id, agent_id)
        except DomainError:
            return False
        return True

    def _subscribe_agent(
        self, session_id: str, agent_id: str, payload: SubscribePayload, *, reserve: int
    ) -> None:
        key = (session_id, agent_id)
        grade = grade_for(payload.transcript, agent_id)
        previous = self._grades.get(key)
        self._grades[key] = grade
        since = payload.transcript_since.get(agent_id)
        epoch = payload.transcript_epoch.get(agent_id)
        if previous is not None and needs_reset_on_transition(previous, grade):
            since = None
        if key not in self._listeners:
            if not self._listening(session_id):
                self._transcripts.pin(session_id)
                self._file_changes.attach(session_id, self)
            listener = self._listener_for(session_id, agent_id)
            self._listeners[key] = listener
            self._transcripts.listen(session_id, listener, agent_id=agent_id)
        if grade != "off":
            subscribed = self._transcripts.subscribe(
                session_id, agent_id=agent_id, since=since, epoch=epoch
            )
            room = self._outbound.maxsize - self._outbound.qsize()
            if len(subscribed.frames) > room - reserve:
                subscribed = self._transcripts.subscribe(
                    session_id, agent_id=agent_id, since=None, epoch=None
                )
            for item in subscribed.frames:
                self.offer(_wrap(session_id, _graded(item, grade), subscribed.stream_epoch))

    def _listening(self, session_id: str) -> bool:
        return any(key[0] == session_id for key in self._listeners)

    def _listener_for(self, session_id: str, agent_id: str) -> Callable[[OpBatch], None]:
        def on_batch(batch: OpBatch) -> None:
            grade = self._grades.get((session_id, agent_id), "off")
            ops = filter_ops_for_grade(grade, batch.ops)
            if not ops:
                return
            payload = OpsPayload(agent_id=agent_id, ops=ops, seq=batch.seq)
            self.offer(_wrap(session_id, payload, batch.epoch))

        return on_batch

    def _unlisten(self, session_id: str, agent_ids: Sequence[str] = ()) -> None:
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
    router = APIRouter()

    @router.websocket("/v1/events")
    async def events(websocket: WebSocket) -> None:
        app = await _accepted_app(websocket, identify, "events")
        if app is None:
            return
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

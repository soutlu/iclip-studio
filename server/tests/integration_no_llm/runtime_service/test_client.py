from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from cue.app_wire import SessionOpenIn, SessionPromptIn
from cue.client import AppRejected, RuntimeClient, StreamClosed, WorkChangedFrame
from cue.live.frames import Ack, TranscriptOpsFrame, TranscriptResetFrame
from cue.transcript.ops import AttachmentSource, ImageContent, TextContent, TurnUpsertOp
from cue.transcript.wire import Subscribe, SubscribePayload
from fastapi import FastAPI
from httpx_ws.transport import ASGIWebSocketTransport
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    READER_KEY,
    add_model,
    connect_provider,
    publish_agent,
)

AGENT = "director"
IMAGE = "https://bkt.oss-ap-southeast-1.aliyuncs.com/style.jpg"
WAIT = 10.0


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：走起来")}


@pytest.fixture
async def published(admin: httpx.AsyncClient) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)


def connect(app: FastAPI, key: str = READER_KEY) -> RuntimeClient:
    return RuntimeClient("http://runtime.test", key, transport=ASGIWebSocketTransport(app=app))


async def _open(client: RuntimeClient) -> uuid.UUID:
    session_id = uuid.uuid4()
    await client.open_session(SessionOpenIn(id=session_id, agent_id=AGENT))
    return session_id


def _prompt(prompt_id: str, *, agent: str = AGENT) -> SessionPromptIn:
    return SessionPromptIn(
        prompt_id=prompt_id,
        content=(
            TextContent(text="第一问"),
            ImageContent(source=AttachmentSource(kind="url", url=IMAGE)),
        ),
        user_name="logan",
        agent_id=agent,
    )


async def _settled(client: RuntimeClient, session_id: uuid.UUID) -> None:
    async with asyncio.timeout(WAIT):
        while True:
            queue = await client.prompt_queue(session_id)
            if queue.active is None and not queue.queued:
                return
            await asyncio.sleep(0.02)


async def test_a_session_runs_and_reads_back(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app) as reader:
        session_id = await _open(reader)

        accepted = await reader.submit_prompt(session_id, _prompt("prm_first"), owner=owner)
        assert accepted.prompt_id == "prm_first"
        await _settled(reader, session_id)

        assert (await reader.run_status(session_id)).status == "completed"
        page = await reader.transcript_page(session_id, session_agent=AGENT)
        assert [(turn.turn_id, turn.state) for turn in page.items] == [("t1", "completed")]
        assert page.items[0].trigger_prompt_id == "prm_first"
        ops = await reader.transcript_ops(session_id, since_seq=0, stream_epoch=page.stream_epoch)
        assert (ops.complete, ops.latest_seq, ops.stream_epoch) == (
            True,
            page.seq,
            page.stream_epoch,
        )
        assert ops.batches, "跑过一轮，补批里有东西"


async def test_app_refusals_are_app_rejected(runtime_app: FastAPI, actor: uuid.UUID) -> None:
    async with (
        connect(runtime_app) as reader,
        connect(runtime_app, "unknown-key-0123456789-0123456789-ab") as stranger,
    ):
        with pytest.raises(AppRejected) as not_admin:
            await reader.admin_request("POST", "agents", end_user=actor, json={"id": "x"})
        with pytest.raises(AppRejected) as unknown:
            await stranger.agents()

    assert (not_admin.value.status, not_admin.value.detail) == (403, "这个应用没有管理权限")
    assert (unknown.value.status, unknown.value.detail) == (401, "应用密钥无效")


async def test_transcript_stream_subscribes_then_streams_a_run(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    seqs: list[int] = []

    async with connect(runtime_app) as reader:
        session_id = await _open(reader)
        sid = str(session_id)
        subscription = Subscribe(
            id="s1", payload=SubscribePayload(session_id=sid, transcript={"main": "delta"})
        )
        async with reader.connect_transcript() as channel, asyncio.timeout(WAIT):
            await channel.subscribe(subscription)
            reset = TranscriptResetFrame.model_validate_json((await channel.receive()).text)
            ack = Ack.model_validate_json((await channel.receive()).text)
            assert (reset.session_id, reset.payload.agent_id, reset.payload.seq) == (sid, "main", 0)
            assert ack.payload is not None and ack.payload.accepted == (sid,)

            await reader.submit_prompt(session_id, _prompt("prm_ws"), owner=owner)
            while True:
                frame = TranscriptOpsFrame.model_validate_json((await channel.receive()).text)
                assert frame.stream_epoch == reset.stream_epoch
                seqs.append(frame.payload.seq)
                if any(
                    isinstance(op, TurnUpsertOp) and op.turn.state != "running"
                    for op in frame.payload.ops
                ):
                    break
        await _settled(reader, session_id)

    assert seqs == list(range(1, len(seqs) + 1))


async def test_event_stream_delivers_activity_during_a_run(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    seen: list[tuple[bool, str | None]] = []

    async with connect(runtime_app) as reader:
        session_id = await _open(reader)
        async with reader.connect_events() as events, asyncio.timeout(WAIT):
            await reader.submit_prompt(session_id, _prompt("prm_events"), owner=owner)
            async for frame in events:
                assert isinstance(frame, WorkChangedFrame)
                event = frame.event
                if event.session_id == str(session_id):
                    assert event.owner_user_id == str(owner)
                    seen.append((event.payload.busy, event.payload.last_turn_reason))
                    if not event.payload.busy:
                        break

    assert seen[0][0] is True
    assert seen[-1] == (False, "completed")


async def test_an_unknown_app_key_is_refused_before_the_handshake(runtime_app: FastAPI) -> None:
    async with connect(runtime_app, "unknown-key-0123456789-0123456789-ab") as client:
        with pytest.raises(AppRejected) as raised:
            async with client.connect_events():
                pass

    assert not isinstance(raised.value, StreamClosed)
    assert raised.value.status is None

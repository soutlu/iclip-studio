from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from httpx_ws.transport import ASGIWebSocketTransport
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_runtime.app_wire import ActivitiesIn, SessionOpenIn, SessionPromptIn
from agent_runtime.client import RuntimeClient, WorkChangedFrame
from agent_runtime.errors import NotFound
from agent_runtime.http.app import create_app
from agent_runtime.live.frames import Ack, TranscriptOpsFrame, TranscriptResetFrame
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)
from agent_runtime.transcript.ops import TextContent, TurnUpsertOp
from agent_runtime.transcript.wire import Subscribe, SubscribePayload
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    TEST_CREDENTIAL_KEY,
    TEST_MODEL_NAME,
    add_model,
    connect_provider,
    model_builder,
    publish_agent,
)

VIDEO_KEY = ADMIN_KEY

CRM_KEY = READER_KEY

AGENT = "director"
REPLY = "答：收到"
WAIT = 10.0


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says(REPLY)}


@pytest.fixture
def runtime_app(
    engine: AsyncEngine, migrated_pg: str, tmp_path: Path, models: Mapping[str, Model]
) -> FastAPI:
    settings = RuntimeSettings(
        database_url=migrated_pg,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="video", key=VIDEO_KEY, admin=True),
            ResolvedApp(id="crm", key=CRM_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(
        settings,
        plugins={},
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        engine=engine,
        build_model=model_builder(models),
    )


@pytest.fixture
async def published(admin: httpx.AsyncClient) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)


def connect(app: FastAPI, key: str) -> RuntimeClient:
    return RuntimeClient("http://runtime.test", key, transport=ASGIWebSocketTransport(app=app))


async def open_session(client: RuntimeClient) -> uuid.UUID:
    session_id = uuid.uuid4()
    await client.open_session(SessionOpenIn(id=session_id, agent_id=AGENT))
    return session_id


async def test_a_second_app_runs_a_session_and_follows_it_on_both_streams(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app, CRM_KEY) as crm:
        directory = await crm.agents()
        assert [entry.id for entry in directory.items] == [AGENT]

        session_id = await open_session(crm)
        sid = str(session_id)
        activity: list[tuple[str, bool]] = []
        async with (
            crm.connect_events() as events,
            crm.connect_transcript() as channel,
            asyncio.timeout(WAIT),
        ):
            await channel.subscribe(
                Subscribe(
                    id="s1", payload=SubscribePayload(session_id=sid, transcript={"main": "delta"})
                )
            )
            reset = TranscriptResetFrame.model_validate_json((await channel.receive()).text)
            ack = Ack.model_validate_json((await channel.receive()).text)
            assert ack.payload is not None and ack.payload.accepted == (sid,)

            accepted = await crm.submit_prompt(
                session_id,
                SessionPromptIn(
                    prompt_id="prm_crm",
                    content=(TextContent(text="你好"),),
                    user_name="crm-user",
                    agent_id=AGENT,
                ),
                owner=owner,
            )
            assert accepted.prompt_id == "prm_crm"

            while True:
                frame = TranscriptOpsFrame.model_validate_json((await channel.receive()).text)
                assert frame.stream_epoch == reset.stream_epoch
                if any(
                    isinstance(op, TurnUpsertOp) and op.turn.state != "running"
                    for op in frame.payload.ops
                ):
                    break

            async for event in events:
                assert isinstance(event, WorkChangedFrame)
                activity.append((event.event.session_id, event.event.payload.busy))
                if not event.event.payload.busy:
                    break

        page = await crm.transcript_page(session_id, session_agent=AGENT)

    assert activity[0] == (sid, True)
    assert activity[-1] == (sid, False)
    assert [(turn.trigger_prompt_id, turn.state) for turn in page.items] == [
        ("prm_crm", "completed")
    ]
    assert REPLY in page.model_dump_json()


async def test_the_second_app_and_video_cannot_reach_each_others_sessions(
    running: None, published: None, runtime_app: FastAPI
) -> None:
    async with connect(runtime_app, CRM_KEY) as crm, connect(runtime_app, VIDEO_KEY) as video:
        ours = await open_session(crm)
        theirs = await open_session(video)

        with pytest.raises(NotFound):
            await crm.run_status(theirs)
        with pytest.raises(NotFound):
            await crm.transcript_page(theirs, session_agent=AGENT)
        with pytest.raises(NotFound):
            await video.run_status(ours)
        seen = await crm.activities(ActivitiesIn(ids=(ours, theirs)))
        assert set(seen.items) == {ours}

        async with crm.connect_transcript() as channel, asyncio.timeout(WAIT):
            await channel.subscribe(
                Subscribe(
                    id="s1",
                    payload=SubscribePayload(session_id=str(theirs), transcript={"main": "delta"}),
                )
            )
            ack = Ack.model_validate_json((await channel.receive()).text)
    assert ack.payload is not None
    assert (ack.payload.accepted, ack.payload.not_found) == ((), (str(theirs),))

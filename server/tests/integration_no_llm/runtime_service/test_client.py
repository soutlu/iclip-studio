"""运行时的客户端库对着真的运行时服务跑：开会话、发消息跑完、读状态与页与补批、工作区文件与素材、活动与
占位、分叉、按清单拷文件、名册与起标题、管理接口透传、两条 WebSocket，以及别的应用的会话读不到。

经 ``ASGIWebSocketTransport`` 挂上运行时服务（HTTP 交给它继承的 ``ASGITransport``）；运行驱动与事件分发由
``running`` 夹具跑着服务的 lifespan 起停，与测试同一个事件循环、同一个 engine。这个传输层的任务组要在同一个
任务里进出，pytest-asyncio 的异步夹具建与收不在同一个任务里，所以客户端在用例里 ``async with`` 建。"""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest
from agent_runtime.app_wire import (
    ActivitiesIn,
    FilesCopyIn,
    FileWriteIn,
    MaterialsIn,
    SessionForkIn,
    SessionOpenIn,
    SessionPromptIn,
    TitleIn,
)
from agent_runtime.client import RuntimeClient, StreamClosed
from agent_runtime.errors import AgentUnavailable, Conflict, NotFound
from agent_runtime.live.frames import Ack, SessionActivity, TranscriptOpsFrame, TranscriptResetFrame
from agent_runtime.material_ledger.store import Material
from agent_runtime.transcript.ops import AttachmentSource, ImageContent, TextContent, TurnUpsertOp
from agent_runtime.transcript.wire import Subscribe, SubscribePayload
from fastapi import FastAPI
from httpx_ws.transport import ASGIWebSocketTransport
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    add_model,
    connect_provider,
    publish_agent,
)

AGENT = "director"
IMAGE = "https://bkt.oss-ap-southeast-1.aliyuncs.com/style.jpg"
WAIT = 10.0
"""等运行跑完、等帧到的上限（秒）。"""


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：走起来")}


@pytest.fixture
async def published(admin: httpx.AsyncClient) -> None:
    """接好供应商与模型、发布 ``AGENT``。"""

    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)


def connect(app: FastAPI, key: str = READER_KEY) -> RuntimeClient:
    """``key`` 默认是被测应用 ``reader``；``ADMIN_KEY`` 是另一个有管理权限的应用 ``bff``。"""

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


async def _run_one_turn(client: RuntimeClient, owner: uuid.UUID) -> uuid.UUID:
    session_id = await _open(client)
    await client.submit_prompt(session_id, _prompt("prm_first"), owner=owner)
    await _settled(client, session_id)
    return session_id


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
        # 附件在受理时登记进了素材台账。
        found = await reader.lookup_material(session_id, IMAGE, owner=owner)
        assert found == Material(url=IMAGE, kind="image")


async def test_a_prompt_for_another_agent_is_agent_unavailable(
    published: None, admin: httpx.AsyncClient, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    await publish_agent(admin, "storyboard")

    async with connect(runtime_app) as reader:
        session_id = await _open(reader)
        with pytest.raises(AgentUnavailable) as raised:
            await reader.submit_prompt(
                session_id, _prompt("prm_other", agent="storyboard"), owner=owner
            )

    assert raised.value.code == "agent_unavailable"
    assert str(raised.value)


async def test_files_write_read_and_conflict(
    published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app) as reader:
        session_id = await _open(reader)
        written = await reader.write_file(
            session_id, "notes.md", FileWriteIn(content="记一笔"), owner=owner
        )
        again = await reader.write_file(
            session_id,
            "notes.md",
            FileWriteIn(content="再记一笔", expected_version=written.version),
            owner=owner,
        )
        read = await reader.read_file(session_id, "notes.md", owner=owner)
        listed = await reader.list_files(session_id, owner=owner)

        assert (read.content, read.version) == ("再记一笔", again.version)
        assert [entry.path for entry in listed.files] == ["notes.md"]
        with pytest.raises(Conflict):
            await reader.write_file(
                session_id,
                "notes.md",
                FileWriteIn(content="旧版", expected_version=written.version),
                owner=owner,
            )
        with pytest.raises(NotFound) as missing:
            await reader.read_file(session_id, "missing.md", owner=owner)

    assert str(missing.value) == "这段对话里没有这个文件"


async def test_materials_record_and_lookup(
    published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    video = Material(url="https://cdn.test/ref.mp4", kind="video")

    async with connect(runtime_app) as reader:
        session_id = await _open(reader)
        await reader.record_materials(session_id, MaterialsIn(materials=(video,)), owner=owner)

        assert await reader.lookup_material(session_id, video.url, owner=owner) == video
        with pytest.raises(NotFound):
            await reader.lookup_material(session_id, "https://cdn.test/other.mp4", owner=owner)


async def test_activities_and_busy_answer_only_own_sessions(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app) as reader:
        session_id = await _run_one_turn(reader, owner)
        activities = await reader.activities(ActivitiesIn(ids=(session_id, uuid.uuid4())))
        busy = await reader.busy(owner=owner)

    assert set(activities.items) == {session_id}
    assert activities.items[session_id].busy is False
    assert activities.items[session_id].last_turn_reason == "completed"
    assert busy.ids == ()


async def test_fork_copies_the_session(
    running: None, published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    target = uuid.uuid4()

    async with connect(runtime_app) as reader:
        source = await _run_one_turn(reader, owner)
        await reader.write_file(source, "notes.md", FileWriteIn(content="源"), owner=owner)
        await reader.fork_session(
            source, SessionForkIn(target_id=target, source_user=owner, turn=1), owner=owner
        )

        page = await reader.transcript_page(target, session_agent=AGENT)
        copied = await reader.read_file(target, "notes.md", owner=owner)

    assert [turn.turn_id for turn in page.items] == ["t1"]
    assert copied.content == "源"


async def test_files_copy_by_list(published: None, runtime_app: FastAPI, owner: uuid.UUID) -> None:
    async with connect(runtime_app) as reader:
        source = await _open(reader)
        target = await _open(reader)
        await reader.write_file(source, "plan.md", FileWriteIn(content="方案"), owner=owner)

        copied = await reader.copy_files(
            source,
            FilesCopyIn(
                target_id=target,
                source_user=owner,
                files=(("plan.md", "copy.md"),),
                require_any=("plan.md",),
            ),
            owner=owner,
        )
        skipped = await reader.copy_files(
            source,
            FilesCopyIn(
                target_id=target,
                source_user=owner,
                files=(("plan.md", "again.md"),),
                require_any=("missing.md",),
            ),
            owner=owner,
        )
        read = await reader.read_file(target, "copy.md", owner=owner)

    assert (copied.copied, skipped.copied) == (True, False)
    assert read.content == "方案"


async def test_agents_and_title(published: None, runtime_app: FastAPI) -> None:
    async with connect(runtime_app) as reader:
        directory = await reader.agents()
        title = await reader.generate_title(TitleIn(text="拍一条新品视频"))

    assert [item.id for item in directory.items] == [AGENT]
    assert directory.default == AGENT
    # 没设默认对话模型：起不出标题，应用照旧用默认名。
    assert title.title is None


async def test_admin_requests_pass_through(runtime_app: FastAPI, actor: uuid.UUID) -> None:
    body = {"id": "storyboard", "name": "分镜"}

    async with connect(runtime_app, ADMIN_KEY) as bff:
        created = await bff.admin_request("POST", "agents", end_user=actor, json=body)
        duplicate = await bff.admin_request("POST", "agents", end_user=actor, json=body)
        listed = await bff.admin_request("GET", "agents")

    assert created.status_code == 201, created.content
    assert duplicate.status_code == 409
    assert set(json.loads(duplicate.content)) == {"detail"}
    assert (listed.status_code, listed.content_type) == (200, "application/json")
    assert "storyboard" in [item["id"] for item in json.loads(listed.content)["items"]]


async def test_another_apps_session_is_not_found(
    published: None, runtime_app: FastAPI, owner: uuid.UUID
) -> None:
    async with connect(runtime_app) as reader, connect(runtime_app, ADMIN_KEY) as bff:
        session_id = await _open(reader)

        with pytest.raises(NotFound):
            await bff.run_status(session_id)
        with pytest.raises(NotFound):
            await bff.read_file(session_id, "notes.md", owner=owner)
        assert (await bff.activities(ActivitiesIn(ids=(session_id,)))).items == {}


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
            reset = await channel.receive()
            ack = await channel.receive()
            assert isinstance(reset, TranscriptResetFrame)
            assert (reset.session_id, reset.payload.agent_id, reset.payload.seq) == (sid, "main", 0)
            assert isinstance(ack, Ack)
            assert ack.payload is not None and ack.payload.accepted == (sid,)

            await reader.submit_prompt(session_id, _prompt("prm_ws"), owner=owner)
            while True:
                frame = await channel.receive()
                assert isinstance(frame, TranscriptOpsFrame)
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
            async for event in events:
                if isinstance(event, SessionActivity) and event.session_id == str(session_id):
                    assert event.owner_user_id == str(owner)
                    seen.append((event.activity.busy, event.activity.last_turn_reason))
                    if not event.activity.busy:
                        break

    assert seen[0][0] is True
    assert seen[-1] == (False, "completed")


async def test_an_unknown_app_key_is_closed_with_1008(runtime_app: FastAPI) -> None:
    async with connect(runtime_app, "unknown-key-0123456789-0123456789-ab") as client:
        with pytest.raises(StreamClosed) as raised:
            async with client.connect_events():
                pass

    assert raised.value.code == 1008

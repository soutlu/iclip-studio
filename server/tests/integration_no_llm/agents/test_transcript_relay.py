"""浏览器连接经后端转到运行时：回执一帧一个、Transcript 帧盖本进程的事件水位、两条上游各自断开时的关闭码、
文件变化经对话内容流原样到达订着的连接，以及活动与轮次收尾分走两条上游时客户端看得到的先后。"""

from __future__ import annotations

import asyncio
import threading
import uuid
from typing import Any

import pytest
from agent_runtime.client import EventStream, StreamClosed, TranscriptChannel
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.http import streams as runtime_streams
from agent_runtime.plugins.base import PluginHost, PluginRegistry
from fastapi import FastAPI
from sqlalchemy import text
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.helpers.agents import AgentSeed
from tests.helpers.film import FILM, GIVEN_IMAGES, RUN
from tests.helpers.pg import connected
from tests.helpers.runtime_backed import standard_plugins
from tests.helpers.runtime_service import JOTTED, JottingPlugin
from tests.helpers.ws import (
    AGENT_ID,
    open_conversation,
    settled,
    sign_in,
    sign_in_as,
    subscribe,
    until,
)

JOTTER = "jotter"
"""挂着测试插件 ``jotting`` 的 agent：替身模型调它一次，往工作区写 ``notes.md``。"""


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID), AgentSeed(JOTTER, plugins=("jotting",)))


@pytest.fixture
def runtime_plugins() -> Any:
    def bind(host: PluginHost) -> PluginRegistry:
        return {**standard_plugins(host), "jotting": JottingPlugin.bind(files=host.files)}

    return bind


def _send(tc: TestClient, conversation_id: str, prompt_id: str) -> None:
    sent = tc.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": "走"}]},
    )
    assert sent.status_code == 200, sent.text


def _frames_until_turn_and_idle(ws: Any, conversation_id: str) -> list[dict[str, Any]]:
    """收这段对话的帧，直到这一轮在 transcript 上收了尾、活动也回到空闲。"""

    frames: list[dict[str, Any]] = []
    turn_ended = idle = False
    for _ in range(200):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("session_id") != conversation_id:
            continue
        frames.append(frame)
        if frame["type"] == "transcript.ops" and any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            turn_ended = True
        if frame["type"] == "event.session.work_changed" and not frame["payload"]["busy"]:
            idle = True
        if turn_ended and idle:
            return frames
    raise AssertionError("没等到这一轮收尾与空闲两帧")


def _closed_with(ws: Any) -> int:
    """收帧直到连接被关，交回关闭码。"""

    for _ in range(200):
        try:
            ws.receive_json()
        except WebSocketDisconnect as closed:
            return closed.code
    raise AssertionError("连接没被关")


# --- 回执 ----------------------------------------------------------------------


def test_each_subscribe_frame_gets_exactly_one_ack(ws_agent_app: FastAPI, pg_url: str) -> None:
    """看得见的转给运行时、由它回执；看不见的与写法不对的就地回 not_found，不转；子代理流不属于这段对话的
    由运行时回 404。每帧 id 只回一个回执。"""

    with TestClient(ws_agent_app) as tc:
        # 别人的对话在运行时那边有会话：要是转了过去，运行时会回 accepted。
        theirs = open_conversation(
            tc, sign_in_as(tc, pg_url, username="someone", roles=("editor",))
        )
        me = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        mine = open_conversation(tc, me)
        missing = str(uuid.uuid4())
        with tc.websocket_connect("/ws", headers=me) as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, mine, frame_id="visible")
            subscribe(ws, theirs, frame_id="invisible")
            subscribe(ws, missing, frame_id="missing")
            subscribe(ws, "not-a-uuid", frame_id="malformed")
            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "stranger",
                    "payload": {"session_id": mine, "transcript": {"run-nobody": "delta"}},
                }
            )
            subscribe(ws, mine, frame_id="last")

            acks: dict[str, list[dict[str, Any]]] = {}
            while "last" not in acks:
                frame = ws.receive_json()
                if frame["type"] == "ack":
                    acks.setdefault(frame["id"], []).append(frame)

    assert {key: len(found) for key, found in acks.items()} == {
        "visible": 1,
        "invisible": 1,
        "missing": 1,
        "malformed": 1,
        "stranger": 1,
        "last": 1,
    }
    assert acks["visible"][0]["payload"]["accepted"] == [mine]
    # 就地回的与运行时回的是同一种回执。
    assert acks["invisible"][0] == {
        "type": "ack",
        "id": "invisible",
        "code": 0,
        "msg": "",
        "payload": {"accepted": [], "not_found": [theirs]},
    }
    assert set(acks["visible"][0]) == set(acks["invisible"][0])
    assert acks["missing"][0]["payload"]["not_found"] == [missing]
    assert acks["malformed"][0]["payload"]["not_found"] == ["not-a-uuid"]
    assert (acks["stranger"][0]["code"], acks["stranger"][0]["msg"]) == (
        404,
        "agent not in session: run-nobody",
    )


# --- 信封水位 --------------------------------------------------------------------


def test_transcript_frames_carry_the_current_event_number_and_events_tick(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """运行时的 reset / ops 盖上这段对话此刻的事件序号、不另发号；夹在中间的全局帧（改名、活动、整行）各发
    一个新号，之后的 Transcript 帧带上它。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            reset = until(ws, "transcript.reset")
            renamed = tc.patch(f"/conversations/{conversation_id}", json={"title": "新名字"})
            assert renamed.status_code == 200, renamed.text
            _send(tc, conversation_id, "prm_stamp")
            frames = [reset, *_frames_until_turn_and_idle(ws, conversation_id)]

    epochs = {frame["epoch"] for frame in frames}
    assert len(epochs) == 1
    last_event = reset["seq"]
    events = transcripts = 0
    for frame in frames:
        if frame["type"].startswith("transcript."):
            assert frame["seq"] == last_event, "Transcript 帧带此刻的序号、不发号"
            transcripts += 1
        else:
            assert frame["seq"] == last_event + 1, f"{frame['type']} 发下一个号"
            last_event = frame["seq"]
            events += 1
    assert transcripts >= 2
    assert events >= 3, "改名、开跑的整行、忙与闲的活动"


def test_relayed_frames_keep_the_runtimes_timestamp(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """浏览器收到的 Transcript 帧就是运行时的帧加上 ``epoch`` / ``seq``：时刻是运行时出帧时取的，后端不重盖。
    运行时在同一进程里，只把它出帧取时刻的那一处钉住，后端自己的时钟照常走。"""

    pinned = "2000-01-01T00:00:00+00:00"
    monkeypatch.setattr(runtime_streams, "timestamp_now", lambda: pinned)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            subscribe(ws, conversation_id)
            reset = until(ws, "transcript.reset")

    assert hello["timestamp"] != pinned
    assert reset["timestamp"] == pinned
    assert set(reset) == {
        "type",
        "seq",
        "epoch",
        "session_id",
        "timestamp",
        "stream_epoch",
        "payload",
    }
    assert reset["payload"]["type"] == "transcript.reset"


# --- 活动与轮次收尾的先后 ------------------------------------------------------------


def test_after_the_turn_ends_and_the_badge_goes_idle_the_row_reads_idle(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """活动走事件流、轮次收尾走对话内容流，两条上游之间不保证先后。前端收到活动变化就按 id 补读这一行、按
    lastSeq 合并（conversations.live.ts）：所以要的是活动帧按 忙 → 闲 的顺序、序号递增地到达，并且收到闲那一帧
    之后补读的行已经是空闲。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "prm_order")
            frames = _frames_until_turn_and_idle(ws, conversation_id)
            row = tc.get(f"/conversations/{conversation_id}").json()["conversation"]

    work = [frame for frame in frames if frame["type"] == "event.session.work_changed"]
    assert work[0]["payload"]["busy"] is True
    assert work[-1]["payload"]["busy"] is False
    assert work[-1]["payload"]["last_turn_reason"] == "completed"
    assert [frame["seq"] for frame in work] == sorted({frame["seq"] for frame in work})
    assert row["activity"]["busy"] is False
    assert row["activity"]["lastTurnReason"] == "completed"
    assert row["lastSeq"] >= work[-1]["seq"]


# --- 上游断开 --------------------------------------------------------------------


def test_a_dropped_transcript_upstream_closes_the_browser_with_1001_and_releases_the_pins(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """对话内容流那一头断了：浏览器连接以 1001 关，运行时那边这条连接占着的实时状态放开。"""

    dropping = threading.Event()
    receive = TranscriptChannel.receive

    async def flaky(channel: TranscriptChannel) -> Any:
        frame = await receive(channel)
        if dropping.is_set():
            raise StreamClosed(1012, "测试里断开")
        return frame

    monkeypatch.setattr(TranscriptChannel, "receive", flaky)
    store: TranscriptStore = ws_agent_app.state.transcript_store
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, frame_id="s1")
            until(ws, "transcript.reset")
            assert store.holds(conversation_id)
            dropping.set()
            # 下一帧到达上游时断开。
            subscribe(ws, conversation_id, frame_id="s2")
            assert _closed_with(ws) == 1001
        _wait_released(store, conversation_id)


def _wait_released(store: TranscriptStore, conversation_id: str) -> None:
    for _ in range(100):
        if not store.holds(conversation_id):
            return
        threading.Event().wait(0.02)
    raise AssertionError("运行时那边的实时状态没放开")


def test_a_dropped_event_stream_closes_every_browser_connection_then_reconnects(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """事件流断了：此刻的每条浏览器连接都以 1001 关（断线期间的活动补不回来，客户端重连后重拉）；后端随后
    重连事件流，新连接照常收到活动。"""

    dropping = threading.Event()
    following = EventStream.__anext__

    async def flaky(stream: EventStream) -> Any:
        event = await following(stream)
        if dropping.is_set():
            dropping.clear()
            raise StreamClosed(1012, "测试里断开")
        return event

    monkeypatch.setattr(EventStream, "__anext__", flaky)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as first, tc.websocket_connect("/ws") as second:
            assert first.receive_json()["type"] == "server_hello"
            assert second.receive_json()["type"] == "server_hello"
            dropping.set()
            # 这一轮的第一条活动到达时事件流断开。
            _send(tc, conversation_id, "prm_drop")
            assert _closed_with(first) == 1001
            assert _closed_with(second) == 1001
        settled(tc, conversation_id)

        events = ws_agent_app.state.runtime_events

        async def reconnected() -> None:
            await asyncio.wait_for(events.wait_connected(), 10)

        assert tc.portal is not None
        tc.portal.call(reconnected)
        with tc.websocket_connect("/ws") as again:
            assert again.receive_json()["type"] == "server_hello"
            _send(tc, conversation_id, "prm_after")
            busy = until(again, "event.session.work_changed")

    assert busy["session_id"] == conversation_id


# --- 文件变化 --------------------------------------------------------------------


def test_a_plugin_write_reaches_the_subscribed_browser_as_is(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """插件在运行时写工作区，文件帧经这条连接背后的对话内容流原样到浏览器；没订这段对话的连接收不到。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        created = tc.post("/conversations", json={"agentId": JOTTER})
        assert created.status_code == 201, created.text
        conversation_id = str(created.json()["conversation"]["id"])
        with tc.websocket_connect("/ws") as ws, tc.websocket_connect("/ws") as bystander:
            assert ws.receive_json()["type"] == "server_hello"
            assert bystander.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="turn")
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            _send(tc, conversation_id, "prm_jot")
            changed = until(ws, "event.fs.changed", tries=200)
            settled(tc, conversation_id)
            # 帧按序入队：旁观的连接此刻订一段别的对话，跳过全局帧与心跳后先到的应是它的回执，
            # 说明前面那帧文件变化没给它。
            subscribe(bystander, open_conversation(tc), grade="off", frame_id="probe")
            bystander_first = next(
                frame
                for frame in iter(bystander.receive_json, None)
                if frame["type"] in {"ack", "event.fs.changed"}
            )

    assert set(changed) == {"type", "session_id", "timestamp", "payload"}
    assert changed["session_id"] == conversation_id
    assert changed["payload"] == {"changes": [{"path": JOTTED, "change": "created"}]}
    assert (bystander_first["type"], bystander_first["id"]) == ("ack", "probe")


async def _seed_film(pg_url: str, namespace: str) -> None:
    async with connected(pg_url) as conn:
        for path, content in (("film.icml", FILM), ("film.icrun", RUN)):
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.workspace_files "
                    "(namespace, path, content, version, created_at, updated_at) "
                    "VALUES (:ns, :path, :content, 1, now(), now())"
                ),
                {"ns": namespace, "path": path, "content": content},
            )
        for url in GIVEN_IMAGES:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.materials (namespace, url, kind) "
                    "VALUES (:ns, :url, 'image')"
                ),
                {"ns": namespace, "url": url},
            )


def test_a_film_edit_on_the_page_reaches_the_subscribed_browser(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """制作页改画幅：后端经运行时写工程文件，变化同样经对话内容流回到订着这段对话的浏览器连接。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        asyncio.run(_seed_film(pg_url, f"{owner}/{conversation_id}"))
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="off")
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            edited = tc.put(
                f"/conversations/{conversation_id}/film/aspect-ratio",
                json={"filmVersion": 1, "aspectRatio": "9:16"},
            )
            assert edited.status_code == 200, edited.text
            changed = until(ws, "event.fs.changed")

    assert changed["payload"]["changes"] == [{"path": "film.icml", "change": "modified"}]

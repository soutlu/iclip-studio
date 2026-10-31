"""使用同步 TestClient 验证 WS 握手、订阅和序列化契约。

WS 手工序列化必须保留实体别名，否则客户端 schema 校验会丢弃整帧。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

import pytest
from agent_runtime.harness.transcript.store import TranscriptStore
from fastapi import FastAPI
from sqlalchemy import text
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.helpers.agents import AgentSeed
from tests.helpers.pg import connected
from tests.helpers.ws import (
    AGENT_ID,
    drain_turn,
    open_conversation,
    settled,
    sign_in,
    sign_in_as,
    subscribe,
    until,
)


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID),)


def test_subscribe_then_receive_ops(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "server_hello"
            assert hello["payload"]["heartbeat_ms"] > 0

            subscribe(ws, conversation_id)
            reset = until(ws, "transcript.reset")
            # session_id 用于同一连接中的多会话分流。
            assert reset["session_id"] == conversation_id
            assert reset["payload"]["agent_id"] == "main"
            # seq 虽为可选字段，此处必须发送以覆盖客户端水位。
            assert isinstance(reset["payload"]["seq"], int)
            assert reset["payload"]["snapshot"]["items"] == []

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_ws", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            ops = until(ws, "transcript.ops")
            assert ops["payload"]["seq"] >= 1
            assert ops["payload"]["ops"]

            # 嵌套实体需使用 camelCase 别名，保证客户端 schema 校验通过。
            text = json.dumps(ops, ensure_ascii=False)
            assert "turn_id" not in text
            assert "step_id" not in text
            assert "frame_id" not in text

            # 等待运行结束后再断开；运行中断连由独立用例覆盖。
            settled(tc, conversation_id)


def test_resubscribing_with_a_stale_watermark_gets_a_reset(
    ws_agent_app: FastAPI, pg_url: str
) -> None:

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, since=99999)
            assert until(ws, "transcript.reset")["payload"]["seq"] == 0


def test_one_connection_serves_two_conversations(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        first = open_conversation(tc)
        second = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, first, frame_id="s1")
            subscribe(ws, second, frame_id="s2")

            landed = {
                until(ws, "transcript.reset")["session_id"],
                until(ws, "transcript.reset")["session_id"],
            }
            assert landed == {first, second}


def test_closing_the_connection_releases_every_pin_and_listener(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """TestClient 退出时先发断开再取消连接任务，走的是连接被取消的那条收尾路径。"""

    store: TranscriptStore = ws_agent_app.state.transcript_store
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        first = open_conversation(tc)
        second = open_conversation(tc)
        assert not store.holds(first)
        assert not store.holds(second)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, first, frame_id="s1")
            subscribe(ws, second, frame_id="s2", grade="turn")
            until(ws, "transcript.reset")
            until(ws, "transcript.reset")
            assert store.holds(first)
            assert store.holds(second)

        assert not store.holds(first)
        assert not store.holds(second)


def test_turn_grade_carries_the_turn_but_no_deltas(ws_agent_app: FastAPI, pg_url: str) -> None:

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="turn")
            assert until(ws, "transcript.reset")["session_id"] == conversation_id

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_turn", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            kinds = {op["op"] for op in drain_turn(ws)}
            assert "turn.upsert" in kinds
            assert kinds.isdisjoint({"append", "frame.upsert", "step.upsert"})


def test_raising_the_grade_replaces_the_whole_thing(ws_agent_app: FastAPI, pg_url: str) -> None:
    """升档必须 reset，低粒度期间被过滤的内容无法仅凭水位完整补发。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="turn")
            assert until(ws, "transcript.reset")

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_grade", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text
            drain_turn(ws)

            subscribe(ws, conversation_id, since=1, frame_id="s2", grade="delta")
            assert until(ws, "transcript.reset")["session_id"] == conversation_id


def test_subscribing_to_a_conversation_you_cannot_see_is_refused(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """不可见与不存在的会话均拒绝当前订阅，不关闭连接，避免泄漏资源存在性。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, "c-not-mine")

            ack = until(ws, "ack")
            assert ack["payload"]["not_found"] == ["c-not-mine"]
            assert ack["payload"]["accepted"] == []

            mine = open_conversation(tc)
            subscribe(ws, mine, frame_id="s2")
            assert until(ws, "transcript.reset")["session_id"] == mine


def test_subscribing_with_a_dashless_conversation_id_receives_frames(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """WS 与 REST 收同样两种写法：无横线 id 订得上，回发一律是规范写法。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        dashless = uuid.UUID(conversation_id).hex

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, dashless)

            # 客户端按 session_id 分流，全局帧与 REST 只给规范写法，回发不能多出第二种拼写。
            assert until(ws, "transcript.reset")["session_id"] == conversation_id
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]

            sent = tc.post(
                f"/conversations/{dashless}/prompts",
                json={"prompt_id": "prm_dashless", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text
            assert until(ws, "transcript.ops")["session_id"] == conversation_id

            settled(tc, conversation_id)


def test_cross_origin_upgrade_is_refused(
    ws_agent_app: FastAPI, pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    """WS 升级不受 CORS 约束且携带 cookie，需独立校验 Origin 并记录拒绝原因。"""

    with (
        caplog.at_level(logging.INFO, logger="iclip.domains.agents.transcript_api"),
        TestClient(ws_agent_app) as tc,
    ):
        sign_in(tc, pg_url)

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect("/ws", headers={"origin": "https://evil.example"}),
        ):
            pass

    assert refused.value.code == 1008
    # structlog 经标准日志转发时，record.msg 保留事件字典。
    assert any(
        record.name == "iclip.domains.agents.transcript_api"
        and isinstance(record.msg, dict)
        and record.msg.get("origin") == "https://evil.example"
        for record in caplog.records
    )


def test_anonymous_upgrade_is_refused(ws_agent_app: FastAPI) -> None:
    """没有凭证的升级以 policy violation 拒绝。"""

    with (
        TestClient(ws_agent_app) as tc,
        pytest.raises(WebSocketDisconnect) as refused,
        tc.websocket_connect("/ws"),
    ):
        pass

    assert refused.value.code == 1008


def test_a_signed_in_user_without_agent_run_is_refused(
    ws_agent_app: FastAPI, pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    """建连要 agent:run；只读身份以 policy violation 拒绝，日志带上 user_id 表明身份已认出。"""

    with (
        caplog.at_level(logging.INFO, logger="iclip.domains.agents.transcript_api"),
        TestClient(ws_agent_app) as tc,
    ):
        viewer = sign_in_as(tc, pg_url, username="vic", roles=("viewer",))

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect("/ws", headers=viewer),
        ):
            pass

    assert refused.value.code == 1008
    assert any(
        record.name == "iclip.domains.agents.transcript_api"
        and isinstance(record.msg, dict)
        and record.msg.get("user_id")
        for record in caplog.records
    )


def test_api_key_upgrades_with_bearer_alone(ws_agent_app: FastAPI, pg_url: str) -> None:
    """机器端不带 cookie 与 Origin，凭带 agent:run 的钥匙握手。"""

    with TestClient(ws_agent_app) as tc:
        root = sign_in_as(tc, pg_url, username="logan", roles=("root",))
        issued = tc.post(
            "/api-keys", json={"name": "ws", "permissions": ["agent:run"]}, headers=root
        )
        assert issued.status_code == 201, issued.text
        token = issued.json()["apiKey"]["token"]

        with tc.websocket_connect("/ws", headers={"Authorization": f"Bearer {token}"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


def test_same_origin_upgrade_is_accepted(ws_agent_app: FastAPI, pg_url: str) -> None:
    """浏览器同源页面带 Origin 握手：Origin 的 host 与 Host 头一致即放行。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        with tc.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


# 只有这条用例要跨域白名单；直接参数化覆写 conftest 的同名夹具，其余用例仍是空元组。
@pytest.mark.parametrize("cors_allow_origins", [("https://allowed.example",)], ids=["allowlisted"])
def test_allowlisted_cross_origin_upgrade_is_accepted(ws_agent_app: FastAPI, pg_url: str) -> None:
    """配置的 cors_allow_origins 同样放行 WS 跨域升级。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        with tc.websocket_connect("/ws", headers={"origin": "https://allowed.example"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


async def _seed_file(pg_url: str, namespace: str, path: str, content: str) -> None:
    """直接插入会话工作区文件。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.workspace_files "
                "(namespace, path, content, version, created_at, updated_at) "
                "VALUES (:ns, :path, :content, 1, now(), now())"
            ),
            {"ns": namespace, "path": path, "content": content},
        )


def _subscribed_off(ws: Any, conversation_id: str, frame_id: str = "s1") -> dict[str, Any]:
    """off 档订一段对话：不发 reset，交回它的回执。文件变化跟着订阅走，off 档也收。"""

    subscribe(ws, conversation_id, grade="off", frame_id=frame_id)
    ack = until(ws, "ack")
    assert ack["id"] == frame_id
    return ack


def _put(tc: TestClient, conversation_id: str, path: str, body: str) -> None:
    written = tc.put(
        f"/conversations/{conversation_id}/workspace/file",
        json={"path": path, "content": body, "expectedVersion": 1},
    )
    assert written.status_code == 200, written.text


def test_a_subscribed_connection_gets_every_file_change_of_the_conversation_as_is(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """运行时的文件帧原样转给浏览器：外层只有对话与时刻；按路径筛由客户端自己做。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        namespace = f"{owner}/{conversation_id}"
        asyncio.run(_seed_file(pg_url, namespace, "storyboard.md", "初稿"))
        asyncio.run(_seed_file(pg_url, namespace, "frames/grids/a.json", "{}"))

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            assert _subscribed_off(ws, conversation_id)["payload"]["accepted"] == [conversation_id]
            _put(tc, conversation_id, "frames/grids/a.json", '{"v": 2}')
            _put(tc, conversation_id, "storyboard.md", "二稿")
            first = until(ws, "event.fs.changed")
            second = until(ws, "event.fs.changed")

    assert set(first) == {"type", "session_id", "timestamp", "payload"}
    assert first["session_id"] == conversation_id
    assert first["payload"] == {"changes": [{"path": "frames/grids/a.json", "change": "modified"}]}
    assert second["payload"] == {"changes": [{"path": "storyboard.md", "change": "modified"}]}


def test_file_changes_reach_only_connections_subscribed_to_the_conversation(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """另订一段对话当哨兵：没订或已退订的连接，先收到的必须是哨兵那一帧。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id, sentinel = open_conversation(tc), open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        for conversation, path in (
            (conversation_id, "提纲.md"),
            (conversation_id, "再改.md"),
            (sentinel, "哨兵.md"),
            (sentinel, "又一个哨兵.md"),
        ):
            asyncio.run(_seed_file(pg_url, f"{owner}/{conversation}", path, "初稿"))

        with tc.websocket_connect("/ws") as watching, tc.websocket_connect("/ws") as bystander:
            assert watching.receive_json()["type"] == "server_hello"
            assert bystander.receive_json()["type"] == "server_hello"
            _subscribed_off(watching, conversation_id)
            _subscribed_off(watching, sentinel, "s2")
            _subscribed_off(bystander, sentinel)

            _put(tc, conversation_id, "提纲.md", "四幕")
            _put(tc, sentinel, "哨兵.md", "到")
            seen = until(watching, "event.fs.changed")
            bystander_first = until(bystander, "event.fs.changed")
            until(watching, "event.fs.changed")

            watching.send_json(
                {"type": "unsubscribe_v2", "id": "u1", "payload": {"session_id": conversation_id}}
            )
            assert until(watching, "ack")["id"] == "u1"
            _put(tc, conversation_id, "再改.md", "五幕")
            _put(tc, sentinel, "又一个哨兵.md", "到")
            after_unsubscribe = until(watching, "event.fs.changed")

    assert (seen["session_id"], seen["payload"]["changes"][0]["path"]) == (
        conversation_id,
        "提纲.md",
    )
    assert bystander_first["session_id"] == sentinel
    assert after_unsubscribe["payload"]["changes"][0]["path"] == "又一个哨兵.md"


def test_activity_frames_reach_a_connection_that_subscribed_nothing(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """会话活动事件供未订阅会话的侧栏使用，不受 subscribe_v2 限制。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_act", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            busy = until(ws, "event.session.work_changed")
            assert busy["session_id"] == conversation_id
            # 未完成过运行时无终态；exclude_none 会省略该字段。
            assert busy["payload"] == {"busy": True, "pending_interaction": "none"}

            idle = until(ws, "event.session.work_changed")
            assert idle["session_id"] == conversation_id
            assert idle["payload"] == {
                "busy": False,
                "pending_interaction": "none",
                "last_turn_reason": "completed",
            }

            # 列表保留同一活动状态，供事件丢失后重新同步。
            listed = tc.get("/conversations").json()
            row = next(
                item for item in listed["ungrouped"]["items"] if item["id"] == conversation_id
            )
            assert row["activity"] == {
                "busy": False,
                "pendingInteraction": "none",
                "lastTurnReason": "completed",
            }


def test_governor_can_subscribe_to_a_deleted_conversation_but_its_owner_cannot(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """订阅跟着 ``agent_of(writing=False)`` 放开墓碑，治理者订得上；属主订不上，与 REST 同口径。"""

    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="gov", roles=("root",))
        conversation_id = open_conversation(tc, headers=owner)
        assert tc.delete(f"/conversations/{conversation_id}", headers=owner).status_code == 204

        with (
            tc.websocket_connect("/ws", headers=governor) as gov_ws,
            tc.websocket_connect("/ws", headers=owner) as owner_ws,
        ):
            assert gov_ws.receive_json()["type"] == "server_hello"
            assert owner_ws.receive_json()["type"] == "server_hello"

            subscribe(gov_ws, conversation_id, grade="turn")
            assert until(gov_ws, "transcript.reset")["session_id"] == conversation_id

            subscribe(owner_ws, conversation_id)
            assert until(owner_ws, "ack")["payload"]["not_found"] == [conversation_id]


def test_governor_receives_other_peoples_frames_and_a_stranger_receives_none(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """治理者的连接收全平台的活动与标题帧，也能订别人的对话、收它的文件变化；别的普通用户订不上，一帧都
    收不到。"""

    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        stranger = sign_in_as(tc, pg_url, username="maya", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="gov", roles=("root",))
        conversation_id = open_conversation(tc, headers=owner)
        mine = open_conversation(tc, headers=stranger)
        owner_id = tc.get("/users/me", headers=owner).json()["user"]["id"]
        asyncio.run(_seed_file(pg_url, f"{owner_id}/{conversation_id}", "提纲.md", "三幕"))

        with (
            tc.websocket_connect("/ws", headers=governor) as gov_ws,
            tc.websocket_connect("/ws", headers=stranger) as other_ws,
        ):
            assert gov_ws.receive_json()["type"] == "server_hello"
            assert other_ws.receive_json()["type"] == "server_hello"
            subscribe(gov_ws, conversation_id, grade="turn")
            assert until(gov_ws, "transcript.reset")["session_id"] == conversation_id
            # 订不上就收不到这段对话的文件变化：能收的范围就是能订的范围。
            subscribe(other_ws, conversation_id, grade="off", frame_id="theirs")
            assert until(other_ws, "ack")["payload"]["not_found"] == [conversation_id]

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_gov_watch", "content": [{"type": "text", "text": "走"}]},
                headers=owner,
            )
            assert sent.status_code == 200, sent.text
            busy = until(gov_ws, "event.session.work_changed")
            assert (busy["session_id"], busy["payload"]["busy"]) == (conversation_id, True)
            idle = until(gov_ws, "event.session.work_changed")
            assert idle["payload"]["busy"] is False

            renamed = tc.patch(
                f"/conversations/{conversation_id}", json={"title": "改了名"}, headers=owner
            )
            assert renamed.status_code == 200, renamed.text
            title = until(gov_ws, "session.meta.updated")
            assert (title["session_id"], title["payload"]) == (conversation_id, {"title": "改了名"})

            written = tc.put(
                f"/conversations/{conversation_id}/workspace/file",
                json={"path": "提纲.md", "content": "四幕", "expectedVersion": 1},
                headers=owner,
            )
            assert written.status_code == 200, written.text
            changed = until(gov_ws, "event.fs.changed")
            assert changed["session_id"] == conversation_id

            # 陌生人的连接：上面几件事一帧都没到。帧按序入队，这里 off 档订一下自己的对话，
            # 跳过心跳后收到的第一帧就该是这一帧的回执。
            subscribe(other_ws, mine, grade="off", frame_id="w-mine")
            frame = other_ws.receive_json()
            while frame["type"] == "ping":
                frame = other_ws.receive_json()
            assert (frame["type"], frame["id"]) == ("ack", "w-mine")

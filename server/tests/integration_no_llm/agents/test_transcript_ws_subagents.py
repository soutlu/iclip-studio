from __future__ import annotations

import asyncio
import threading
import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy import text
from starlette.testclient import TestClient

from tests.helpers.agents import AgentSeed, SubagentSeed
from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.pg import connected
from tests.helpers.runtime import delegates
from tests.helpers.ws import AGENT_ID, drain_turn, open_conversation, sign_in, subscribe, until

WRITER = "shot-writer"
WRITER_MODEL = "writer-model"
TASK = "写第 3 组的三个镜头"
FIRST_HALF = "S3-1 特写；"
SECOND_HALF = "S3-2 中景；S3-3 全景"

_ENTERED = threading.Event()
_GATE = threading.Event()


def _says_in_two_halves() -> FunctionModel:
    async def stream(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        yield FIRST_HALF
        _ENTERED.set()
        while not _GATE.is_set():
            await asyncio.sleep(0.02)
        yield SECOND_HALF

    return FunctionModel(stream_function=stream, model_name=WRITER_MODEL)


@pytest.fixture(autouse=True)
def _open_gate() -> Iterator[None]:
    _ENTERED.clear()
    _GATE.set()
    yield


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (
        AgentSeed(WRITER, model=WRITER_MODEL, listed=False),
        AgentSeed(AGENT_ID, subagents=(SubagentSeed(WRITER),)),
    )


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: delegates((WRITER, TASK)), WRITER_MODEL: _says_in_two_halves()}


def _send(tc: TestClient, conversation_id: str, text_: str) -> None:
    sent = tc.post(
        f"/conversations/{conversation_id}/prompts",
        json={
            "prompt_id": f"prm_{uuid.uuid4().hex[:8]}",
            "content": [{"type": "text", "text": text_}],
        },
    )
    assert sent.status_code == 200, sent.text


def _child_of(ops: list[dict[str, Any]]) -> str:
    for op in ops:
        if op["op"] == "frame.upsert" and op["frame"].get("agentRefs"):
            return str(op["frame"]["agentRefs"][0]["agentId"])
    raise AssertionError("主流里没有派出子代理的卡")


def _run_a_delegation(tc: TestClient, conversation_id: str) -> str:
    with tc.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "server_hello"
        subscribe(ws, conversation_id)
        until(ws, "transcript.reset")
        _send(tc, conversation_id, "给这条视频做分镜")
        return _child_of(drain_turn(ws))


def test_a_child_stream_is_read_by_its_agent_id(
    ws_agent_app: FastAPI, pg_url: str, models: dict[str, Model]
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        child_id = _run_a_delegation(tc, conversation_id)

        page = tc.get(f"/conversations/{conversation_id}/transcript", params={"agent_id": child_id})
        assert page.status_code == 200, page.text
        body = page.json()
        assert body["agent_id"] == child_id
        assert [(turn["turnId"], turn["state"]) for turn in body["items"]] == [("t1", "completed")]
        assert body["items"][0]["content"] == [{"type": "text", "text": TASK}]
        assert [agent["agentId"] for agent in body["agents"]] == ["main", child_id]

        catchup = tc.get(
            f"/conversations/{conversation_id}/transcript/ops",
            params={"agent_id": child_id, "since_seq": 0},
        )
        assert catchup.status_code == 200, catchup.text
        assert catchup.json()["agent_id"] == child_id

        other = open_conversation(tc)
        assert (
            tc.get(f"/conversations/{other}/transcript", params={"agent_id": child_id}).status_code
            == 404
        )
        assert (
            tc.get(
                f"/conversations/{conversation_id}/transcript", params={"agent_id": "a/b"}
            ).status_code
            == 422
        )

    async def read_usage() -> dict[str, tuple[int, int, int]]:
        async with connected(pg_url) as conn:
            rows = await conn.execute(
                text(
                    "SELECT model_name, requests, input_tokens, output_tokens "
                    "FROM agent_runtime.conversation_usage WHERE conversation_id = :conversation_id"
                ),
                {"conversation_id": conversation_id},
            )
            return {
                row.model_name: (row.requests, row.input_tokens, row.output_tokens) for row in rows
            }

    usage = asyncio.run(read_usage())
    assert {name: requests for name, (requests, _, _) in usage.items()} == {
        models[TEST_MODEL_NAME].model_name: 2,
        WRITER_MODEL: 1,
    }
    assert all(
        input_tokens > 0 and output_tokens > 0 for _, input_tokens, output_tokens in usage.values()
    )


def test_ws_subscribes_each_agent_in_the_table(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        child_id = _run_a_delegation(tc, conversation_id)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s1",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", child_id: "delta"},
                    },
                }
            )
            resets = {
                until(ws, "transcript.reset")["payload"]["agent_id"],
                until(ws, "transcript.reset")["payload"]["agent_id"],
            }
            assert resets == {"main", child_id}
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]

            ws.send_json(
                {
                    "type": "unsubscribe_v2",
                    "id": "u1",
                    "payload": {"session_id": conversation_id, "agent_ids": [child_id]},
                }
            )
            assert until(ws, "ack")["id"] == "u1"
            _send(tc, conversation_id, "再补一句")
            frames = _drain_frames(ws)
            assert frames and {frame["payload"]["agent_id"] for frame in frames} == {"main"}

            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s2",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", "not-a-run": "delta"},
                    },
                }
            )
            refused = until(ws, "ack")
            assert (refused["id"], refused["code"]) == ("s2", 404)


def test_reopening_a_running_child_picks_up_where_it_is(ws_agent_app: FastAPI, pg_url: str) -> None:
    _GATE.clear()
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "给这条视频做分镜")
            assert _ENTERED.wait(10), "子代理没开口"
            child_id = _child_from_live_frames(ws)

            page = tc.get(
                f"/conversations/{conversation_id}/transcript", params={"agent_id": child_id}
            ).json()
            assert [(turn["turnId"], turn["state"]) for turn in page["items"]] == [
                ("t1", "running")
            ]
            assert _texts(page["items"][0]) == [FIRST_HALF]

            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "s1",
                    "payload": {
                        "session_id": conversation_id,
                        "transcript": {"main": "delta", child_id: "delta"},
                        "transcript_since": {child_id: page["seq"]},
                    },
                }
            )
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            _GATE.set()

            child_frames = [
                frame
                for frame in _drain_frames(ws, until_agent=child_id)
                if frame["payload"]["agent_id"] == child_id
            ]
            appended = "".join(
                op["text"]
                for frame in child_frames
                for op in frame["payload"]["ops"]
                if op["op"] == "append"
            )
            assert appended == SECOND_HALF
            assert [
                op["turn"]["state"]
                for frame in child_frames
                for op in frame["payload"]["ops"]
                if op["op"] == "turn.upsert"
            ][-1] == "completed"


def _child_from_live_frames(ws: Any, *, tries: int = 40) -> str:
    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        for op in frame["payload"]["ops"]:
            if op["op"] == "frame.upsert" and op["frame"].get("agentRefs"):
                return str(op["frame"]["agentRefs"][0]["agentId"])
    raise AssertionError("主流里没等到派出子代理的卡")


def _texts(turn: dict[str, Any]) -> list[str]:
    return [
        frame["text"]
        for step in turn["steps"]
        for frame in step["frames"]
        if frame["kind"] == "text"
    ]


def _drain_frames(ws: Any, *, until_agent: str = "main", tries: int = 80) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        collected.append(frame)
        if frame["payload"]["agent_id"] == until_agent and any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            return collected
    raise AssertionError("这一轮没等到结束")

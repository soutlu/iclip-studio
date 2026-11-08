from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from typing import Any

from starlette.testclient import TestClient

from tests.helpers.auth import set_roles_in_db

AGENT_ID = "storyboard"
PASSWORD = "password-123"
SESSION_COOKIE = "iclip_session"


def sign_in(tc: TestClient, pg_url: str) -> None:
    created = tc.post(
        "/auth/register",
        json={"email": "logan@example.com", "password": PASSWORD, "username": "logan"},
    )
    assert created.status_code == 201, created.text
    asyncio.run(set_roles_in_db(pg_url, "logan@example.com", ["editor"]))
    assert (
        tc.post("/auth/login", data={"username": "logan", "password": PASSWORD}).status_code == 204
    )


def sign_in_as(
    tc: TestClient, pg_url: str, *, username: str, roles: tuple[str, ...]
) -> dict[str, str]:
    email = f"{username}@example.com"
    created = tc.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    assert created.status_code == 201, created.text
    asyncio.run(set_roles_in_db(pg_url, email, list(roles)))
    assert (
        tc.post("/auth/login", data={"username": username, "password": PASSWORD}).status_code == 204
    )
    token = tc.cookies.get(SESSION_COOKIE)
    assert token, "登录没有种下会话 cookie"
    tc.cookies.clear()
    return {"cookie": f"{SESSION_COOKIE}={token}"}


def open_conversation(tc: TestClient, headers: Mapping[str, str] | None = None) -> str:
    created = tc.post("/conversations", json={"agentId": AGENT_ID}, headers=headers)
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


def settled(tc: TestClient, conversation_id: str, *, tries: int = 200) -> None:
    for _ in range(tries):
        queue = tc.get(f"/conversations/{conversation_id}/prompts").json()
        if queue["active"] is None and not queue["queued"]:
            return
        time.sleep(0.02)
    raise AssertionError("这段对话没跑完")


def subscribe(
    ws: Any,
    conversation_id: str,
    *,
    since: int | None = None,
    epoch: str | None = None,
    frame_id: str = "s1",
    grade: str = "delta",
) -> None:
    payload: dict[str, Any] = {
        "session_id": conversation_id,
        "transcript": {"main": grade},
    }
    if since is not None:
        payload["transcript_since"] = {"main": since}
    if epoch is not None:
        payload["transcript_epoch"] = {"main": epoch}
    ws.send_json({"type": "subscribe_v2", "id": frame_id, "payload": payload})


def until(ws: Any, kind: str, *, tries: int = 40) -> dict[str, Any]:
    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") == kind:
            return frame
    raise AssertionError(f"没收到 {kind}")


def drain_turn(ws: Any, *, tries: int = 40) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for _ in range(tries):
        frame = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        ops: list[dict[str, Any]] = frame["payload"]["ops"]
        collected.extend(ops)
        if any(op["op"] == "turn.upsert" and op["turn"]["state"] != "running" for op in ops):
            return collected
    raise AssertionError("这一轮没等到结束")


__all__ = [
    "AGENT_ID",
    "PASSWORD",
    "SESSION_COOKIE",
    "drain_turn",
    "open_conversation",
    "settled",
    "sign_in",
    "sign_in_as",
    "subscribe",
    "until",
]

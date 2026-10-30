"""应用事件流的连接：认不出应用在握手前以 1008 关闭；送达这个应用的事件；出站积压超过上限以 1013 关闭。
只挂事件流的路由与一个查表的集线器，不碰库。"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Generator
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from agent_runtime.http.auth import build_app_auth
from agent_runtime.http.streams import MAX_OUTBOUND, create_events_router
from agent_runtime.live.frames import SessionActivity
from agent_runtime.live.hub import AppEventHub
from agent_runtime.settings import ResolvedApp
from agent_runtime.transcript.wire import SessionActivityOut

BFF_KEY = "bff-app-key-0123456789-0123456789-ab"
TOOL_KEY = "tool-app-key-0123456789-0123456789-a"
BFF_SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
TOOL_SESSION = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"


async def app_of(session_id: str) -> str | None:
    return {BFF_SESSION: "bff", TOOL_SESSION: "tool"}.get(session_id)


def activity(session_id: str, *, busy: bool) -> SessionActivity:
    return SessionActivity(
        session_id=session_id,
        owner_user_id=OWNER,
        activity=SessionActivityOut(busy=busy, pending_interaction="none"),
    )


@pytest.fixture
def hub() -> AppEventHub:
    return AppEventHub(app_of)


@pytest.fixture
def client(hub: AppEventHub) -> Generator[TestClient]:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        await hub.start()
        try:
            yield
        finally:
            await hub.stop()

    app = FastAPI(lifespan=lifespan)
    auth = build_app_auth(
        (
            ResolvedApp(id="bff", key=BFF_KEY, admin=False),
            ResolvedApp(id="tool", key=TOOL_KEY, admin=False),
        )
    )
    app.include_router(create_events_router(auth.identify, hub))
    with TestClient(app) as tc:
        yield tc


def bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def in_app_loop(client: TestClient, action: Callable[[], None]) -> None:
    """在服务的事件循环里同步跑 ``action``：集线器只在那个循环里收事件。"""

    portal = client.portal
    assert portal is not None, "TestClient 要在 with 里用"
    portal.call(action)


@pytest.mark.parametrize("headers", [{}, bearer("not-a-known-key"), {"Authorization": BFF_KEY}])
def test_an_unknown_app_is_refused_before_the_handshake(
    client: TestClient, headers: dict[str, str]
) -> None:
    with (
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect("/v1/events", headers=headers),
    ):
        pass

    assert refused.value.code == 1008


def test_a_connection_receives_only_its_apps_events(client: TestClient, hub: AppEventHub) -> None:
    with client.websocket_connect("/v1/events", headers=bearer(BFF_KEY)) as ws:

        def publish() -> None:
            hub.publish(activity(TOOL_SESSION, busy=True))
            hub.publish(activity(BFF_SESSION, busy=True))

        in_app_loop(client, publish)

        frame = ws.receive_json()

    assert frame == {
        "type": "session.activity",
        "session_id": BFF_SESSION,
        "owner_user_id": OWNER,
        "activity": {"busy": True, "pending_interaction": "none"},
    }


def test_overflowing_the_outbound_queue_closes_the_connection(
    client: TestClient, hub: AppEventHub
) -> None:
    with client.websocket_connect("/v1/events", headers=bearer(BFF_KEY)) as ws:

        def flood() -> None:
            for index in range(MAX_OUTBOUND + 10):
                hub.publish(activity(BFF_SESSION, busy=index % 2 == 0))

        in_app_loop(client, flood)

        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()

    assert closed.value.code == 1013

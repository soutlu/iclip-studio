from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from cue.app_wire import AgentDirectoryOut
from cue.client import RuntimeClient

KEY = "app-key-0123456789-0123456789-abcdef"

WEBSOCKETS = 101


async def _hold(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return


async def _agents(_request: Request) -> JSONResponse:
    return JSONResponse(AgentDirectoryOut(items=(), default=None).model_dump(mode="json"))


@pytest.fixture
async def base_url() -> AsyncIterator[str]:
    app = Starlette(routes=[WebSocketRoute("/v1/ws", _hold), Route("/v1/agents", _agents)])
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, ws="wsproto", lifespan="off", log_config=None)
    )
    serving = asyncio.create_task(server.serve())
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        async with asyncio.timeout(5):
            await serving


async def test_open_websockets_leave_room_for_requests(base_url: str) -> None:
    opened = 0
    all_open = asyncio.Event()
    release = asyncio.Event()

    async with RuntimeClient(base_url, KEY, timeout=httpx.Timeout(2.0)) as client:

        async def hold_one() -> None:
            nonlocal opened
            async with client.connect_transcript():
                opened += 1
                if opened == WEBSOCKETS:
                    all_open.set()
                await release.wait()

        async with asyncio.TaskGroup() as group:
            for _ in range(WEBSOCKETS):
                group.create_task(hold_one())
            try:
                async with asyncio.timeout(5):
                    await all_open.wait()
                directory = await client.agents()
            finally:
                release.set()

    assert directory == AgentDirectoryOut(items=(), default=None)

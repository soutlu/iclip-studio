from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable

import httpx
from fastapi import FastAPI, Request, Response

from iclip.app.errors import install_error_handlers
from iclip.config import (
    AppSection,
    DbSection,
    OpsSection,
    RuntimeConfig,
    SecuritySection,
    SsoSection,
)
from iclip.domains.identity.middleware import bind_principal
from iclip.domains.identity.public import Principal

TEST_MODEL_NAME = "test-model"

TEST_CREDENTIAL_KEY = base64.urlsafe_b64encode(b"test-credential-key-0123456789ab").decode()


def make_runtime_config(
    *, cors_allow_origins: tuple[str, ...] = (), cookie_secure: bool = False
) -> RuntimeConfig:
    return RuntimeConfig(
        app=AppSection(name="iclip-test"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(
            cors_allow_origins=cors_allow_origins, cookie_secure=cookie_secure
        ),
        sso=SsoSection(app_name="iclip"),
        ops=OpsSection(log_level="WARNING"),
    )


def make_client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def app_with_principal(granted: Principal | None) -> FastAPI:
    app = FastAPI()

    @app.middleware("http")
    async def inject_principal(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        bind_principal(request, granted)
        return await call_next(request)

    install_error_handlers(app)
    return app


async def new_conversation(client: httpx.AsyncClient, agent_id: str) -> str:
    created = await client.post("/conversations", json={"agentId": agent_id})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


async def settled(client: httpx.AsyncClient, conversation_id: str, *, tries: int = 200) -> None:
    for _ in range(tries):
        queue = (await client.get(f"/conversations/{conversation_id}/prompts")).json()
        if queue["active"] is None and not queue["queued"]:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段对话没跑完")


__all__ = [
    "TEST_CREDENTIAL_KEY",
    "TEST_MODEL_NAME",
    "app_with_principal",
    "make_client",
    "make_runtime_config",
    "new_conversation",
    "settled",
]

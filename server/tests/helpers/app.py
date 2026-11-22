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
    FinalCutSection,
    ObjectStoreSection,
    OpsSection,
    RuntimeConfig,
    RuntimeServiceSection,
    SecuritySection,
)
from iclip.domains.identity.middleware import bind_principal
from iclip.domains.identity.public import Principal

TEST_MODEL_NAME = "test-model"

TEST_CREDENTIAL_KEY = base64.urlsafe_b64encode(b"test-credential-key-0123456789ab").decode()

RUNTIME_SERVICE_URL = "http://runtime.test"

TEST_OBJECT_STORE = ObjectStoreSection(
    bucket="iclip-test",
    endpoint="oss-ap-southeast-1.aliyuncs.com",
    public_url_base="https://cdn.example.test",
)

OBJECT_STORE_KEYS = {"OSS_ACCESS_KEY_ID": "ak", "OSS_ACCESS_KEY_SECRET": "sk"}
"""开着 ``object_store`` 段时 ``.env`` 里要有的两把密钥。"""


def make_runtime_config(
    *,
    cors_allow_origins: tuple[str, ...] = (),
    cookie_secure: bool = False,
    object_store: ObjectStoreSection | None = None,
    preview_origin: str | None = None,
) -> RuntimeConfig:
    """最小的后端配置：可选功能全关，只按参数开对象存储与 final-cut 预览域名。"""

    return RuntimeConfig(
        app=AppSection(name="iclip-test"),
        db=DbSection(schema="iclip"),
        security=SecuritySection(
            cors_allow_origins=cors_allow_origins, cookie_secure=cookie_secure
        ),
        object_store=object_store,
        final_cut=FinalCutSection(preview_origin=preview_origin),
        runtime=RuntimeServiceSection(url=RUNTIME_SERVICE_URL),
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
    "OBJECT_STORE_KEYS",
    "RUNTIME_SERVICE_URL",
    "TEST_CREDENTIAL_KEY",
    "TEST_MODEL_NAME",
    "TEST_OBJECT_STORE",
    "app_with_principal",
    "make_client",
    "make_runtime_config",
    "new_conversation",
    "settled",
]

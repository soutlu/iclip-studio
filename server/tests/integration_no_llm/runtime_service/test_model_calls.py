from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest
from cue.http.app import create_app
from cue.plugins.base import PluginRegistry
from cue.settings import AgentRunsSection, CompactionSection, ResolvedApp, RuntimeSettings
from fastapi import FastAPI
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine
from structlog.testing import capture_logs

from tests.helpers.agents import model_builder
from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.model_providers import KeyCheckingProbe, add_credential, connect_provider
from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY

MODEL = "doubao-seed-test"
ARK_KEY = "sk-test-ark"
DEFAULT_RESPONSES = "https://ark.cn-beijing.volces.com/api/v3/responses"
SECRET_INPUT = "payload-marker-do-not-log"


class Upstream:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.reply: Any = httpx.Response(200, json={"status": "completed", "output": []})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if isinstance(self.reply, Exception):
            raise self.reply
        assert isinstance(self.reply, httpx.Response)
        return self.reply


@pytest.fixture
def upstream() -> Upstream:
    return Upstream()


@pytest.fixture
def runtime_app(
    engine: AsyncEngine,
    migrated_pg: str,
    tmp_path: Path,
    plugin_registry: PluginRegistry,
    models: Mapping[str, Model],
    upstream: Upstream,
) -> FastAPI:
    settings = RuntimeSettings(
        database_url=migrated_pg,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="bff", key=ADMIN_KEY, admin=True),
            ResolvedApp(id="reader", key=READER_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(
        settings,
        plugins=plugin_registry,
        credential_probe=KeyCheckingProbe(set()),
        engine=engine,
        build_model=model_builder(models),
        model_transport=httpx.MockTransport(upstream),
    )


async def connect_ark(
    admin: httpx.AsyncClient, *, base_url: str | None = None, model_enabled: bool = True
) -> None:
    provider = await connect_provider(admin, "volcengine")
    provider_id = provider["id"]
    if base_url is None:
        await add_credential(admin, provider_id, api_key=ARK_KEY)
    else:
        created = await admin.post(
            f"/model-providers/{provider_id}/credentials",
            json={"name": "中转", "fields": {"api_key": ARK_KEY, "base_url": base_url}},
        )
        assert created.status_code == 201, created.text
    added = await admin.post(
        f"/model-providers/{provider_id}/models",
        json={"name": MODEL, "type": "llm", "api": "responses"},
    )
    assert added.status_code == 201, added.text
    if not model_enabled:
        disabled = await admin.patch(
            f"/model-providers/{provider_id}/models/llm/{MODEL}", json={"enabled": False}
        )
        assert disabled.status_code == 200, disabled.text


def call_body(model: str = MODEL) -> dict[str, Any]:
    return {
        "declaration": "volcengine",
        "model": model,
        "payload": {"model": "whatever-the-caller-wrote", "input": SECRET_INPUT},
    }


async def test_the_app_key_is_required(anonymous: httpx.AsyncClient, upstream: Upstream) -> None:
    response = await anonymous.post("/v1/model-calls/responses", json=call_body())

    assert response.status_code == 401
    assert upstream.requests == []


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, json={"status": "completed", "output": []}),
        httpx.Response(429, json={"error": {"code": "TooManyRequests"}}),
        httpx.Response(400, text="bad request body", headers={"content-type": "text/plain"}),
    ],
    ids=["200", "429", "400"],
)
async def test_the_call_goes_to_the_providers_responses_with_its_key_and_the_answer_comes_back(
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    upstream: Upstream,
    answer: httpx.Response,
) -> None:
    await connect_ark(admin)
    upstream.reply = answer

    response = await app_client.post("/model-calls/responses", json=call_body())

    assert response.status_code == answer.status_code
    assert response.content == answer.content
    assert response.headers["content-type"].startswith(answer.headers["content-type"])
    (sent,) = upstream.requests
    assert str(sent.url) == DEFAULT_RESPONSES
    assert sent.headers["Authorization"] == f"Bearer {ARK_KEY}"
    assert json.loads(sent.content) == {"model": MODEL, "input": SECRET_INPUT}
    assert sent.extensions["timeout"]["read"] >= 900


async def test_a_custom_base_url_is_where_the_call_goes(
    admin: httpx.AsyncClient, app_client: httpx.AsyncClient, upstream: Upstream
) -> None:
    await connect_ark(admin, base_url="https://relay.example/api/v3")

    response = await app_client.post("/model-calls/responses", json=call_body())

    assert response.status_code == 200
    assert str(upstream.requests[0].url) == "https://relay.example/api/v3/responses"


@pytest.mark.parametrize("model_enabled", [True, False], ids=["other-model", "model-disabled"])
async def test_without_a_usable_connection_it_is_model_unavailable(
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    upstream: Upstream,
    model_enabled: bool,
) -> None:
    await connect_ark(admin, model_enabled=model_enabled)
    asked = "doubao-seed-other" if model_enabled else MODEL

    response = await app_client.post("/model-calls/responses", json=call_body(asked))

    assert response.status_code == 409
    assert response.json() == {
        "detail": f"配置页的火山方舟里没有启用的模型 {asked}（或没有默认密钥）",
        "code": "model_unavailable",
    }
    assert upstream.requests == []


@pytest.mark.parametrize(
    ("failure", "status", "code"),
    [
        (httpx.ReadTimeout("timed out"), 504, "upstream_timeout"),
        (httpx.ConnectError("refused"), 502, "upstream_unreachable"),
    ],
    ids=["timeout", "unreachable"],
)
async def test_upstream_failures_have_their_own_codes_and_the_logs_hold_no_key_or_payload(
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    upstream: Upstream,
    failure: Exception,
    status: int,
    code: str,
) -> None:
    await connect_ark(admin)
    upstream.reply = failure

    with capture_logs() as logs:
        response = await app_client.post("/model-calls/responses", json=call_body())
        upstream.reply = httpx.Response(200, json={"status": "completed", "output": []})
        await app_client.post("/model-calls/responses", json=call_body())

    assert response.status_code == status
    assert response.json()["code"] == code
    assert [entry["model"] for entry in logs if entry.get("declaration") == "volcengine"] == [MODEL]
    assert ARK_KEY not in repr(logs)
    assert SECRET_INPUT not in repr(logs)

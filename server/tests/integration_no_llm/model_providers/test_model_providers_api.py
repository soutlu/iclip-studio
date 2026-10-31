"""模型供应商端点：只有 ``model:manage``（预置角色里只有 root）能用；密钥保存前先试连、机密字段只以打码形式
返回、没给的机密字段保持原值、默认密钥不能删；声明里的模型默认启用、能停用，自己加的模型按声明规则校验；
默认模型必须存在且已启用。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from agent_runtime.config.agent_config.infra_sql import SqlAgentStore
from agent_runtime.config.agent_config.public import AgentReferences
from agent_runtime.config.model_providers.catalog import Declarations, load_declarations
from agent_runtime.config.model_providers.cipher import CredentialCipher
from agent_runtime.config.model_providers.infra_sql import SqlModelProviderStore
from agent_runtime.config.model_providers.schemas import CustomModelCreateIn, ModelProviderCreateIn
from agent_runtime.config.model_providers.service import ModelProviderService
from agent_runtime.errors import ValidationFailed
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_CREDENTIAL_KEY, make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.model_providers import (
    BAD_KEY,
    GOOD_KEY,
    OTHER_KEY,
    KeyCheckingProbe,
    add_credential,
    connect_bailian,
)

SECRETS = (GOOD_KEY, OTHER_KEY, BAD_KEY)
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


@pytest.fixture
async def root(
    engine: AsyncEngine, app: FastAPI, migrated_pg: str
) -> AsyncGenerator[httpx.AsyncClient]:
    """``engine`` 夹具建起时会清表，先于登录建好，免得把刚注册的 root 清掉。"""

    async with make_client(app) as client:
        await register_and_login(client, username="root", email="root@example.com")
        await set_roles_in_db(migrated_pg, "root@example.com", ["root"])
        yield client


def assert_no_plaintext(response: httpx.Response) -> None:
    for secret in SECRETS:
        assert secret not in response.text, f"{response.request.url} 答复里有明文"


async def provider_view(client: httpx.AsyncClient, provider_id: str) -> dict[str, Any]:
    response = await client.get("/model-providers")
    assert response.status_code == 200, response.text
    assert_no_plaintext(response)
    (found,) = [one for one in response.json()["providers"] if one["id"] == provider_id]
    return found


def model_of(provider: dict[str, Any], name: str) -> dict[str, Any]:
    (found,) = [one for one in provider["models"] if one["name"] == name]
    return found


async def stored_fields(engine: AsyncEngine, credential_id: str) -> dict[str, str]:
    async with engine.connect() as conn:
        raw = (
            await conn.execute(
                text("SELECT fields FROM agent_runtime.provider_credentials WHERE id = :id"),
                {"id": uuid.UUID(credential_id)},
            )
        ).scalar_one()
    return raw if isinstance(raw, dict) else json.loads(raw)


ENDPOINTS: tuple[tuple[str, str, dict[str, Any] | None], ...] = (
    ("GET", "/model-providers/declarations", None),
    ("GET", "/model-providers", None),
    ("POST", "/model-providers", {"name": "x", "provider": "bailian", "label": "x"}),
    ("PATCH", "/model-providers/{pid}", {"label": "x"}),
    ("POST", "/model-providers/{pid}/credentials", {"name": "x", "fields": {"api_key": GOOD_KEY}}),
    ("POST", "/model-providers/{pid}/credentials/test", {"fields": {"api_key": GOOD_KEY}}),
    ("PATCH", "/model-providers/{pid}/credentials/{cid}", {"name": "x"}),
    ("DELETE", "/model-providers/{pid}/credentials/{cid}", None),
    ("POST", "/model-providers/{pid}/models", {"name": "m", "type": "llm", "api": "chat"}),
    ("PATCH", "/model-providers/{pid}/models/llm/ZHIPU/GLM-5.3-Flash", {"enabled": False}),
    ("DELETE", "/model-providers/{pid}/models/llm/custom-1", None),
    ("GET", "/default-models", None),
    ("PUT", "/default-models/llm", {"providerId": "{pid}", "modelName": "qwen3.8-flash"}),
)


async def test_only_model_managers_reach_any_endpoint(
    app: FastAPI, root: httpx.AsyncClient, migrated_pg: str
) -> None:
    provider = await connect_bailian(root)
    credential = await add_credential(root, provider["id"])
    async with make_client(app) as editor:
        await login_as_editor(editor, migrated_pg)
        for method, template, body in ENDPOINTS:
            path = template.format(pid=provider["id"], cid=credential["id"])
            payload = (
                json.loads(json.dumps(body).replace("{pid}", provider["id"]))
                if body is not None
                else None
            )
            response = await editor.request(method, path, json=payload)
            assert response.status_code == 403, (method, path, response.text)

    assert (await root.get("/model-providers/declarations")).status_code == 200
    assert (await root.get("/default-models")).status_code == 200


async def test_declarations_describe_the_credential_form_and_models(
    root: httpx.AsyncClient,
) -> None:
    response = await root.get("/model-providers/declarations")

    assert response.status_code == 200, response.text
    (bailian,) = response.json()["declarations"]
    assert bailian["name"] == "bailian"
    assert bailian["customModels"] is True
    assert [field["name"] for field in bailian["credentialFields"]] == ["api_key", "base_url"]
    assert bailian["credentialFields"][1]["default"] == DEFAULT_BASE_URL
    assert {model["name"]: model["api"] for model in bailian["models"]} == {
        "qwen3.8-flash": "responses",
        "ZHIPU/GLM-5.3-Flash": "chat",
    }
    assert "pydanticAiProvider" not in bailian


async def test_connecting_checks_the_name_and_the_declaration(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    assert provider["enabled"] is True
    assert provider["credentials"] == []
    assert provider["defaultCredentialId"] is None
    assert [model["enabled"] for model in provider["models"]] == [True, True]

    for body in (
        {"name": "Bailian", "provider": "bailian", "label": "x"},
        {"name": "bai lian", "provider": "bailian", "label": "x"},
        {"name": "other", "provider": "nope", "label": "x"},
        {"name": "other", "provider": "bailian", "label": "  "},
        {"name": "bailian-main", "provider": "bailian", "label": "x"},
    ):
        response = await root.post("/model-providers", json=body)
        assert response.status_code == 422, (body, response.text)


async def test_first_credential_becomes_default_and_secrets_come_back_masked(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)

    created = await root.post(
        f"/model-providers/{provider['id']}/credentials",
        json={"name": "主账号", "fields": {"api_key": GOOD_KEY}},
    )
    second = await root.post(
        f"/model-providers/{provider['id']}/credentials",
        json={"name": "备用", "fields": {"api_key": OTHER_KEY, "base_url": "https://b.test/v1"}},
    )

    for response in (created, second):
        assert response.status_code == 201, response.text
        assert_no_plaintext(response)
    assert created.json()["fields"] == {"api_key": "••••abcd", "base_url": DEFAULT_BASE_URL}
    view = await provider_view(root, provider["id"])
    assert view["defaultCredentialId"] == created.json()["id"]
    assert [one["name"] for one in view["credentials"]] == ["备用", "主账号"]


async def test_failed_probe_saves_nothing(root: httpx.AsyncClient, engine: AsyncEngine) -> None:
    provider = await connect_bailian(root)

    response = await root.post(
        f"/model-providers/{provider['id']}/credentials",
        json={"name": "主账号", "fields": {"api_key": BAD_KEY}},
    )

    assert response.status_code == 422
    assert "试连没通过" in response.json()["detail"]
    assert_no_plaintext(response)
    view = await provider_view(root, provider["id"])
    assert view["credentials"] == []
    assert view["defaultCredentialId"] is None


async def test_secret_fields_are_encrypted_at_rest(
    root: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    provider = await connect_bailian(root)
    credential = await add_credential(root, provider["id"])

    stored = await stored_fields(engine, credential["id"])

    assert stored["base_url"] == DEFAULT_BASE_URL
    assert stored["api_key"] != GOOD_KEY
    assert CredentialCipher([TEST_CREDENTIAL_KEY]).decrypt(stored["api_key"]) == GOOD_KEY


async def test_unsent_secret_fields_keep_their_value(
    root: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    provider = await connect_bailian(root)
    credential = await add_credential(root, provider["id"])
    path = f"/model-providers/{provider['id']}/credentials/{credential['id']}"

    # 试连替身只认 GOOD_KEY：改地址时没给 api_key，能通过就说明试连拿到的是原来那把。
    moved = await root.patch(path, json={"fields": {"base_url": "https://moved.test/v1"}})

    assert moved.status_code == 200, moved.text
    assert_no_plaintext(moved)
    assert moved.json()["fields"] == {"api_key": "••••abcd", "base_url": "https://moved.test/v1"}
    stored = await stored_fields(engine, credential["id"])
    assert CredentialCipher([TEST_CREDENTIAL_KEY]).decrypt(stored["api_key"]) == GOOD_KEY

    renamed = await root.patch(path, json={"name": "改了名"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "改了名"

    rejected = await root.patch(path, json={"fields": {"api_key": BAD_KEY}})
    assert rejected.status_code == 422
    assert_no_plaintext(rejected)
    assert (
        CredentialCipher([TEST_CREDENTIAL_KEY]).decrypt(
            (await stored_fields(engine, credential["id"]))["api_key"]
        )
        == GOOD_KEY
    )

    replaced = await root.patch(path, json={"fields": {"api_key": OTHER_KEY}})
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["fields"]["api_key"] == "••••wxyz"


async def test_fields_are_checked_against_the_declaration(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    credentials = f"/model-providers/{provider['id']}/credentials"

    missing = await root.post(credentials, json={"name": "a", "fields": {"base_url": "https://x"}})
    blank = await root.post(credentials, json={"name": "a", "fields": {"api_key": "  "}})
    unknown = await root.post(
        credentials, json={"name": "a", "fields": {"api_key": GOOD_KEY, "region": "cn"}}
    )
    for response in (missing, blank, unknown):
        assert response.status_code == 422, response.text
        assert_no_plaintext(response)
    assert "API Key" in missing.json()["detail"]
    assert "region" in unknown.json()["detail"]

    credential = await add_credential(root, provider["id"])
    path = f"{credentials}/{credential['id']}"
    for fields in ({"region": "cn"}, {"api_key": ""}):
        response = await root.patch(path, json={"fields": fields})
        assert response.status_code == 422, (fields, response.text)

    duplicate = await root.post(
        credentials, json={"name": "主账号", "fields": {"api_key": GOOD_KEY}}
    )
    assert duplicate.status_code == 422


async def test_default_credential_cannot_be_deleted_until_replaced(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)
    first = await add_credential(root, provider["id"])
    second = await add_credential(root, provider["id"], name="备用", api_key=OTHER_KEY)
    base = f"/model-providers/{provider['id']}"

    refused = await root.delete(f"{base}/credentials/{first['id']}")
    assert refused.status_code == 409

    foreign = await root.patch(base, json={"defaultCredentialId": str(uuid.uuid4())})
    assert foreign.status_code == 422
    switched = await root.patch(base, json={"defaultCredentialId": second["id"]})
    assert switched.status_code == 200, switched.text
    assert switched.json()["defaultCredentialId"] == second["id"]
    assert_no_plaintext(switched)

    deleted = await root.delete(f"{base}/credentials/{first['id']}")
    assert deleted.status_code == 204
    view = await provider_view(root, provider["id"])
    assert [one["id"] for one in view["credentials"]] == [second["id"]]


async def test_probe_endpoint_tries_saved_or_unsaved_fields_without_saving(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)
    credential = await add_credential(root, provider["id"])
    path = f"/model-providers/{provider['id']}/credentials/test"

    saved = await root.post(path, json={"credentialId": credential["id"]})
    unsaved = await root.post(path, json={"fields": {"api_key": BAD_KEY}})
    overlaid = await root.post(
        path, json={"credentialId": credential["id"], "fields": {"base_url": "https://x.test"}}
    )
    neither = await root.post(path, json={})

    assert saved.status_code == 200, saved.text
    assert saved.json() == {"ok": True, "elapsedMs": 7, "reason": None}
    assert unsaved.status_code == 200, unsaved.text
    assert unsaved.json()["ok"] is False
    assert unsaved.json()["reason"]
    assert overlaid.json()["ok"] is True
    assert neither.status_code == 422
    for response in (saved, unsaved, overlaid, neither):
        assert_no_plaintext(response)
    view = await provider_view(root, provider["id"])
    assert view["credentials"][0]["fields"]["base_url"] == DEFAULT_BASE_URL


async def test_probe_needs_an_enabled_llm_model(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    base = f"/model-providers/{provider['id']}"
    for name in ("qwen3.8-flash", "ZHIPU/GLM-5.3-Flash"):
        response = await root.patch(f"{base}/models/llm/{name}", json={"enabled": False})
        assert response.status_code == 200, response.text

    response = await root.post(
        f"{base}/credentials", json={"name": "a", "fields": {"api_key": GOOD_KEY}}
    )

    assert response.status_code == 422
    assert "llm" in response.json()["detail"]


async def test_declared_models_are_enabled_until_disabled(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    path = f"/model-providers/{provider['id']}/models/llm/ZHIPU/GLM-5.3-Flash"

    disabled = await root.patch(path, json={"enabled": False})
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["enabled"] is False
    assert disabled.json()["source"] == "declared"
    assert (
        model_of(await provider_view(root, provider["id"]), "ZHIPU/GLM-5.3-Flash")["enabled"]
        is False
    )

    enabled = await root.patch(path, json={"enabled": True})
    assert enabled.json()["enabled"] is True
    assert (
        model_of(await provider_view(root, provider["id"]), "ZHIPU/GLM-5.3-Flash")["enabled"]
        is True
    )

    properties = await root.patch(path, json={"contextSize": 10})
    assert properties.status_code == 422
    removed = await root.delete(path)
    assert removed.status_code == 422
    unknown = await root.patch(
        f"/model-providers/{provider['id']}/models/llm/no-such", json={"enabled": False}
    )
    assert unknown.status_code == 404


async def test_custom_models_follow_the_declaration_rules(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    models = f"/model-providers/{provider['id']}/models"

    added = await root.post(
        models,
        json={"name": "qwen-max", "type": "llm", "api": "chat", "thinking": ["none", "high"]},
    )
    assert added.status_code == 201, added.text
    assert added.json() == {
        "name": "qwen-max",
        "type": "llm",
        "api": "chat",
        "contextSize": None,
        "thinking": ["none", "high"],
        "source": "custom",
        "enabled": True,
        "usedBy": [],
    }

    for body in (
        {"name": "x", "type": "llm", "api": "chat", "thinking": ["turbo"]},
        {"name": "x", "type": "llm", "api": "chat", "thinking": ["high", "high"]},
        {"name": "x", "type": "llm"},
        {"name": "x", "type": "embedding", "api": "chat"},
        {"name": "x", "type": "embedding", "thinking": ["high"]},
        {"name": "qwen-max", "type": "llm", "api": "responses"},
        {"name": "qwen3.8-flash", "type": "llm", "api": "chat"},
    ):
        response = await root.post(models, json=body)
        assert response.status_code == 422, (body, response.text)

    embedding = await root.post(models, json={"name": "qwen-max", "type": "embedding"})
    assert embedding.status_code == 201, embedding.text

    path = f"{models}/llm/qwen-max"
    changed = await root.patch(path, json={"thinking": ["low"], "contextSize": 32768})
    assert changed.status_code == 200, changed.text
    assert changed.json()["thinking"] == ["low"]
    assert changed.json()["contextSize"] == 32768
    bad_thinking = await root.patch(path, json={"thinking": ["turbo"]})
    assert bad_thinking.status_code == 422
    disabled = await root.patch(path, json={"enabled": False})
    assert disabled.json()["enabled"] is False
    assert model_of(await provider_view(root, provider["id"]), "qwen3.8-flash")["enabled"] is True

    deleted = await root.delete(path)
    assert deleted.status_code == 204
    names = [
        (one["name"], one["type"]) for one in (await provider_view(root, provider["id"]))["models"]
    ]
    assert names == [
        ("qwen3.8-flash", "llm"),
        ("ZHIPU/GLM-5.3-Flash", "llm"),
        ("qwen-max", "embedding"),
    ]


async def test_default_model_must_exist_and_be_enabled(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    base = f"/model-providers/{provider['id']}"

    for body in (
        {"providerId": provider["id"], "modelName": "no-such"},
        {"providerId": str(uuid.uuid4()), "modelName": "qwen3.8-flash"},
    ):
        response = await root.put("/default-models/llm", json=body)
        assert response.status_code == 422, (body, response.text)

    await root.patch(f"{base}/models/llm/ZHIPU/GLM-5.3-Flash", json={"enabled": False})
    disabled = await root.put(
        "/default-models/llm",
        json={"providerId": provider["id"], "modelName": "ZHIPU/GLM-5.3-Flash"},
    )
    assert disabled.status_code == 422

    chosen = await root.put(
        "/default-models/llm", json={"providerId": provider["id"], "modelName": "qwen3.8-flash"}
    )
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["providerName"] == "bailian-main"
    listed = await root.get("/default-models")
    assert [(one["type"], one["modelName"]) for one in listed.json()["defaults"]] == [
        ("llm", "qwen3.8-flash")
    ]

    refused = await root.patch(f"{base}/models/llm/qwen3.8-flash", json={"enabled": False})
    assert refused.status_code == 409


async def test_a_custom_default_model_cannot_be_deleted(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    models = f"/model-providers/{provider['id']}/models"
    await root.post(models, json={"name": "qwen-max", "type": "llm", "api": "chat"})
    await root.put(
        "/default-models/llm", json={"providerId": provider["id"], "modelName": "qwen-max"}
    )

    assert (await root.delete(f"{models}/llm/qwen-max")).status_code == 409
    assert (await root.patch(f"{models}/llm/qwen-max", json={"enabled": False})).status_code == 409


async def test_provider_updates_keep_what_was_not_sent(root: httpx.AsyncClient) -> None:
    provider = await connect_bailian(root)
    base = f"/model-providers/{provider['id']}"

    relabeled = await root.patch(base, json={"label": "百炼生产"})
    paused = await root.patch(base, json={"enabled": False})

    assert relabeled.json()["label"] == "百炼生产"
    assert paused.json() | {"updatedAt": None} == relabeled.json() | {
        "enabled": False,
        "updatedAt": None,
    }
    assert (
        await root.patch(f"/model-providers/{uuid.uuid4()}", json={"label": "x"})
    ).status_code == 404


async def test_declaration_without_custom_models_refuses_them(engine: AsyncEngine) -> None:
    shipped = load_declarations()["bailian"]
    closed = shipped.model_copy(update={"name": "closed", "custom_models": False})
    service = ModelProviderService(
        SqlModelProviderStore(engine),
        declarations=Declarations({"closed": closed}),
        cipher=CredentialCipher([TEST_CREDENTIAL_KEY]),
        probe=KeyCheckingProbe({GOOD_KEY}),
        usages=AgentReferences(SqlAgentStore(engine)),
    )
    provider = await service.create(
        ModelProviderCreateIn(name="closed", provider="closed", label="封闭")
    )

    with pytest.raises(ValidationFailed, match="不能自己加模型"):
        await service.add_model(provider.id, CustomModelCreateIn(name="m", type="llm", api="chat"))

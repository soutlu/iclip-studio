from __future__ import annotations

import base64
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest

from cue.config.model_providers.catalog import load_declarations
from cue.config.model_providers.models import (
    SOURCE_CUSTOM,
    CredentialRecord,
    ModelProperties,
    ModelSetting,
    ProviderRecord,
    ProviderState,
)
from cue.config.model_providers.repository import (
    CredentialProbe,
    ModelProviderStore,
    ModelUsages,
)
from cue.config.model_providers.rules import encrypt_fields, new_fields
from cue.config.model_providers.service import ModelProviderService
from cue.errors import ModelUnavailable
from cue.model_connections import ModelConnection
from cue.secrets import CredentialCipher

DECLARATIONS = load_declarations()
ARK = DECLARATIONS["volcengine"]
CIPHER = CredentialCipher([base64.urlsafe_b64encode(b"connections-test-key-0123456789a").decode()])
MODEL = "doubao-seed-test"
DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3"
T0 = datetime(2026, 11, 1, tzinfo=UTC)


def provider(
    *,
    key: str = "sk-test-ark",
    base_url: str | None = None,
    enabled: bool = True,
    model_enabled: bool | None = True,
    default_key: bool = True,
    declaration: str = "volcengine",
    created_at: datetime = T0,
    provider_id: uuid.UUID | None = None,
) -> ProviderState:
    pid = provider_id or uuid.uuid4()
    given = {"api_key": key} if base_url is None else {"api_key": key, "base_url": base_url}
    credential = CredentialRecord(
        id=uuid.uuid4(),
        provider_id=pid,
        name="默认",
        fields=encrypt_fields(ARK, new_fields(ARK, given), CIPHER),
        created_by=uuid.uuid4(),
        created_at=created_at,
        updated_at=created_at,
    )
    settings = (
        ()
        if model_enabled is None
        else (
            ModelSetting(
                name=MODEL,
                type="llm",
                source=SOURCE_CUSTOM,
                properties=ModelProperties(api="responses", context_size=None, thinking=()),
                enabled=model_enabled,
            ),
        )
    )
    return ProviderState(
        provider=ProviderRecord(
            id=pid,
            name=f"ark-{pid.hex[:6]}",
            provider=declaration,
            label="火山方舟",
            default_credential_id=credential.id if default_key else None,
            enabled=enabled,
            created_at=created_at,
            updated_at=created_at,
        ),
        credentials=(credential,),
        settings=settings,
    )


class FixedStore:
    def __init__(self, states: Sequence[ProviderState]) -> None:
        self._states = tuple(states)

    async def states(self) -> tuple[ProviderState, ...]:
        return self._states


def service(*states: ProviderState) -> ModelProviderService:
    return ModelProviderService(
        cast("ModelProviderStore", FixedStore(states)),
        declarations=DECLARATIONS,
        cipher=CIPHER,
        probe=cast("CredentialProbe", None),
        usages=cast("ModelUsages", None),
    )


async def connection(*states: ProviderState) -> ModelConnection:
    return await service(*states).responses_connection("volcengine", MODEL)


async def test_an_enabled_provider_with_the_enabled_model_and_a_default_key_gives_its_connection() -> (
    None
):
    found = await connection(provider(key="sk-test-ark"))

    assert found == ModelConnection(
        responses_url=f"{DEFAULT_BASE}/responses", api_key="sk-test-ark"
    )
    assert "sk-test-ark" not in repr(found)


@pytest.mark.parametrize(
    "unusable",
    [
        pytest.param({"enabled": False}, id="provider-disabled"),
        pytest.param({"model_enabled": False}, id="model-disabled"),
        pytest.param({"model_enabled": None}, id="model-missing"),
        pytest.param({"default_key": False}, id="no-default-key"),
        pytest.param({"declaration": "openai-compatible"}, id="other-declaration"),
    ],
)
async def test_unusable_providers_are_skipped(unusable: dict[str, Any]) -> None:
    skipped = provider(key="sk-test-skipped", created_at=T0, **unusable)
    usable = provider(key="sk-test-usable", created_at=T0 + timedelta(days=1))

    assert (await connection(skipped, usable)).api_key == "sk-test-usable"
    with pytest.raises(ModelUnavailable) as raised:
        await connection(skipped)
    assert str(raised.value) == f"配置页的火山方舟里没有启用的模型 {MODEL}（或没有默认密钥）"
    assert raised.value.code == "model_unavailable"


async def test_between_two_usable_providers_the_earliest_connected_wins_whatever_the_order() -> (
    None
):
    older = provider(key="sk-test-older", created_at=T0)
    newer = provider(key="sk-test-newer", created_at=T0 + timedelta(hours=1))
    first = provider(key="sk-test-first", created_at=T0, provider_id=uuid.UUID(int=1))
    second = provider(key="sk-test-second", created_at=T0, provider_id=uuid.UUID(int=2))

    assert (await connection(newer, older)).api_key == "sk-test-older"
    assert (await connection(older, newer)).api_key == "sk-test-older"
    assert (await connection(second, first)).api_key == "sk-test-first"


@pytest.mark.parametrize(
    ("base_url", "responses_url"),
    [
        pytest.param(None, f"{DEFAULT_BASE}/responses", id="default"),
        pytest.param(
            "https://relay.example/api/v3/", "https://relay.example/api/v3/responses", id="custom"
        ),
    ],
)
async def test_the_address_is_the_keys_base_url_plus_responses(
    base_url: str | None, responses_url: str
) -> None:
    assert (await connection(provider(base_url=base_url))).responses_url == responses_url


async def test_a_declaration_the_code_does_not_ship_is_a_programming_error() -> None:
    with pytest.raises(RuntimeError, match="no-such"):
        await service(provider()).responses_connection("no-such", MODEL)

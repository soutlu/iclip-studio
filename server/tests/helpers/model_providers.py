from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx
from cue.config.model_providers.public import (
    ProbeResult,
    ProviderDeclaration,
    ProviderModel,
)

GOOD_KEY = "sk-good-0123456789abcd"
OTHER_KEY = "sk-other-0000000000wxyz"
BAD_KEY = "sk-bad-5555555555bad1"


class KeyCheckingProbe:
    def __init__(self, accepted: set[str]) -> None:
        self.accepted = accepted
        self.calls: list[tuple[str, str | None]] = []

    async def probe(
        self, declaration: ProviderDeclaration, model: ProviderModel, fields: Mapping[str, str]
    ) -> ProbeResult:
        self.calls.append((model.name, fields.get("api_key")))
        if fields.get("api_key") in self.accepted:
            return ProbeResult(ok=True, elapsed_ms=7)
        return ProbeResult(ok=False, elapsed_ms=3, reason="API Key 无效或没有权限（HTTP 401）")


async def connect_provider(
    client: httpx.AsyncClient, provider: str, name: str | None = None
) -> dict[str, Any]:
    response = await client.post(
        "/model-providers",
        json={"name": name or f"{provider}-main", "provider": provider, "label": provider},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def connect_bailian(client: httpx.AsyncClient, name: str = "bailian-main") -> dict[str, Any]:
    response = await client.post(
        "/model-providers", json={"name": name, "provider": "bailian", "label": "百炼"}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def add_credential(
    client: httpx.AsyncClient, provider_id: str, *, name: str = "主账号", api_key: str = GOOD_KEY
) -> dict[str, Any]:
    response = await client.post(
        f"/model-providers/{provider_id}/credentials",
        json={"name": name, "fields": {"api_key": api_key}},
    )
    assert response.status_code == 201, response.text
    return response.json()


__all__ = [
    "BAD_KEY",
    "GOOD_KEY",
    "OTHER_KEY",
    "KeyCheckingProbe",
    "add_credential",
    "connect_bailian",
    "connect_provider",
]

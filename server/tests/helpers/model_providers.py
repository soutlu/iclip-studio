"""模型供应商测试的替身与常量：只认几把 API Key 的试连，以及接入供应商、建密钥的 HTTP 驱动。"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from iclip.domains.model_providers.public import ProbeResult, ProviderDeclaration, ProviderModel

GOOD_KEY = "sk-good-0123456789abcd"
OTHER_KEY = "sk-other-0000000000wxyz"
BAD_KEY = "sk-bad-5555555555bad1"


class KeyCheckingProbe:
    """只认 ``accepted`` 里的 API Key：认得就通，不认得就答「API Key 无效」。"""

    def __init__(self, accepted: set[str]) -> None:
        self.accepted = accepted

    async def probe(
        self, declaration: ProviderDeclaration, model: ProviderModel, fields: Mapping[str, str]
    ) -> ProbeResult:
        if fields.get("api_key") in self.accepted:
            return ProbeResult(ok=True, elapsed_ms=7)
        return ProbeResult(ok=False, elapsed_ms=3, reason="API Key 无效或没有权限（HTTP 401）")


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
]

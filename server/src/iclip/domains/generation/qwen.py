from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.upstream import post_json


@dataclass(frozen=True, slots=True)
class QwenEndpoint:
    url: str
    api_key: str
    timeout_seconds: float


async def post_to_qwen(
    endpoint: QwenEndpoint,
    payload: dict[str, Any],
    *,
    label: str,
    transport: httpx.AsyncBaseTransport | None,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    return await post_json(
        endpoint.url,
        payload,
        label=label,
        timeout=endpoint.timeout_seconds,
        transport=transport,
        headers={"Authorization": f"Bearer {endpoint.api_key}", **(headers or {})},
    )


def request_id_of(body: Mapping[str, Any], *, label: str) -> str:
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip():
        raise ProviderError(
            f"{label}响应里的 request_id 必须是非空字符串",
            code="PROVIDER_MALFORMED",
            retryable=False,
        )
    return request_id


__all__ = ["QwenEndpoint", "post_to_qwen", "request_id_of"]

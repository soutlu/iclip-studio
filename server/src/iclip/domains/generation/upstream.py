from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from iclip.domains.generation.provider import ProviderError


class UpstreamRejected(ProviderError):
    def __init__(self, message: str, *, status_code: int, body: object) -> None:
        super().__init__(message, code="PROVIDER_REJECTED", retryable=False)
        self.status_code = status_code
        self.body = body


async def post_json(
    url: str,
    payload: dict[str, Any],
    *,
    label: str,
    timeout: float,
    transport: httpx.AsyncBaseTransport | None,
    headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
            response = await client.post(url, json=payload, headers=dict(headers or {}))
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise ProviderError(
            f"{label}接口连不上: {exc}", code="PROVIDER_UNREACHABLE", retryable=True
        ) from exc
    except httpx.HTTPError as exc:
        raise ProviderError(
            f"{label}请求已发出但没拿到结果，不重试以免重复计费: {exc}",
            code="PROVIDER_RESULT_UNKNOWN",
            retryable=False,
        ) from exc
    if response.status_code >= 500:
        raise ProviderError(
            f"{label}接口返回 {response.status_code}: {response.text[:500]}",
            code="PROVIDER_SERVER_ERROR",
            retryable=True,
        )
    if response.status_code >= 400:
        raise UpstreamRejected(
            f"{label}接口拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
            status_code=response.status_code,
            body=_json_or_none(response),
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderError(
            f"{label}接口的响应不是 JSON", code="PROVIDER_MALFORMED", retryable=False
        ) from exc
    if not isinstance(body, dict):
        raise ProviderError(
            f"{label}接口的响应根不是 object", code="PROVIDER_MALFORMED", retryable=False
        )
    return body


def _json_or_none(response: httpx.Response) -> object:
    try:
        return response.json()
    except ValueError:
        return None


__all__ = ["UpstreamRejected", "post_json"]

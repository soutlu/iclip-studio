from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from iclip.common.urls import is_http_url
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.upstream import post_json


@dataclass(frozen=True, slots=True)
class QwenEndpoint:
    url: str
    timeout_seconds: float


async def post_to_qwen(
    endpoint: QwenEndpoint,
    payload: dict[str, Any],
    *,
    api_key: str,
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
        headers={"Authorization": f"Bearer {api_key}", **(headers or {})},
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


def audio_url_of(body: Mapping[str, Any], *, label: str) -> str:
    """音频生成接口（``SpeechSynthesizer``）响应里生成结果的下载地址 ``output.audio.url``。"""

    output = body.get("output")
    audio = output.get("audio") if isinstance(output, Mapping) else None
    url = audio.get("url") if isinstance(audio, Mapping) else None
    if not isinstance(url, str) or not is_http_url(url):
        raise ProviderError(
            f"{label}接口的响应里没有音频地址（output.audio.url）",
            code="PROVIDER_MALFORMED",
            retryable=False,
        )
    return url


__all__ = ["QwenEndpoint", "audio_url_of", "post_to_qwen", "request_id_of"]

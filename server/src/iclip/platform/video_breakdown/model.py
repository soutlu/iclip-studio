from __future__ import annotations

import base64
import json
from typing import Any, Final

import httpx

from iclip.common.errors import ModelUnavailable
from iclip.platform.runtime_api.app_wire import MODEL_CALL_TIMEOUT_SECONDS, ModelCallIn
from iclip.platform.runtime_api.client import (
    AppRejected,
    ModelCallResponse,
    ModelCallTimedOut,
    RuntimeClient,
    RuntimeUnavailable,
)
from iclip.platform.video_breakdown.media import FRAME_FPS, FRAME_MAX_PIXELS
from iclip.platform.video_breakdown.ports import (
    BreakdownError,
    BreakdownModelUnavailable,
    SampledVideo,
)
from iclip.platform.video_breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE

DECLARATION: Final = "volcengine"

BREAKDOWN_MODEL: Final = "doubao-seed-2-1-lite-260915"

TIMEOUT_SECONDS: Final = 900.0

_RUNTIME_MARGIN_SECONDS: Final = 60.0

_RUNTIME_CONNECT_SECONDS: Final = 5.0

REASONING_EFFORT: Final = "high"

MAX_OUTPUT_TOKENS: Final = 65_536

NATIVE_FPS: Final = 5

_FRAME_MIN_PIXELS: Final = 1_764


class ArkBreakdownModel:
    def __init__(self, runtime: RuntimeClient, *, model: str) -> None:
        self._runtime = runtime
        self._model = model

    async def from_sample(self, sample: SampledVideo) -> str:
        return await self._ask(sampled_content(sample))

    async def from_url(self, video_url: str) -> str:
        return await self._ask(
            [
                {"type": "input_video", "video_url": video_url, "fps": NATIVE_FPS},
                {"type": "input_text", "text": USER_MESSAGE},
            ]
        )

    async def ask_text(
        self,
        system: str,
        text: str,
        *,
        reasoning_effort: str,
        max_output_tokens: int,
        text_format: dict[str, Any] | None = None,
        timeout: float = TIMEOUT_SECONDS,
    ) -> str:
        return await self._ask(
            [{"type": "input_text", "text": text}],
            system=system,
            reasoning_effort=reasoning_effort,
            max_output_tokens=max_output_tokens,
            text_format=text_format,
            timeout=timeout,
        )

    async def _ask(
        self,
        content: list[dict[str, Any]],
        *,
        system: str = SYSTEM_PROMPT,
        reasoning_effort: str = REASONING_EFFORT,
        max_output_tokens: int = MAX_OUTPUT_TOKENS,
        text_format: dict[str, Any] | None = None,
        timeout: float = TIMEOUT_SECONDS,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self._model,
            "reasoning": {"effort": reasoning_effort},
            "max_output_tokens": max_output_tokens,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": system}]},
                {"role": "user", "content": content},
            ],
        }
        if text_format is not None:
            payload["text"] = {"format": text_format}
        response = await self._call(payload, timeout=timeout)
        status = response.status_code
        if not 200 <= status < 300:
            raise BreakdownError(
                f"视频拆解接口返回 {status}: {_excerpt(response.content)}",
                retryable=status == 429 or status >= 500,
            )
        try:
            body = json.loads(response.content)
        except ValueError as exc:
            raise BreakdownError("视频拆解接口返回的不是 JSON", retryable=True) from exc
        return _document(body)

    async def _call(self, payload: dict[str, Any], *, timeout: float) -> ModelCallResponse:
        try:
            return await self._runtime.model_call(
                ModelCallIn(declaration=DECLARATION, model=self._model, payload=payload),
                timeout=_runtime_timeout(timeout),
            )
        except ModelUnavailable as exc:
            raise BreakdownModelUnavailable(str(exc)) from exc
        except ModelCallTimedOut as exc:
            raise BreakdownError(f"视频拆解接口超时（{exc}）", retryable=False) from exc
        except AppRejected as exc:
            raise BreakdownError(f"视频拆解接口被拒（{exc}）", retryable=False) from exc
        except RuntimeUnavailable as exc:
            raise BreakdownError(f"视频拆解接口连不上（{exc}）", retryable=True) from exc


def sampled_content(sample: SampledVideo) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for index, frame in enumerate(sample.frames):
        content.append({"type": "input_text", "text": f"{index / FRAME_FPS:.1f} second"})
        content.append(
            {
                "type": "input_image",
                "image_url": _data_url("image/jpeg", frame),
                "image_pixel_limit": {
                    "max_pixels": FRAME_MAX_PIXELS,
                    "min_pixels": _FRAME_MIN_PIXELS,
                },
            }
        )
    if sample.audio is not None:
        content.append({"type": "input_audio", "audio_url": _data_url("audio/mpeg", sample.audio)})
    content.append({"type": "input_text", "text": USER_MESSAGE})
    return content


def _runtime_timeout(seconds: float) -> httpx.Timeout:
    if seconds < MODEL_CALL_TIMEOUT_SECONDS:
        return httpx.Timeout(seconds, connect=_RUNTIME_CONNECT_SECONDS)
    return httpx.Timeout(
        MODEL_CALL_TIMEOUT_SECONDS + _RUNTIME_MARGIN_SECONDS, connect=_RUNTIME_CONNECT_SECONDS
    )


def _excerpt(content: bytes, limit: int = 300) -> str:
    return content.decode("utf-8", errors="replace")[:limit]


def _data_url(media_type: str, content: bytes) -> str:
    return f"data:{media_type};base64,{base64.b64encode(content).decode('ascii')}"


def _document(body: object) -> str:
    if not isinstance(body, dict):
        raise BreakdownError("视频拆解接口返回的顶层不是 object", retryable=True)
    status = body.get("status")
    if status != "completed":
        detail = body.get("incomplete_details") or body.get("error") or ""
        raise BreakdownError(f"视频拆解没有正常跑完（status={status!r}）：{detail}", retryable=True)
    chunks: list[str] = []
    output = body.get("output")
    for item in output if isinstance(output, list) else []:
        if not isinstance(item, dict):
            continue
        parts = item.get("content")
        for part in parts if isinstance(parts, list) else []:
            if isinstance(part, dict) and part.get("type") == "output_text":
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    document = "".join(chunks).strip()
    if not document:
        raise BreakdownError("视频拆解接口没给出正文", retryable=True)
    return document


__all__ = [
    "BREAKDOWN_MODEL",
    "DECLARATION",
    "MAX_OUTPUT_TOKENS",
    "NATIVE_FPS",
    "REASONING_EFFORT",
    "TIMEOUT_SECONDS",
    "ArkBreakdownModel",
    "sampled_content",
]

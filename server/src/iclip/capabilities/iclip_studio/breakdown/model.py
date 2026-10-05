"""方舟 Responses 适配器：把帧与音轨、或视频地址交给模型，取回拆解文档。"""

from __future__ import annotations

import base64
from typing import Any, Final

import httpx

from iclip.capabilities.iclip_studio.breakdown.media import FRAME_FPS, FRAME_MAX_PIXELS
from iclip.capabilities.iclip_studio.breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE
from iclip.capabilities.iclip_studio.ports import BreakdownError, SampledVideo

TIMEOUT_SECONDS: Final = 900.0
"""付费拆解的总超时；超时无法确认上游是否已执行，不自动重试。"""

REASONING_EFFORT: Final = "high"

MAX_OUTPUT_TOKENS: Final = 65_536
"""输出上限，远高于实际用量；只为在模型陷入重复输出时及时停下。"""

NATIVE_FPS: Final = 5
"""直接传视频地址时让对方每秒看几帧；方舟只收到 5。"""

_FRAME_MIN_PIXELS: Final = 1_764


class ArkBreakdownModel:
    """视频拆解的方舟适配器，HTTP 客户端由组合根注入。"""

    def __init__(self, client: httpx.AsyncClient, *, url: str, api_key: str, model: str) -> None:
        self._client = client
        self._url = url
        self._api_key = api_key
        self._model = model

    async def from_sample(self, sample: SampledVideo) -> str:
        """逐帧配时间戳，再接整条音轨。"""

        return await self._ask(sampled_content(sample))

    async def from_url(self, video_url: str) -> str:
        """把视频地址交给对方自己取帧。"""

        return await self._ask(
            [
                {"type": "input_video", "video_url": video_url, "fps": NATIVE_FPS},
                {"type": "input_text", "text": USER_MESSAGE},
            ]
        )

    async def _ask(self, content: list[dict[str, Any]]) -> str:
        payload: dict[str, Any] = {
            "model": self._model,
            "reasoning": {"effort": REASONING_EFFORT},
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
                {"role": "user", "content": content},
            ],
        }
        try:
            response = await self._client.post(
                self._url,
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
                timeout=TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            raise BreakdownError(
                f"视频拆解接口返回 {exc.response.status_code}: {exc.response.text[:300]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BreakdownError(f"视频拆解接口连不上（{type(exc).__name__}）") from exc
        except ValueError as exc:
            raise BreakdownError("视频拆解接口返回的不是 JSON") from exc
        return _document(body)


def sampled_content(sample: SampledVideo) -> list[dict[str, Any]]:
    """用户消息的内容：每帧先给时间戳再给图，然后是音轨，最后是用户消息。"""

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


def _data_url(media_type: str, content: bytes) -> str:
    return f"data:{media_type};base64,{base64.b64encode(content).decode('ascii')}"


def _document(body: object) -> str:
    """只收 completed 且正文非空的响应；其余都按失败处理，不交付残缺的文档。"""

    if not isinstance(body, dict):
        raise BreakdownError("视频拆解接口返回的顶层不是 object")
    status = body.get("status")
    if status != "completed":
        detail = body.get("incomplete_details") or body.get("error") or ""
        raise BreakdownError(f"视频拆解没有正常跑完（status={status!r}）：{detail}")
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
        raise BreakdownError("视频拆解接口没给出正文")
    return document


__all__ = [
    "MAX_OUTPUT_TOKENS",
    "NATIVE_FPS",
    "REASONING_EFFORT",
    "TIMEOUT_SECONDS",
    "ArkBreakdownModel",
    "sampled_content",
]

"""参考视频的拆解与打标：把 references 声明的两个端口接到导演那一份拆解（``VideoBreakdown``）与方舟
Responses 接口上。

打标是一次纯文本调用：系统提示词固定，由两份标签清单拼成；用户消息只放拆解全文；输出用 Responses 的
``text.format``（``TAG_FORMAT``，json_schema、strict）约束，``parse_tags`` 是唯一的解析处。"""

from __future__ import annotations

from typing import Any, Final

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from iclip.capabilities.iclip_studio.breakdown.media import FfmpegVideoSampler
from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.ports import BreakdownError
from iclip.config import ResolvedIclipStudio
from iclip.domains.references.models import (
    CATEGORIES,
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    ERROR_VIDEO_UNREADABLE,
    VIDEO_TYPES,
    BreakdownFailed,
    CategoryValue,
    TaggingFailed,
    Tags,
    VideoTypeValue,
)
from iclip.platform.media.ffmpeg import MediaError


def _tag_system_prompt() -> str:
    """片子类型那几行取自 ``VIDEO_TYPES``，品类那行取自 ``CATEGORIES``，清单只有一处来源。"""

    type_lines = "\n".join(f"- {one.value} {one.label}：{one.rule}" for one in VIDEO_TYPES)
    return (
        "你会拿到一份视频拆解文档。根据文档给视频打两种标签，只用文档里写到的内容，没写的不要猜。"
        "两种都可以选多个，也可以一个都不选。\n"
        "\n"
        "片子类型：选所有符合的。\n"
        f"{type_lines}\n"
        "\n"
        "产品品类：看出场元素表里类型是「产品」的行，每个产品从下面清单里选一个最贴切的；"
        "清单里没有的不选。\n"
        f"{'、'.join(CATEGORIES)}"
    )


TAG_SYSTEM_PROMPT: Final = _tag_system_prompt()

TAG_FORMAT: Final[dict[str, Any]] = {
    "type": "json_schema",
    "name": "reference_video_tags",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "videoTypes": {
                "type": "array",
                "items": {"type": "string", "enum": [one.value for one in VIDEO_TYPES]},
            },
            "categories": {
                "type": "array",
                "items": {"type": "string", "enum": list(CATEGORIES)},
            },
        },
        "required": ["videoTypes", "categories"],
        "additionalProperties": False,
    },
}
"""打标输出的约束：只能填清单里的值；空数组就是未标注。"""

TAG_REASONING_EFFORT: Final = "low"

TAG_MAX_OUTPUT_TOKENS: Final = 8_192
"""含思考的输出上限。实测思考强度 low 时一次约 2200 个，给到约四倍，避免答到一半被截断。"""

TAG_TIMEOUT_SECONDS: Final = 180.0
"""打标的总超时。实测一次约 40 秒；与拆解的 900 秒相加仍短于拆解中的超时收尾。"""


class _TagAnswer(BaseModel):
    """``TAG_FORMAT`` 约束下模型该给的形状。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    video_types: list[VideoTypeValue] = Field(alias="videoTypes")
    categories: list[CategoryValue]


def parse_tags(raw: str) -> Tags:
    """解析打标输出：不是合法 JSON、形状不对、有清单外的值都抛 ``TaggingFailed``，不静默丢弃；
    两组各自去重，保留先后。"""

    try:
        answer = _TagAnswer.model_validate_json(raw)
    except ValidationError as exc:
        raise TaggingFailed(f"打标输出不合格：{exc.errors()[0]['msg']}") from exc
    return Tags(
        video_types=tuple(dict.fromkeys(answer.video_types)),
        categories=tuple(dict.fromkeys(answer.categories)),
    )


class ArkVideoBreakdowns:
    """``VideoBreakdowns`` 的实现：沿用导演那一份拆解，把它的两种失败换成落到行上的原因。"""

    def __init__(self, breakdown: VideoBreakdown) -> None:
        self._breakdown = breakdown

    async def breakdown(self, video_url: str) -> str:
        try:
            return await self._breakdown.run(video_url)
        except MediaError as exc:
            raise BreakdownFailed(str(exc), code=ERROR_VIDEO_UNREADABLE) from exc
        except BreakdownError as exc:
            # 可重试的（限流、服务端错、连不上、答得不完整）再拆可能就好；被拒与等满总超时不会。
            code = ERROR_MODEL_CALL_FAILED if exc.retryable else ERROR_MODEL_FAILED
            raise BreakdownFailed(str(exc), code=code) from exc


class ArkTagger:
    """``Tagger`` 的实现：一次方舟纯文本调用加 ``parse_tags``。"""

    def __init__(self, model: ArkBreakdownModel) -> None:
        self._model = model

    async def tag(self, document: str) -> Tags:
        try:
            raw = await self._model.ask_text(
                TAG_SYSTEM_PROMPT,
                document,
                reasoning_effort=TAG_REASONING_EFFORT,
                max_output_tokens=TAG_MAX_OUTPUT_TOKENS,
                text_format=TAG_FORMAT,
                timeout=TAG_TIMEOUT_SECONDS,
            )
        except BreakdownError as exc:
            raise TaggingFailed(str(exc)) from exc
        return parse_tags(raw)


def build_reference_breakdown(
    settings: ResolvedIclipStudio, client: httpx.AsyncClient
) -> tuple[ArkVideoBreakdowns, ArkTagger]:
    """按 ``iclip_studio`` 的配置建参考视频自己的一份拆解与打标；HTTP 连接池与组合根共用。"""

    model = ArkBreakdownModel(
        client,
        url=settings.breakdown_url,
        api_key=settings.breakdown_api_key,
        model=settings.breakdown_model,
    )
    breakdown = VideoBreakdown(model=model, sampler=FfmpegVideoSampler(client))
    return ArkVideoBreakdowns(breakdown), ArkTagger(model)


__all__ = [
    "TAG_FORMAT",
    "TAG_MAX_OUTPUT_TOKENS",
    "TAG_REASONING_EFFORT",
    "TAG_SYSTEM_PROMPT",
    "TAG_TIMEOUT_SECONDS",
    "ArkTagger",
    "ArkVideoBreakdowns",
    "build_reference_breakdown",
    "parse_tags",
]

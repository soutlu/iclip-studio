"""final-cut 文字翻译的模型适配：经运行时调火山方舟，用 JSON Schema 约束回答，解析后按请求的顺序答回。"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

import structlog

from iclip.common.errors import ModelUnavailable
from iclip.common.final_cut import TargetLocale
from iclip.domains.conversations.final_cut_translation import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    FinalCutText,
    FinalCutTranslationFailed,
)
from iclip.platform.runtime_api.client import RuntimeClient
from iclip.platform.video_breakdown.model import ArkBreakdownModel
from iclip.platform.video_breakdown.ports import BreakdownError, BreakdownModelUnavailable

_logger = structlog.stdlib.get_logger(__name__)

TRANSLATE_MODEL: Final = "doubao-seed-2-1-lite-260915"

TRANSLATE_REASONING_EFFORT: Final = "low"

# 与视频拆解同一个上限；一批的总字数已按超时限住（见 MAX_TRANSLATION_TOTAL_CHARS），远到不了这里。
TRANSLATE_MAX_OUTPUT_TOKENS: Final = 65_536

TRANSLATE_TIMEOUT_SECONDS: Final = 180.0

LANGUAGE_NAMES: Final[Mapping[TargetLocale, str]] = {
    "en": "英语",
    "de": "德语",
    "es": "西班牙语",
    "fr": "法语",
}

_SYSTEM_PROMPT: Final = (
    "你会拿到一个 JSON 对象，entries 里每一条有 id 和 text。text 是一条短视频里的一句字幕或一段"
    "画面文字，原文是中文。\n"
    "把每一条单独翻成{language}，用口语，简短，适合放在画面上。\n"
    "品牌名、产品型号、数字、价格、单位、网址、话题标签照原样写；原文里的换行原样保留。\n"
    "原文本身已经是{language}，或者只是西文的品牌词时，原样返回。\n"
    "text 里只写译文，不加解释、引号或编号。每一条输入都用它原来的 id 返回一条，不多不少。"
)

_CALL_FAILED: Final = "翻译模型暂时调用失败，请稍后再试"

_CALL_REFUSED: Final = "翻译模型拒绝了这次请求或答复超时"


@dataclass(frozen=True, slots=True)
class TranslationRequest:
    system_prompt: str
    user_text: str
    text_format: dict[str, Any]


def build_translation_request(
    entries: Sequence[FinalCutText], locale: TargetLocale
) -> TranslationRequest:
    """拼一次模型调用：系统提示词写明目标语言，原文按 JSON 发过去（换行原样带上），回答的 id 只能是
    这一批里的。"""

    ids = [entry.id for entry in entries]
    return TranslationRequest(
        system_prompt=_SYSTEM_PROMPT.format(language=LANGUAGE_NAMES[locale]),
        user_text=json.dumps(
            {"entries": [{"id": entry.id, "text": entry.text} for entry in entries]},
            ensure_ascii=False,
        ),
        text_format={
            "type": "json_schema",
            "name": "final_cut_translations",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "translations": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "enum": ids},
                                "text": {"type": "string"},
                            },
                            "required": ["id", "text"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["translations"],
                "additionalProperties": False,
            },
        },
    )


def _failed(message: str) -> FinalCutTranslationFailed:
    return FinalCutTranslationFailed(message, code=ERROR_MODEL_FAILED)


def parse_translation_answer(raw: str, entries: Sequence[FinalCutText]) -> tuple[FinalCutText, ...]:
    """把模型的回答读成译文，按请求的顺序答回。

    回答不是 JSON、结构不对、id 重复、多出请求里没有的 id、缺了请求里的 id、译文只有空白，都抛
    ``model_failed``，不拿原文补。错误消息只带 id，不带原文和译文。
    """

    try:
        answer = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise _failed("翻译结果不是 JSON") from exc
    if not isinstance(answer, dict) or set(answer) != {"translations"}:
        raise _failed("翻译结果的结构不对")
    items = answer["translations"]
    if not isinstance(items, list):
        raise _failed("翻译结果的结构不对")
    wanted = {entry.id for entry in entries}
    found: dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict) or set(item) != {"id", "text"}:
            raise _failed("翻译结果的结构不对")
        key, text = item["id"], item["text"]
        if not isinstance(key, str) or not isinstance(text, str):
            raise _failed("翻译结果的结构不对")
        if key not in wanted:
            raise _failed(f"翻译结果里多出了请求里没有的 id {key!r}")
        if key in found:
            raise _failed(f"翻译结果里 id {key!r} 出现了不止一次")
        if not text.strip():
            raise _failed(f"翻译结果里 id {key!r} 的译文是空的")
        found[key] = text
    for entry in entries:
        if entry.id not in found:
            raise _failed(f"翻译结果缺了 id {entry.id!r}")
    return tuple(FinalCutText(id=entry.id, text=found[entry.id]) for entry in entries)


class ArkFinalCutTranslator:
    def __init__(self, model: ArkBreakdownModel) -> None:
        self._model = model

    async def translate(
        self, entries: Sequence[FinalCutText], *, locale: TargetLocale
    ) -> tuple[FinalCutText, ...]:
        started = time.monotonic()
        try:
            translated = await self._ask(entries, locale)
        except (FinalCutTranslationFailed, ModelUnavailable) as exc:
            _logger.warning(
                "final-cut 翻译失败",
                locale=locale,
                count=len(entries),
                code=exc.code,
                seconds=round(time.monotonic() - started, 2),
            )
            raise
        _logger.info(
            "final-cut 翻译完成",
            locale=locale,
            count=len(entries),
            seconds=round(time.monotonic() - started, 2),
        )
        return translated

    async def _ask(
        self, entries: Sequence[FinalCutText], locale: TargetLocale
    ) -> tuple[FinalCutText, ...]:
        request = build_translation_request(entries, locale)
        try:
            raw = await self._model.ask_text(
                request.system_prompt,
                request.user_text,
                reasoning_effort=TRANSLATE_REASONING_EFFORT,
                max_output_tokens=TRANSLATE_MAX_OUTPUT_TOKENS,
                text_format=request.text_format,
                timeout=TRANSLATE_TIMEOUT_SECONDS,
            )
        except BreakdownModelUnavailable as exc:
            raise ModelUnavailable(str(exc)) from exc
        except BreakdownError as exc:
            # 平台的消息带着上游答复的摘录，不往外给；只按能不能再试分成两个码。
            if exc.retryable:
                raise FinalCutTranslationFailed(_CALL_FAILED, code=ERROR_MODEL_CALL_FAILED) from exc
            raise FinalCutTranslationFailed(_CALL_REFUSED, code=ERROR_MODEL_FAILED) from exc
        return parse_translation_answer(raw, entries)


def build_final_cut_translator(runtime: RuntimeClient) -> ArkFinalCutTranslator:
    return ArkFinalCutTranslator(ArkBreakdownModel(runtime, model=TRANSLATE_MODEL))


__all__ = [
    "LANGUAGE_NAMES",
    "TRANSLATE_MAX_OUTPUT_TOKENS",
    "TRANSLATE_MODEL",
    "TRANSLATE_REASONING_EFFORT",
    "TRANSLATE_TIMEOUT_SECONDS",
    "ArkFinalCutTranslator",
    "TranslationRequest",
    "build_final_cut_translator",
    "build_translation_request",
    "parse_translation_answer",
]

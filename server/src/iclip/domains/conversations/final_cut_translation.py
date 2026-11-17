"""final-cut 文字翻译：把一批中文短句（字幕、画面文字）翻成编辑器支持的一种外语，一次请求一次模型调用。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol

from iclip.common.final_cut import TargetLocale

TranslationErrorCode = Literal["model_call_failed", "model_failed"]

MAX_TRANSLATION_ENTRIES: Final = 200

MAX_TRANSLATION_TEXT_CHARS: Final = 500

MAX_TRANSLATION_ID_CHARS: Final = 128

# 一批所有 text 加起来的字数上限，保证一次调用答得完、不被截断。超时（180 秒）比输出上限（65,536
# token）先到，按它估：中文翻成西文约每字 1.5 个输出 token；200 条的 JSON 外壳和 id 约 2,000 token，
# 低档思考约 2,000 token；吞吐按保守的每秒 60 token 算，180 秒约 10,800 token，留给译文约 6,800 token，
# 约 4,500 字，取整到 4,000 字再留些余量。
MAX_TRANSLATION_TOTAL_CHARS: Final = 4_000

ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"

ERROR_MODEL_FAILED: Final = "model_failed"


@dataclass(frozen=True, slots=True)
class FinalCutText:
    """一条要翻的字或翻好的字：``id`` 是编辑器里变量的 id，``text`` 是字本身。"""

    id: str
    text: str


class FinalCutTranslationFailed(Exception):
    """模型调用失败或回答不能用。``model_call_failed`` 是再试一次可能就好，``model_failed`` 是
    模型拒绝、等待超时或回答不对。消息只说原因，不带原文和译文。"""

    def __init__(self, message: str, *, code: TranslationErrorCode) -> None:
        super().__init__(message)
        self.code: TranslationErrorCode = code


class FinalCutTranslator(Protocol):
    async def translate(
        self, entries: Sequence[FinalCutText], *, locale: TargetLocale
    ) -> tuple[FinalCutText, ...]:
        """把 ``entries`` 翻成 ``locale``，按请求的顺序每个 id 恰好一条。

        模型没启用抛 ``ModelUnavailable``；调用失败或回答不对抛 ``FinalCutTranslationFailed``。
        """
        ...


__all__ = [
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "MAX_TRANSLATION_ENTRIES",
    "MAX_TRANSLATION_ID_CHARS",
    "MAX_TRANSLATION_TEXT_CHARS",
    "MAX_TRANSLATION_TOTAL_CHARS",
    "FinalCutText",
    "FinalCutTranslationFailed",
    "FinalCutTranslator",
    "TranslationErrorCode",
]

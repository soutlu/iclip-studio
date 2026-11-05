from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Final

import structlog
from pydantic_ai import direct
from pydantic_ai.messages import ModelRequest, TextPart
from pydantic_ai.models import Model

from agent_runtime.harness.models import thinking_settings

_logger = structlog.stdlib.get_logger(__name__)

TITLE_THINKING: Final = "low"

GenerateTitle = Callable[[str], Awaitable[str | None]]

INSTRUCTIONS = """\
给这段对话起一个标题。

- 一行，不超过 20 个字，不加引号、句号或书名号。
- 说清这次要做的事，用对话里的具体名词（产品、场景、片型），不要「关于…的讨论」这种空壳。
- 用户用什么语言，标题就用什么语言。
- 只输出标题本身，不要任何解释。"""

MAX_INPUT_CHARS = 400

MAX_TITLE_CHARS = 200


def title_generator(model: Model) -> GenerateTitle:
    async def generate(user_text: str) -> str | None:
        excerpt = user_text.strip()[:MAX_INPUT_CHARS]
        if not excerpt:
            return None
        try:
            response = await direct.model_request(
                model,
                [ModelRequest.user_text_prompt(excerpt, instructions=INSTRUCTIONS)],
                model_settings=thinking_settings(model, TITLE_THINKING),
            )
        except Exception:
            _logger.warning("起标题失败，这段对话先用默认名", exc_info=True)
            return None
        return clean_title(
            "".join(part.content for part in response.parts if isinstance(part, TextPart))
        )

    return generate


def clean_title(raw: str) -> str | None:
    line = raw.strip().splitlines()[0].strip() if raw.strip() else ""
    for quote in ('"', "'", "“", "”", "「", "」", "《", "》"):
        line = line.strip(quote)
    line = line.strip()[:MAX_TITLE_CHARS]
    return line or None


__all__ = ["GenerateTitle", "clean_title", "title_generator"]

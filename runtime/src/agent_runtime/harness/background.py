from __future__ import annotations

import html
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Final, Literal, get_args

from pydantic_ai.framing import DataTag
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    TextContent,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai_harness import BackgroundTools

_OPEN_TAG: Final = re.compile(
    r'<tool_result tool_name="(?P<name>[^"]*)" tool_call_id="(?P<id>[^"]*)"'
    r'(?P<failed> outcome="failed")?>\n'
)
_CLOSE_TAG: Final = "\n</tool_result>"
_FRAMING_TAG_NAMES: Final = "|".join(re.escape(tag) for tag in ("system", *get_args(DataTag)))
_NEUTRALIZED_TAG: Final = re.compile(
    rf"&lt;(?=\s*(?:/\s*)?(?:{_FRAMING_TAG_NAMES})(?=[\s/>]|$))", re.IGNORECASE
)

INTERRUPTED_RECEIPT: Final = "interrupted_background_receipt"


@dataclass(frozen=True, slots=True)
class BackgroundOutcome:
    tool_call_id: str
    tool_name: str
    state: Literal["done", "error"]
    text: str


def is_receipt(part: ToolReturnPart) -> bool:
    prefix = f"Tool '{part.tool_name}' is running in background (task {part.tool_call_id})."
    return isinstance(part.content, str) and part.content.startswith(prefix)


def was_receipt(part: ToolReturnPart) -> bool:
    return (
        part.outcome == "interrupted"
        and isinstance(part.metadata, dict)
        and part.metadata.get(INTERRUPTED_RECEIPT) is True
    )


def parse_outcome(part: UserPromptPart) -> BackgroundOutcome | None:
    if isinstance(part.content, str):
        return None
    first = next(iter(part.content), None)
    if not isinstance(first, TextContent):
        return None
    opened = _OPEN_TAG.match(first.content)
    if opened is None:
        return None
    body = first.content[opened.end() :]
    closed = body.find(_CLOSE_TAG)
    return BackgroundOutcome(
        tool_call_id=html.unescape(opened["id"]),
        tool_name=html.unescape(opened["name"]),
        state="done" if opened["failed"] is None else "error",
        text=_NEUTRALIZED_TAG.sub("<", body if closed < 0 else body[:closed]),
    )


def interrupt_stale_receipts(history: Sequence[ModelMessage]) -> list[ModelMessage]:
    delivered = {
        outcome.tool_call_id
        for message in history
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
        if (outcome := parse_outcome(part)) is not None
    }
    repaired: list[ModelMessage] = []
    for message in history:
        closed = (
            [
                part.tool_call_id
                for part in message.parts
                if isinstance(part, ToolReturnPart)
                and is_receipt(part)
                and part.tool_call_id not in delivered
            ]
            if isinstance(message, ModelRequest)
            else []
        )
        if not closed:
            repaired.append(message)
            continue
        parts = [
            replace(
                part,
                content=INTERRUPTED_TOOL_RETURN_CONTENT,
                outcome="interrupted",
                metadata={INTERRUPTED_RECEIPT: True},
            )
            if isinstance(part, ToolReturnPart) and part.tool_call_id in closed
            else part
            for part in message.parts
        ]
        repaired.append(replace(message, parts=parts))
    return repaired


__all__ = [
    "INTERRUPTED_RECEIPT",
    "BackgroundOutcome",
    "BackgroundTools",
    "interrupt_stale_receipts",
    "is_receipt",
    "parse_outcome",
    "was_receipt",
]

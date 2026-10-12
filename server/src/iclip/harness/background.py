"""Pydantic AI Harness 的 ``BackgroundTools``：供组合根挂载，并持有它写进消息的文本格式。

后台工具被调用时立即回一条回执（``ToolReturnPart``），跑完后的结果作为用户内容（``UserPromptPart``）
递入运行。transcript 的两条投影据此让回执照常结卡并开一条 tool 任务、让结果成完成通知而不成插话块；
运行驱动据此把没等到结果的回执换成带标记的 interrupted 返回，历史重建靠标记仍认得出那是一次后台调用。
措辞是 harness 模块里的固定常量，升级 harness 时由契约测试先红。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Final, Literal

from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai_harness import BackgroundTools

_OUTCOME: Final = re.compile(
    r"Background tool '(?P<name>.+?)' \(task (?P<id>.+?)\) "
    r"(?:completed\.\nResult: (?P<result>.*)|failed: (?P<error>.*))",
    re.DOTALL,
)

INTERRUPTED_RECEIPT: Final = "interrupted_background_receipt"
"""被中断的回执在 ``ToolReturnPart.metadata`` 里的标记键；metadata 不发给模型，随历史落库。"""


@dataclass(frozen=True, slots=True)
class BackgroundOutcome:
    """一次后台调用的结果；``text`` 是工具自己的返回或失败原文，不含 harness 套的英文外壳。"""

    tool_call_id: str
    tool_name: str
    state: Literal["done", "error"]
    text: str


def is_receipt(part: ToolReturnPart) -> bool:
    """这条工具返回是不是后台工具的回执：调用还在跑，结果之后作为用户内容送达。"""

    prefix = f"Tool '{part.tool_name}' is running in background (task {part.tool_call_id})."
    return isinstance(part.content, str) and part.content.startswith(prefix)


def was_receipt(part: ToolReturnPart) -> bool:
    """这条工具返回是不是 interrupt_stale_receipts 换下的回执：一次没等到结果的后台调用。"""

    return (
        part.outcome == "interrupted"
        and isinstance(part.metadata, dict)
        and part.metadata.get(INTERRUPTED_RECEIPT) is True
    )


def parse_outcome(part: UserPromptPart) -> BackgroundOutcome | None:
    """把后台工具结果拆成调用 id、成败与工具原文；不是结果时返回 None。

    工具返回带文件时 content 是序列，文字在第一项；文件不进工具卡。
    """

    first = part.content if isinstance(part.content, str) else next(iter(part.content), None)
    if not isinstance(first, str):
        return None
    matched = _OUTCOME.fullmatch(first)
    if matched is None:
        return None
    result = matched["result"]
    return BackgroundOutcome(
        tool_call_id=matched["id"],
        tool_name=matched["name"],
        state="error" if result is None else "done",
        text=matched["error"] if result is None else result,
    )


def interrupt_stale_receipts(history: Sequence[ModelMessage]) -> list[ModelMessage]:
    """把后面没有结果的回执换成框架的 interrupted 返回，交回新历史；原历史不改。

    持久历史里不会有还活着的后台任务：停止、崩溃或审批暂停都会丢掉没跑完的那次调用。留着回执，
    模型会以为结果还会来，什么都不做就结束这一步。换下的返回保留原回执的调用 id、工具名与时间戳，
    metadata 记上 INTERRUPTED_RECEIPT（见 was_receipt）：新运行的快照里没有回执了，历史重建靠它
    仍按「回执之后没等到结果」收卡、重建任务。
    """

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

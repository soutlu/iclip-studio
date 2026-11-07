from __future__ import annotations

import dataclasses
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeGuard

import structlog
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import (
    CompactionPart,
    LoadCapabilityCallPart,
    LoadCapabilityReturnPart,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolAvailabilityDeltaPart,
    post_compaction_window,
)
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext
from pydantic_ai_harness.compaction import SummarizingCompaction, estimate_context_tokens
from pydantic_ai_harness.compaction._capability_loads import RECORDED_LOAD_METADATA_KEY

_logger = structlog.stdlib.get_logger(__name__)

COMPACTED_BY_METADATA_KEY = "iclip.compaction.run_id"


def compaction_boundary(message: ModelMessage) -> CompactionPart | None:
    if not isinstance(message, ModelResponse):
        return None
    return next(
        (part for part in reversed(message.parts) if isinstance(part, CompactionPart)), None
    )


def compacted_by(message: ModelResponse) -> str | None:
    run_id = (message.metadata or {}).get(COMPACTED_BY_METADATA_KEY)
    return run_id if isinstance(run_id, str) else None


def recorded_loads(messages: Iterable[ModelMessage]) -> dict[str, LoadCapabilityReturnPart]:
    return {
        part.tool_call_id: part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, LoadCapabilityReturnPart)
        and (part.metadata or {}).get(RECORDED_LOAD_METADATA_KEY) is True
    }


def recorded_load_call(
    part: object, recorded: Collection[str]
) -> TypeGuard[LoadCapabilityCallPart]:
    return isinstance(part, LoadCapabilityCallPart) and part.tool_call_id in recorded


def compaction_only(message: ModelMessage, recorded: Collection[str]) -> bool:
    if not message.parts:
        return False
    return all(
        isinstance(part, CompactionPart)
        or (
            isinstance(
                part, LoadCapabilityCallPart | LoadCapabilityReturnPart | ToolAvailabilityDeltaPart
            )
            and part.tool_call_id in recorded
        )
        for part in message.parts
    )


def compaction_window(messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    window = post_compaction_window(messages)
    if not window or not isinstance(head := window[0], ModelResponse) or not head.parts:
        return window
    if not isinstance(part := head.parts[0], CompactionPart):
        return window
    rest = dataclasses.replace(head, parts=list(head.parts[1:]))
    return [
        ModelRequest(parts=[CompactionPart(content=part.content, metadata=part.metadata)]),
        *([rest] if rest.parts else []),
        *window[1:],
    ]


@dataclass
class ContextCompaction(AbstractCapability[Any]):
    strategy: SummarizingCompaction[Any]

    max_tokens: int

    on_compaction: Callable[[str, Sequence[ModelMessage]], None]

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        request = await self._compact(ctx, request_context)
        return dataclasses.replace(request_context, messages=compaction_window(request))

    async def _compact(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> list[ModelMessage]:
        history = ctx.messages
        request = list(request_context.messages)
        if (
            estimate_context_tokens(
                history, model_request_parameters=request_context.model_request_parameters
            )
            <= self.max_tokens
        ):
            return request

        window = compaction_window(history)
        result = await self.strategy.compact(window, ctx)
        if result is window:
            _logger.info("历史超线但切不动，这次不压", run_id=ctx.run_id, messages=len(history))
            return request

        summary_at, summary = _summary_of(result)
        tail = result[summary_at + 1 :]
        records = _new_records(tail, window)
        preserved = [message for message in tail if all(message is not r for r in records)]
        index = _cut_index(history, preserved)
        now = datetime.now(UTC)
        boundary = ModelResponse(
            parts=[
                CompactionPart(
                    content=summary.content,
                    provider_name=ctx.model.system,
                    metadata=summary.metadata,
                )
            ],
            run_id=history[index].run_id if index < len(history) else ctx.run_id,
            timestamp=now,
            provider_name=ctx.model.system,
            metadata=_stamped(None, ctx.run_id),
        )
        _logger.info(
            "历史压成摘要",
            run_id=ctx.run_id,
            boundary_index=index,
            messages_before=len(history),
            recorded_loads=len(recorded_loads(records)),
        )
        records = [
            dataclasses.replace(
                message,
                run_id=boundary.run_id,
                timestamp=now,
                metadata=_stamped(message.metadata, ctx.run_id)
                if isinstance(message, ModelResponse)
                else message.metadata,
            )
            for message in records
        ]
        history[index:index] = [boundary, *records]
        cut = _cut_index(request, preserved)
        request[cut:cut] = [boundary, *records]
        self.on_compaction(summary.content or "", records)
        return request


def _summary_of(result: Sequence[ModelMessage]) -> tuple[int, CompactionPart]:
    for index, message in enumerate(result):
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, CompactionPart) and part.provider_name is None and part.content:
                return index, part
    raise RuntimeError(f"摘要器的结果里没有摘要请求：{result!r}")


def _stamped(metadata: dict[str, Any] | None, run_id: str | None) -> dict[str, Any] | None:
    if run_id is None:
        return metadata
    return {**(metadata or {}), COMPACTED_BY_METADATA_KEY: run_id}


def _new_records(
    tail: Sequence[ModelMessage], window: Sequence[ModelMessage]
) -> list[ModelMessage]:
    known = recorded_loads(window)
    fresh = {call_id for call_id in recorded_loads(tail) if call_id not in known}
    return [
        message
        for message in tail
        if any(getattr(part, "tool_call_id", None) in fresh for part in message.parts)
    ]


def _cut_index(messages: Sequence[ModelMessage], preserved: Sequence[ModelMessage]) -> int:
    alive = {id(item) for item in preserved}
    return next(
        (index for index, message in enumerate(messages) if id(message) in alive), len(messages)
    )


__all__ = [
    "COMPACTED_BY_METADATA_KEY",
    "ContextCompaction",
    "compacted_by",
    "compaction_boundary",
    "compaction_only",
    "compaction_window",
    "recorded_load_call",
    "recorded_loads",
]

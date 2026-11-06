from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import structlog
from pydantic_ai.capabilities import (
    AbstractCapability,
    CapabilityOrdering,
    WrapModelRequestHandler,
)
from pydantic_ai.messages import ModelResponse
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import RunContext

from agent_runtime.harness.transcript.from_messages import step_usage
from agent_runtime.transcript.ops import StepUsage

_logger = structlog.stdlib.get_logger(__name__)

ConversationOf = Callable[[object], str | None]


class ConversationUsageStore(Protocol):
    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None: ...


@dataclass
class UsageLedger(AbstractCapability[Any]):
    store: ConversationUsageStore
    conversation_of: ConversationOf

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(position="innermost")

    async def wrap_model_request(
        self,
        ctx: RunContext[Any],
        *,
        request_context: ModelRequestContext,
        handler: WrapModelRequestHandler,
    ) -> ModelResponse:
        response = await handler(request_context)
        await self._record(ctx, response)
        return response

    async def _record(self, ctx: RunContext[Any], response: ModelResponse) -> None:
        conversation_id = self.conversation_of(ctx.deps)
        if conversation_id is None:
            _logger.warning("响应没有归属对话，用量不记账", run_id=ctx.run_id)
            return
        usage = step_usage(response.usage)
        if usage is None:
            return
        model_name = ctx.model.model_name
        try:
            await self.store.add(
                conversation_id=conversation_id, model_name=model_name, usage=usage
            )
        except Exception:
            _logger.error(
                "用量台账写入失败",
                run_id=ctx.run_id,
                conversation_id=conversation_id,
                model_name=model_name,
                exc_info=True,
            )


__all__ = ["ConversationOf", "ConversationUsageStore", "UsageLedger"]

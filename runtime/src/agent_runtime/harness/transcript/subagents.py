from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from functools import partial
from typing import Any

import structlog
from pydantic_ai.capabilities import (
    AbstractCapability,
    ValidatedToolArgs,
    WrapRunHandler,
    WrapToolExecuteHandler,
)
from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import AgentStreamEvent, ToolCallPart
from pydantic_ai.run import AgentRunResult, AgentRunResultEvent
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.ui import NativeEvent
from pydantic_ai_harness.step_persistence import StepStore, annotate_tool_effect

from agent_runtime.harness.agents import SubAgentProfile
from agent_runtime.harness.transcript.projector import TranscriptEventStream
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.transcript.display import ToolDisplayRegistry
from agent_runtime.transcript.ops import MAIN_AGENT_ID, TextContent

_logger = structlog.stdlib.get_logger(__name__)

CHILD_TURN_ID = "t1"

_DRAIN_SECONDS = 5.0


@dataclass(slots=True)
class Delegation:
    conversation_id: str
    on_spawn: Callable[[str, SubAgentProfile], None]
    child_run_id: str | None = None


current_delegation: ContextVar[Delegation | None] = ContextVar(
    "iclip.subagents.current_delegation", default=None
)


@dataclass(frozen=True, slots=True)
class _End:
    pass


@dataclass(frozen=True, slots=True)
class _Raise:
    error: BaseException


_Item = AgentStreamEvent | AgentRunResultEvent[Any] | _End | _Raise


@dataclass(kw_only=True)
class SubAgentBridge(AbstractCapability[Any]):
    store: StepStore
    live: TranscriptStore
    conversation_id: str
    projector: TranscriptEventStream
    delegate_tool: str
    parent_agent_id: str = MAIN_AGENT_ID

    async def wrap_tool_execute(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        handler: WrapToolExecuteHandler,
    ) -> Any:
        if tool_def.name != self.delegate_tool:
            return await handler(args)
        delegation = Delegation(
            conversation_id=self.conversation_id,
            on_spawn=partial(self._spawned, call.tool_call_id),
        )
        token = current_delegation.set(delegation)
        try:
            result = await handler(args)
        except BaseException:
            current_delegation.reset(token)
            try:
                await self._settle(ctx, call=call, tool_def=tool_def, delegation=delegation)
            except Exception:
                _logger.warning(
                    "子代理收尾失败，原异常照旧抛出", tool_call_id=call.tool_call_id, exc_info=True
                )
            raise
        current_delegation.reset(token)
        await self._settle(ctx, call=call, tool_def=tool_def, delegation=delegation)
        return result

    def _spawned(self, tool_call_id: str, child_run_id: str, profile: SubAgentProfile) -> None:
        self.live.append(
            self.conversation_id,
            self.parent_agent_id,
            self.projector.note_subagent(tool_call_id, child_run_id, profile),
        )

    async def _settle(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        delegation: Delegation,
    ) -> None:
        child_run_id = delegation.child_run_id
        if child_run_id is None:
            return
        scoped = (
            ctx
            if ctx.tool_call_id is not None and ctx.tool_name is not None
            else replace(ctx, tool_call_id=call.tool_call_id, tool_name=tool_def.name)
        )
        await annotate_tool_effect(self.store, scoped, effect_summary=child_run_id)
        _logger.debug("子代理已记入账本", tool_call_id=call.tool_call_id, child_run_id=child_run_id)
        if await self.store.latest_snapshot(run_id=child_run_id, include_interrupted=True) is None:
            _logger.warning("子代理那一轮还没落进快照，先留在实时状态里", child_run_id=child_run_id)
            return
        self.live.mark_snapshot_persisted(self.conversation_id, child_run_id, CHILD_TURN_ID)
        self.live.drop_persisted_turns(self.conversation_id, child_run_id)


@dataclass(kw_only=True)
class SubAgentMirror(AbstractCapability[Any]):
    id: str | None = "subagent_mirror"
    live: TranscriptStore
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    profiles: Mapping[str, SubAgentProfile] = field(default_factory=dict)
    _delegation: Delegation | None = None
    _queue: asyncio.Queue[_Item] | None = None

    async def for_run(self, ctx: RunContext[Any]) -> AbstractCapability[Any]:
        return replace(self, _delegation=current_delegation.get(), _queue=asyncio.Queue[_Item]())

    async def wrap_run(
        self, ctx: RunContext[Any], *, handler: WrapRunHandler
    ) -> AgentRunResult[Any]:
        queue = self._queue
        delegation = self._delegation
        if delegation is None or queue is None:
            return await handler()
        child_run_id = ctx.run_id
        if child_run_id is None:
            raise RuntimeError("子代理这次运行没有 run id，镜像不了")
        agent_name = None if ctx.agent is None else ctx.agent.name
        if agent_name is None:
            raise RuntimeError("子代理没有名字，镜像不了")
        profile = self.profiles.get(agent_name)
        if profile is None:
            raise RuntimeError(f"子代理 {agent_name} 没有登记档案，镜像不了")
        task = ctx.prompt
        if not isinstance(task, str):
            raise RuntimeError("子代理的 prompt 不是纯文本")
        delegation.child_run_id = child_run_id
        delegation.on_spawn(child_run_id, profile)
        projector = TranscriptEventStream(
            agent_id=child_run_id,
            turn_id=CHILD_TURN_ID,
            turn_ordinal=1,
            run_id=child_run_id,
            content=(TextContent(text=task),),
            display=self.display,
        )
        consumer = asyncio.create_task(
            self._mirror(queue, projector, delegation.conversation_id, child_run_id)
        )
        try:
            result = await handler()
        except asyncio.CancelledError:
            queue.put_nowait(_Raise(RunCancelled("子代理被停止")))
            raise
        except Exception as error:
            queue.put_nowait(_Raise(error))
            raise
        else:
            queue.put_nowait(AgentRunResultEvent(result=result))
            queue.put_nowait(_End())
            return result
        finally:
            await asyncio.shield(asyncio.wait_for(consumer, _DRAIN_SECONDS))

    async def on_event(self, ctx: RunContext[Any], *, event: AgentStreamEvent) -> None:
        if self._queue is not None and self._delegation is not None:
            self._queue.put_nowait(event)

    async def _mirror(
        self,
        queue: asyncio.Queue[_Item],
        projector: TranscriptEventStream,
        conversation_id: str,
        child_run_id: str,
    ) -> None:
        async for batch in projector.transform_stream(_drain(queue)):
            self.live.append(conversation_id, child_run_id, batch)


async def _drain(queue: asyncio.Queue[_Item]) -> AsyncIterator[NativeEvent]:
    while True:
        item = await queue.get()
        match item:
            case _End():
                return
            case _Raise():
                raise item.error
            case _:
                yield item


__all__ = [
    "CHILD_TURN_ID",
    "Delegation",
    "SubAgentBridge",
    "SubAgentMirror",
    "current_delegation",
]

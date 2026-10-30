"""通过 CompactionPart 标记摘要边界，保留完整历史。

before_model_request 超线时把边界同时写入持久历史（ctx.messages）与本次请求，
再把每次请求都换成最新边界后的窗口；持久历史只多出边界，不删原始消息。
SummarizingCompaction 提供摘要和工具对完整的切点，触发条件由本模块控制。
窗口以不带 provider 的请求侧摘要开头，由框架包装成标明出处的摘要文字、以用户身份发给模型；
摘要器认同一份摘要上的 harness 标记，据此做增量摘要。
框架只在加载交换位于窗口内时认为按需能力已加载，摘要器为被摘掉的加载补记一次交换；
补记与边界一起写进持久历史和本次请求，技能正文因此在压缩后照常送达。
"""

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

# 私有模块：harness 0.62 未公开导出补记加载交换的标记，升级时须复核。
from pydantic_ai_harness.compaction._capability_loads import RECORDED_LOAD_METADATA_KEY

_logger = structlog.stdlib.get_logger(__name__)

COMPACTED_BY_METADATA_KEY = "iclip.compaction.run_id"
"""边界与补记调用所在响应的 metadata 里记下执行这次压缩的 run；压缩提示与补记的加载卡挂在这个 run 的下一步。"""


def compaction_boundary(message: ModelMessage) -> CompactionPart | None:
    """按 part 查找压缩边界，兼容框架合并相邻同角色消息后的历史。"""

    if not isinstance(message, ModelResponse):
        return None
    return next(
        (part for part in reversed(message.parts) if isinstance(part, CompactionPart)), None
    )


def compacted_by(message: ModelResponse) -> str | None:
    """边界或补记调用所在响应记下的压缩 run；早先写入的边界没有这一项。"""

    run_id = (message.metadata or {}).get(COMPACTED_BY_METADATA_KEY)
    return run_id if isinstance(run_id, str) else None


def recorded_loads(messages: Iterable[ModelMessage]) -> dict[str, LoadCapabilityReturnPart]:
    """压缩补记的加载返回，按 tool_call_id 索引；同 id 的 load_capability 调用是补记的调用。

    只认 harness 写在返回 part 上的标记。
    """

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
    """判断 part 是否为补记的 load_capability 调用；recorded 取自 recorded_loads。"""

    return isinstance(part, LoadCapabilityCallPart) and part.tool_call_id in recorded


def compaction_only(message: ModelMessage, recorded: Collection[str]) -> bool:
    """判断非空消息是否只含压缩写入的内容：边界，或 recorded 里补记加载的调用、返回与工具揭示。

    这样的消息不是模型步骤，也不代表轮次时间；混有其他内容时仍按普通消息处理。
    """

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
    """返回最新边界后的窗口，发给模型和交给摘要器都用它。

    边界换成一条只含请求侧摘要的请求放在开头：内容与 metadata 取自边界，不带 provider，
    框架按摘要包装后发出，摘要器凭 metadata 里的标记认出上一份摘要。同一消息中边界之后的
    part 保留。
    """

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
    """历史超过阈值时写入压缩边界，后续请求使用边界后的窗口。"""

    strategy: SummarizingCompaction[Any]
    """仅调用摘要能力，由本模块控制触发。"""

    max_tokens: int
    """模型上下文窗口乘以压缩比例。"""

    on_compaction: Callable[[str, Sequence[ModelMessage]], None]
    """压缩完成后通知运行侧更新显示，传入摘要文字与补记的加载交换（没有补记时为空）。"""

    async def before_model_request(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        """每次请求都换成最新边界后的模型窗口；历史超过阈值时先插入新边界。"""

        request = await self._compact(ctx, request_context)
        # 没超线也要裁剪，否则两次压缩之间的请求会发出完整历史。
        return dataclasses.replace(request_context, messages=compaction_window(request))

    async def _compact(
        self, ctx: RunContext[Any], request_context: ModelRequestContext
    ) -> list[ModelMessage]:
        """超过阈值时把摘要边界与补记的加载交换插入持久历史，返回同样插好的本次请求消息。

        ctx.messages 就是持久历史，request_context.messages 只代表本次请求、钩子返回后不写回；
        两者装的是同一批消息对象，按对象身份在两边定位同一切点。
        最近响应的 input_tokens 对应上次实际发送的窗口，阈值据此估算。
        """

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
            # 保留尾部消息后，没有可摘要的内容。
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
                    # 摘要器的标记与写成时间原样带上，下次压缩据此认出上一份摘要。
                    metadata=summary.metadata,
                )
            ],
            # 使用切点消息的 run_id，边界随切点留在原来那一轮。
            run_id=history[index].run_id if index < len(history) else ctx.run_id,
            # 显式记录时间；框架仅为末条请求补充运行元数据。
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
        # 补记须排在保留的请求之前：重新送达技能正文的指令若排在加载之前，框架每次请求都会重发正文。
        # 边界带 provider，框架不会把补记调用并进边界。
        # 补记返回与后面的请求合并后不带 run_id，所以补记沿用边界的 run_id。
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
    """找出摘要器结果里那条请求侧、不带 provider 的摘要及其位置；没有时抛错，避免空摘要遮蔽历史。

    结果开头可能还有系统提示请求和保留的首条用户消息，摘要请求之后才是保留的尾部。
    """

    for index, message in enumerate(result):
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, CompactionPart) and part.provider_name is None and part.content:
                return index, part
    raise RuntimeError(f"摘要器的结果里没有摘要请求：{result!r}")


def _stamped(metadata: dict[str, Any] | None, run_id: str | None) -> dict[str, Any] | None:
    """在响应 metadata 上记下执行压缩的 run；没有 run_id 时原样返回。"""

    if run_id is None:
        return metadata
    return {**(metadata or {}), COMPACTED_BY_METADATA_KEY: run_id}


def _new_records(
    tail: Sequence[ModelMessage], window: Sequence[ModelMessage]
) -> list[ModelMessage]:
    """摘要器这次补记的加载交换：带标记的返回所在请求与同 id 调用所在响应。

    窗口里已有的旧补记若在保留的尾部中，按原位置留下，不重复插入。
    """

    known = recorded_loads(window)
    fresh = {call_id for call_id in recorded_loads(tail) if call_id not in known}
    return [
        message
        for message in tail
        if any(getattr(part, "tool_call_id", None) in fresh for part in message.parts)
    ]


def _cut_index(messages: Sequence[ModelMessage], preserved: Sequence[ModelMessage]) -> int:
    """按对象身份定位首条保留消息；跳过窗口拆分产生的新对象，避免相等消息误匹配。"""

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

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from cue.transcript.ops import (
    AgentDescriptor,
    EmittableOperation,
    Interaction,
    Prompt,
    PromptContent,
    TranscriptMeta,
    TranscriptSnapshot,
    TranscriptTask,
    TranscriptTurn,
)


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ResetPayload(Envelope):
    type: Literal["transcript.reset"] = "transcript.reset"
    agent_id: str
    snapshot: TranscriptSnapshot
    has_more_older: bool = True
    seq: int


class OpsPayload(Envelope):
    type: Literal["transcript.ops"] = "transcript.ops"
    agent_id: str
    ops: tuple[EmittableOperation, ...]
    seq: int


PendingInteraction = Literal["none", "approval", "question"]

LastTurnReason = Literal["completed", "failed", "aborted"]


class SessionActivityOut(Envelope):
    """一段会话此刻的活动：三项各自独立，等审批时 ``busy`` 仍为真。"""

    busy: bool
    pending_interaction: PendingInteraction
    last_turn_reason: LastTurnReason | None = None


class SubscribePayload(Envelope):
    session_id: str
    transcript: dict[str, Literal["off", "turn", "block", "delta"]] = Field(default_factory=dict)
    transcript_since: dict[str, int] = Field(default_factory=dict)
    transcript_epoch: dict[str, str] = Field(default_factory=dict)


class Subscribe(Envelope):
    type: Literal["subscribe_v2"] = "subscribe_v2"
    id: str
    payload: SubscribePayload


class UnsubscribePayload(Envelope):
    session_id: str
    agent_ids: tuple[str, ...] = ()


class Unsubscribe(Envelope):
    type: Literal["unsubscribe_v2"] = "unsubscribe_v2"
    id: str
    payload: UnsubscribePayload


class TranscriptPage(Envelope):
    """``GET /transcript`` 的一页。

    ``agents`` 与 ``pending_interactions`` 是协议要求的字段：前者是主 agent 加各子代理，后者从
    待回应的交互里取。

    这里只有 transcript 本身：运行时不认识应用的对话表，标题、属主、血缘这类信封字段由应用在自己的
    答复模型上加。
    """

    agent_id: str
    items: tuple[TranscriptTurn, ...]
    has_more: bool
    tasks: tuple[TranscriptTask, ...] = ()
    interactions: tuple[Interaction, ...] = ()
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    agents: tuple[AgentDescriptor, ...] = ()
    pending_interactions: tuple[str, ...] = ()
    seq: int
    stream_epoch: str


class OpsBatchOut(Envelope):
    seq: int
    ops: tuple[EmittableOperation, ...]


class OpsCatchup(Envelope):
    """``GET /transcript/ops`` 的补批响应。

    ``complete`` 为假表示要的批次已经出了日志窗口，或调用方给的 ``stream_epoch`` 与当前实时流
    对不上，客户端得整页重拉。``stream_epoch`` 是这些批次所属的实时流。
    """

    agent_id: str
    batches: tuple[OpsBatchOut, ...]
    latest_seq: int
    complete: bool
    stream_epoch: str


class PromptQueueOut(Envelope):
    """``GET /prompts``：在跑的那条加排着的那些。"""

    active: Prompt | None
    queued: tuple[Prompt, ...]


class RunStatusOut(Envelope):
    """``GET /status``：这段对话此刻在跑、跑完了还是出错了。

    ``running`` 含排队；``awaiting`` 卡在人工审批上，不给决定就不会往下走；``idle`` 是从没跑过。
    """

    status: Literal["running", "awaiting", "completed", "failed", "aborted", "idle"]


PromptId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")]

PromptParts = Annotated[tuple[PromptContent, ...], Field(min_length=1)]


class PromptSubmission(Envelope):
    """``POST /prompts`` 的请求体。

    ``prompt_id`` 由客户端铸：它得在服务端答复回来之前就用这个 id 把自己的乐观气泡挂上，
    而且重发同一个 id 不会多起一次运行。

    ``user_name`` 是这条消息替谁发的，发往上游落表对账用。API key 调用方必须给；浏览器
    会话可省略，服务端填登录用户名。
    """

    prompt_id: PromptId
    content: PromptParts
    user_name: str | None = None


class RegenerateBody(Envelope):
    """``POST /turns/{turn_id}:regenerate`` 的请求体。两个字段都可省，整个体也可以不带。

    ``content`` 给了就是「改了内容再重跑」，不给照原样重跑。``prompt_id`` 给了就与发消息同一套
    幂等：重发同一个 id 退回已有那条，不会再截一轮。
    """

    prompt_id: PromptId | None = None
    content: PromptParts | None = None


class SteerRequest(Envelope):
    prompt_ids: tuple[str, ...] = Field(min_length=1)


class ApprovalRequest(Envelope):
    approved: bool


__all__ = [
    "ApprovalRequest",
    "Envelope",
    "LastTurnReason",
    "OpsBatchOut",
    "OpsCatchup",
    "OpsPayload",
    "PendingInteraction",
    "PromptId",
    "PromptParts",
    "PromptQueueOut",
    "PromptSubmission",
    "RegenerateBody",
    "ResetPayload",
    "RunStatusOut",
    "SessionActivityOut",
    "SteerRequest",
    "Subscribe",
    "SubscribePayload",
    "TranscriptPage",
    "Unsubscribe",
    "UnsubscribePayload",
]

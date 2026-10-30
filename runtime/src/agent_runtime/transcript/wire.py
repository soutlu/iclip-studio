"""transcript WS 帧与 REST 响应信封。

信封使用 snake_case，嵌套实体与操作使用 camelCase，与客户端 schema.ts 保持一致。
每帧 reset 必须携带 seq 以覆盖客户端水位，支持进程重启后从 1 重新编号；``stream_epoch`` 标出
这条实时流的身份，客户端带着它续订，对不上就回 reset。

信封上有两种水位，互不相干：

- ``stream_epoch`` + ``payload.seq``：某个 agent 的 Transcript 批次号，续订补批用。
- ``epoch`` + ``seq``：这段对话的会话事件序号，由宿主的会话事件时钟发号；Transcript 帧带当前
  序号，不发新号。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from agent_runtime.transcript.ops import (
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
    """信封层：字段名原样，不转 camelCase。"""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ResetPayload(Envelope):
    """``has_more_older`` 在 snapshot 外面，协议就是这么放的。"""

    agent_id: str
    snapshot: TranscriptSnapshot
    has_more_older: bool = True
    seq: int


class OpsPayload(Envelope):
    """一批操作。``seq`` 是这一批的批次号，每 agent 连续。"""

    agent_id: str
    ops: tuple[EmittableOperation, ...]
    seq: int


class Event(Envelope):
    """事件信封。

    ``session_id`` 说这一帧是哪段对话的：一条连接管多段，客户端按它分流，少了就不知道该给谁。
    信封上的 ``epoch`` + ``seq`` 是这段对话的会话事件水位，与 ``payload.seq``（transcript 批次号）
    **不是一回事**，见模块说明。
    """

    seq: int
    epoch: str
    session_id: str
    timestamp: str


class TranscriptReset(Event):
    """订阅时的第一帧。``stream_epoch`` 与 ``payload.seq`` 一起无条件覆写客户端水位。"""

    type: Literal["transcript.reset"] = "transcript.reset"
    stream_epoch: str
    payload: ResetPayload


class TranscriptOps(Event):
    """一批操作；``stream_epoch`` 标出批次号属于哪一条实时流。"""

    type: Literal["transcript.ops"] = "transcript.ops"
    stream_epoch: str
    payload: OpsPayload


PendingInteraction = Literal["none", "approval", "question"]
"""最高优先级的待处理事项。"""

LastTurnReason = Literal["completed", "failed", "aborted"]
"""最近完成轮次的结果。"""


class SessionActivityOut(Envelope):
    """一段会话此刻的活动：三项各自独立，等审批时 ``busy`` 仍为真。"""

    busy: bool
    pending_interaction: PendingInteraction
    last_turn_reason: LastTurnReason | None = None
    """最近完成那一轮的结局；还没有结局为空。"""


class SubscribePayload(Envelope):
    """订阅一段对话。``transcript`` 是每个 agent 要哪一档，我们只产出 ``delta``。

    ``transcript_since`` 是客户端手上的水位，按 agent 给；``transcript_epoch`` 是同一水位所属的实时流。
    两者都对得上才补那之后的批次；给了水位不给 epoch、或 epoch 对不上，一律回 reset。

    协议里还有一帧 ``client_hello``，用来一次报上全部订阅与各自的 cursor。我们不收它：一条
    连接管几段对话就发几帧 ``subscribe_v2``，各带自己的水位，重连时照样。
    """

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
    """``seq`` 所属的实时流；客户端拿基线订阅时与 ``seq`` 一起带上（``transcript_epoch``）。"""


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


# transcript 请求体按外部协议保留 snake_case。


PromptId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._-]+$")]
"""客户端生成的消息 id，发送与重新生成共用此约束。"""

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
    "Event",
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
    "TranscriptOps",
    "TranscriptPage",
    "TranscriptReset",
    "Unsubscribe",
    "UnsubscribePayload",
]

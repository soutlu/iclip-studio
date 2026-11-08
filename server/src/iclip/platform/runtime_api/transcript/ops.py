from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MAIN_AGENT_ID = "main"


class _Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class AgentRef(_Wire):
    agent_id: str
    role: Literal["child", "member"] | None = None


class TextFrame(_Wire):
    kind: Literal["text"] = "text"
    frame_id: str
    role: Literal["assistant", "user"]
    text: str
    content: tuple[PromptContent, ...] | None = None
    prompt_ids: tuple[str, ...] | None = None
    task_id: str | None = None

    @model_validator(mode="after")
    def _user_block_carries_content(self) -> TextFrame:
        if self.role == "user" and self.content is None:
            raise ValueError(f"用户块 {self.frame_id} 没带 content")
        return self


class ThinkingFrame(_Wire):
    kind: Literal["thinking"] = "thinking"
    frame_id: str
    text: str


class ToolFrame(_Wire):
    kind: Literal["tool"] = "tool"
    frame_id: str
    tool_call_id: str
    name: str
    state: Literal["running", "done", "error"]
    input: Any | None = None
    output: Any | None = None
    display: Any | None = None
    view: str | None = None
    metadata: Any | None = None
    error: str | None = None
    approval_id: str | None = None
    agent_refs: tuple[AgentRef, ...] | None = None


class NoticeFrame(_Wire):
    kind: Literal["notice"] = "notice"
    frame_id: str
    level: Literal["error", "warning", "info"]
    source: str | None = None
    message: str
    detail: Any | None = None


TranscriptFrame = Annotated[
    TextFrame | ThinkingFrame | ToolFrame | NoticeFrame, Field(discriminator="kind")
]


class TurnOrigin(_Wire):
    kind: Literal["user", "cron", "task", "hook", "compaction", "side", "other"]


class TurnUsage(_Wire):
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    cost: float | None = None


class StepUsage(_Wire):
    input_other: int
    output: int
    input_cache_read: int
    input_cache_creation: int


TaskState = Literal["running", "completed", "failed", "timed_out", "killed", "lost"]


class TranscriptTask(_Wire):
    """一件后台活儿。本系统产出两种：``subagent`` 是一次 delegate_task 一条；``tool`` 是一次后台
    工具调用一条（``detached`` 为真），``task_id`` 等于那次调用的 toolCallId。"""

    task_id: str
    kind: Literal["shell", "subagent", "tool", "other"]
    state: TaskState
    detached: bool
    description: str | None = None
    agent_id: str | None = None
    output_tail: str = ""
    started_at: str | None = None
    ended_at: str | None = None
    result_summary: str | None = None
    error: str | None = None
    state_reason: str | None = None
    usage: StepUsage | None = None
    model: str | None = None
    thinking_effort: str | None = None


class AgentDescriptor(_Wire):
    agent_id: str
    type: Literal["main", "sub", "independent"] | None = None
    parent_agent_id: str | None = None
    label: str | None = None
    created_at: str | None = None
    disposed_at: str | None = None


class TurnHeader(_Wire):
    """一轮的头部。``steps`` 不在这里——步是单独的操作发的。"""

    kind: Literal["turn"] = "turn"
    turn_id: str
    trigger_prompt_id: str | None = None
    ordinal: int
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    origin: TurnOrigin
    content: tuple[PromptContent, ...]
    started_at: str | None = None
    ended_at: str | None = None
    usage: TurnUsage | None = None
    duration_ms: int | None = None
    error: str | None = None


class StepHeader(_Wire):
    kind: Literal["step"] = "step"
    step_id: str
    turn_id: str
    ordinal: int
    state: Literal["running", "completed", "interrupted", "failed"]
    started_at: str | None = None
    ended_at: str | None = None
    usage: StepUsage | None = None
    finish_reason: str | None = None
    end_reason: str | None = None
    end_message: str | None = None


class TranscriptStep(StepHeader):
    """带上块的完整一步。``GET /transcript`` 的分页与快照里用这一份，操作里用光头部那份。"""

    frames: tuple[TranscriptFrame, ...] = ()


class TranscriptTurn(TurnHeader):
    """带上步的完整一轮。"""

    steps: tuple[TranscriptStep, ...] = ()


class Interaction(_Wire):
    """待人回应的审批或提问。``request`` / ``response`` 的形状由发起方决定。"""

    interaction_id: str
    interaction_kind: Literal["approval", "question"]
    tool_call_id: str | None = None
    state: Literal["pending", "approved", "rejected", "cancelled", "answered", "dismissed"]
    request: Any | None = None
    response: Any | None = None


class AttachmentSource(_Wire):
    kind: Literal["url", "file", "session_media"]
    url: str | None = None
    file_id: str | None = None


class TextContent(_Wire):
    type: Literal["text"] = "text"
    text: str


class ImageContent(_Wire):
    type: Literal["image"] = "image"
    source: AttachmentSource


class VideoContent(_Wire):
    type: Literal["video"] = "video"
    source: AttachmentSource


PromptContent = Annotated[TextContent | ImageContent | VideoContent, Field(discriminator="type")]


class Prompt(_Wire):
    """用户消息的服务端记录。客户端的乐观气泡第一层认领就是按 ``promptId`` 查这张表。"""

    prompt_id: str
    status: Literal["running", "queued", "blocked", "completed", "failed", "aborted"]
    user_message_id: str | None = None
    content: tuple[PromptContent, ...] | None = None
    created_at: str
    finished_at: str | None = None
    steered_at: str | None = None


class AgentStatusMeta(_Wire):
    context_tokens: int | None = Field(default=None, ge=0)
    max_context_tokens: int | None = Field(default=None, gt=0)
    context_usage: float | None = Field(default=None, ge=0, le=1)


class TranscriptMeta(_Wire):
    activity: Literal["idle", "turn", "disposing", "unknown"] | None = None
    agent: AgentStatusMeta | None = None


class TranscriptSnapshot(_Wire):
    items: tuple[Any, ...] = ()
    tasks: tuple[TranscriptTask, ...] = ()
    interactions: tuple[Interaction, ...] = ()
    todos: tuple[Any, ...] = ()
    prompts: tuple[Prompt, ...] = ()
    meta: TranscriptMeta = TranscriptMeta()
    has_more_older: bool = True


class FrameTarget(_Wire):
    type: Literal["frame"] = "frame"
    turn_id: str
    step_id: str
    frame_id: str


class TurnUpsertOp(_Wire):
    op: Literal["turn.upsert"] = "turn.upsert"
    turn: TurnHeader


class StepUpsertOp(_Wire):
    op: Literal["step.upsert"] = "step.upsert"
    turn_id: str
    step: StepHeader


class FrameUpsertOp(_Wire):
    op: Literal["frame.upsert"] = "frame.upsert"
    turn_id: str
    step_id: str
    frame: TranscriptFrame


class AppendOp(_Wire):
    """往某个块的尾巴追加文字。``offset`` 的单位是 UTF-16，见 ``utf16_len``。"""

    op: Literal["append"] = "append"
    target: FrameTarget
    offset: int = Field(ge=0)
    text: str


class TaskUpsertOp(_Wire):
    op: Literal["task.upsert"] = "task.upsert"
    task: TranscriptTask


class InteractionUpsertOp(_Wire):
    op: Literal["interaction.upsert"] = "interaction.upsert"
    interaction: Interaction


class PromptUpsertOp(_Wire):
    op: Literal["prompt.upsert"] = "prompt.upsert"
    prompt: Prompt


class MetaMergeOp(_Wire):
    op: Literal["meta.merge"] = "meta.merge"
    meta: TranscriptMeta


class ItemsRemoveOp(_Wire):
    op: Literal["items.remove"] = "items.remove"
    ids: tuple[str, ...]


EmittableOperation = Annotated[
    TurnUpsertOp
    | StepUpsertOp
    | FrameUpsertOp
    | AppendOp
    | TaskUpsertOp
    | InteractionUpsertOp
    | PromptUpsertOp
    | MetaMergeOp
    | ItemsRemoveOp,
    Field(discriminator="op"),
]


__all__ = [
    "MAIN_AGENT_ID",
    "AgentDescriptor",
    "AgentRef",
    "AgentStatusMeta",
    "AppendOp",
    "AttachmentSource",
    "EmittableOperation",
    "FrameTarget",
    "FrameUpsertOp",
    "ImageContent",
    "Interaction",
    "InteractionUpsertOp",
    "ItemsRemoveOp",
    "MetaMergeOp",
    "NoticeFrame",
    "Prompt",
    "PromptContent",
    "PromptUpsertOp",
    "StepHeader",
    "StepUpsertOp",
    "StepUsage",
    "TaskState",
    "TaskUpsertOp",
    "TextContent",
    "TextFrame",
    "ThinkingFrame",
    "ToolFrame",
    "TranscriptFrame",
    "TranscriptMeta",
    "TranscriptSnapshot",
    "TranscriptStep",
    "TranscriptTask",
    "TranscriptTurn",
    "TurnHeader",
    "TurnOrigin",
    "TurnUpsertOp",
    "TurnUsage",
    "VideoContent",
]

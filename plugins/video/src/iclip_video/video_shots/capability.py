from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, Final, Self

from agent_runtime.file_store.store import FileSpace, FileStore
from agent_runtime.harness.files import write_or_retry
from agent_runtime.harness.materials import require_media
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.tool_args import REPLAY_CONTEXT, JsonText
from agent_runtime.transcript.display import DisplayFn, FileIoDisplay, tool_note
from pydantic import TypeAdapter, ValidationError
from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import CapabilityOrdering
from pydantic_ai.messages import ToolReturn
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip_video.shot_document import (
    SHOTS_PATH,
    ShotDocumentError,
    VideoShotRequest,
    build_video_shots_document,
)

CAPABILITY_ID: Final = "video_shots"

ShotRequests = Annotated[list[VideoShotRequest], JsonText]

_SHOT_REQUESTS: Final = TypeAdapter[list[VideoShotRequest]](ShotRequests)


@dataclass
class VideoShots(CapPlugin[AgentDepsT]):
    label = "镜头组表"
    summary = "提交镜头组的提示词表，每次提交全部镜头组，替换上一次的。"

    space: FileSpace

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoShotsToolset[AgentDepsT]:
        return VideoShotsToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(cls, *, space: FileSpace) -> type[Self]:
        return cls._bound(space=space)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn]:
        return {"write_video_shots": _shots_display}


class VideoShotsToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: VideoShots[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.write_video_shots,
                name="write_video_shots",
                args_validator=self._validate_shot_delivery,
            )
        )

    async def write_video_shots(
        self,
        ctx: RunContext[AgentDepsT],
        aspect_ratio: str,
        shots: ShotRequests,
    ) -> ToolReturn[str]:
        """提交镜头组 prompt 表；每次提交全部镜头组，替换已有的。

        Args:
            aspect_ratio: 目标画幅，如 ``9:16``。
            shots: 按顺序排列的全部镜头组；以 JSON 数组传入，不要整体序列化成字符串。
        """

        files, namespace = self._workspace(ctx)
        try:
            document = build_video_shots_document(aspect_ratio, shots)
        except ShotDocumentError as exc:
            raise ModelRetry(str(exc)) from exc
        await write_or_retry(files, namespace, SHOTS_PATH, document.file_text())
        group_count = len(document.shots)
        shot_count = sum(len(shot.prompt.timeline) for shot in document.shots)
        seconds = sum(shot.seconds for shot in document.shots)
        return ToolReturn(
            return_value=(
                f"镜头组 prompt 表已交付到 {SHOTS_PATH}："
                f"{group_count} 个镜头组，{shot_count} 个镜头，合计 {seconds} 秒。"
            ),
            metadata=tool_note(chip=f"{group_count} 组 · {shot_count} 镜 · {seconds} 秒"),
        )

    async def _validate_shot_delivery(
        self, ctx: RunContext[Any], aspect_ratio: str, shots: list[VideoShotRequest]
    ) -> None:
        _ = (ctx, aspect_ratio)
        await require_media(
            [
                (f"第 {group} 组第 {number} 张", url)
                for group, shot in enumerate(shots, start=1)
                for number, url in enumerate(shot.image_urls, start=1)
            ],
            kind="image",
            what="镜头帧地址",
        )

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        return self._cap.space.store, self._cap.space.resolve(ctx)


def _shots_display(args: Any) -> FileIoDisplay:
    return FileIoDisplay(operation="write", path=SHOTS_PATH, content=_shots_file_text(args))


def _shots_file_text(args: Any) -> str | None:
    if not isinstance(args, dict):
        return None
    aspect_ratio = args.get("aspect_ratio")
    if not isinstance(aspect_ratio, str):
        return None
    try:
        shots = _SHOT_REQUESTS.validate_python(args.get("shots"), context=REPLAY_CONTEXT)
        return build_video_shots_document(aspect_ratio, shots).file_text()
    except (ValidationError, ShotDocumentError):
        return None


__all__ = ["CAPABILITY_ID", "VideoShots", "VideoShotsToolset"]

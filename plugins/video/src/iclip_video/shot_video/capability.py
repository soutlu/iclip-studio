from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from cue.file_store.store import FileSpace
from cue.plugins.base import CapPlugin
from cue.plugins.workspace.capability import Workspace
from cue.transcript.display import (
    MEDIA_GRID_VIEW,
    DisplayFn,
    GenericDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    url_filename,
)
from pydantic_ai.agent.abstract import AgentInstructions
from pydantic_ai.capabilities import CapabilityOrdering
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.toolsets import AgentToolset

from iclip_video.shot_video.extraction import FrameExtractor
from iclip_video.shot_video.generation import IMAGE_MODEL, FrameGenerator, GenerationPolicy
from iclip_video.shot_video.ports import FrameBoards, GridCuts, ImageGenerations
from iclip_video.shot_video.toolset import ShotVideoToolset
from iclip_video.video.capability import Video

CAPABILITY_ID: Final = "shot_video"


@dataclass
class ShotVideo(CapPlugin[AgentDepsT]):
    label = "取帧与出图"
    summary = "从参考视频抽帧拼成图片，按描述生成镜头帧和设定图。"

    space: FileSpace

    extractor: FrameExtractor

    generator: FrameGenerator

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return ShotVideoToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        return None

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(
        cls,
        *,
        space: FileSpace,
        generations: ImageGenerations,
        boards: FrameBoards,
        cuts: GridCuts,
        image_models: frozenset[str],
        policy: GenerationPolicy,
    ) -> type[Self]:
        if IMAGE_MODEL not in image_models:
            raise RuntimeError(
                f"出图工具要 {IMAGE_MODEL}，但 media_generation.image.models 里没有它；"
                f"已接入的是 {'、'.join(sorted(image_models)) or '（空）'}"
            )
        return cls._bound(
            space=space,
            extractor=FrameExtractor(boards=boards),
            generator=FrameGenerator(generations=generations, cuts=cuts, policy=policy),
        )

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(requires=(Workspace, Video))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {
            "plan_shot_frames": ToolDisplayEntry(
                draw=lambda args: GenericDisplay(summary="提取候选帧", detail=_video_name(args)),
                view=MEDIA_GRID_VIEW,
            ),
            "generate_shot_frames": ToolDisplayEntry(draw=_frames_display, view=MEDIA_GRID_VIEW),
            "generate_anchor_sheet": ToolDisplayEntry(
                draw=lambda _args: GenericDisplay(summary="生成设定图"), view=MEDIA_GRID_VIEW
            ),
        }


def _video_name(args: Any) -> str | None:
    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


def _frames_display(args: Any) -> ToolDisplay:
    frames = args.get("frames") if isinstance(args, dict) else None
    shots: list[int] = []
    for frame in frames if isinstance(frames, list) else []:
        no = frame.get("no") if isinstance(frame, dict) else None
        head = no.split("-", 1)[0].lstrip("S") if isinstance(no, str) else ""
        if head.isdigit() and int(head) not in shots:
            shots.append(int(head))
    detail = f"镜头 {'、'.join(map(str, sorted(shots)))}" if shots else None
    return GenericDisplay(summary="生成画面", detail=detail)


__all__ = [
    "CAPABILITY_ID",
    "GenerationPolicy",
    "ShotVideo",
]

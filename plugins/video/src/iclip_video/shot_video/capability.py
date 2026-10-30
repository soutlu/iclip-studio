"""取帧与出图插件装配，与工作区插件共用 FileSpace。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import MaterialLedger
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.transcript.display import (
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
    """取帧与出图插件。"""

    label = "取帧与出图"
    summary = "从参考视频抽帧拼成图片，按描述生成镜头帧和设定图。"

    space: FileSpace
    """产物存储与命名空间，必须由组合根提供与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """素材来源台账，记录产物地址并供工具输入验证使用。"""

    extractor: FrameExtractor

    generator: FrameGenerator

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
        return ShotVideoToolset(self)

    def get_instructions(self) -> AgentInstructions[AgentDepsT] | None:
        # 不注入指令：这几件工具怎么接力是流程知识，归 skill（architecture.md §5）。
        return None

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(
        cls,
        *,
        space: FileSpace,
        ledger: MaterialLedger,
        generations: ImageGenerations,
        boards: FrameBoards,
        cuts: GridCuts,
        image_models: frozenset[str],
        policy: GenerationPolicy,
    ) -> type[Self]:
        """装配取帧与出图服务并绑进类：抽帧拼板经 ``boards``，宫格切格转存经 ``cuts``，每一格存到
        哪个对象 key 由 ``cuts`` 的宿主实现定。

        Raises:
            RuntimeError: ``image_models`` 里没有出图要用的模型。
        """

        if IMAGE_MODEL not in image_models:
            # 出图把用哪家钉在代码里，配置没接这家就是每次出图都失败，起不来比跑起来好。
            raise RuntimeError(
                f"出图工具要 {IMAGE_MODEL}，但 media_generation.image.models 里没有它；"
                f"已接入的是 {'、'.join(sorted(image_models)) or '（空）'}"
            )
        return cls._bound(
            space=space,
            ledger=ledger,
            extractor=FrameExtractor(boards=boards),
            generator=FrameGenerator(generations=generations, cuts=cuts, policy=policy),
        )

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        # 取帧读 video 写下的拆解文档，产物经 workspace 的文件工具读取。
        return CapabilityOrdering(requires=(Workspace, Video))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        """工具卡与结果渲染声明。"""

        # 标题写法见 docs/tool-design.md §4：书面动宾短语，数字进 metadata 角标。
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
    """主语是这批帧所属的镜头号；帧号形如 S8-1，镜头号取 S 后面的数字。"""

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

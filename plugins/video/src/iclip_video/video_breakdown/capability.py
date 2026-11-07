from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from cue.file_store.store import FileSpace
from cue.harness.background import BackgroundTools
from cue.harness.files import write_or_retry
from cue.harness.materials import require_media
from cue.plugins.base import CapPlugin
from cue.plugins.workspace.capability import Workspace
from cue.run_deps import AgentRunDeps
from cue.transcript.display import DisplayFn, GenericDisplay, url_filename
from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.capabilities import AbstractCapability, CapabilityOrdering, CombinedCapability
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip_video.video_breakdown.ports import (
    BreakdownFailureReason,
    FailedBreakdown,
    ReferenceBreakdowns,
)

CAPABILITY_ID: Final = "video_breakdown"

BREAKDOWN_RETRIES: Final = 3

_DOC_DIR: Final = "references"
_STEM_CHARS: Final = 40
_UNSAFE_STEM: Final = re.compile(r"[^A-Za-z0-9._-]+")


def breakdown_doc_path(video_url: str) -> str:
    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


@dataclass
class VideoBreakdown(AbstractCapability[AgentDepsT]):
    space: FileSpace

    breakdowns: ReferenceBreakdowns

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoBreakdownToolset[AgentDepsT]:
        return VideoBreakdownToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


@dataclass
class VideoBreakdownPlugin(CapPlugin[AgentDepsT], CombinedCapability[AgentDepsT]):
    label = "视频拆解"
    summary = (
        "拆解一条视频的出场元素、逐镜时间线和整片分析；和资料库共用同一份拆解，"
        "拆过的直接用，没拆过的在后台拆。"
    )

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(cls, *, space: FileSpace, breakdowns: ReferenceBreakdowns) -> type[Self]:
        return cls._bound(space=space, breakdowns=breakdowns)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(
            capabilities=[
                VideoBreakdown[Any](**cls._bound_services()),
                BackgroundTools[Any](),
            ]
        )

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn]:
        return {
            "breakdown_video": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
        }


class VideoBreakdownToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: VideoBreakdown[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.breakdown_video,
                name="breakdown_video",
                max_retries=BREAKDOWN_RETRIES,
                args_validator=self._validate_video_url,
                metadata={"background": True},
            )
        )

    async def breakdown_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解输入视频，返回结构化拆解文档路径，文档中详细列出输入视频的出场元素、逐镜时间线和整片分析。

        Args:
            video_url: 参考视频地址。
        """

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        path = breakdown_doc_path(video_url)
        done = f"视频拆解完毕，文档在 {path}。"
        if await files.read(namespace, path) is not None:
            return done
        result = await self._cap.breakdowns.ensure(_deps(ctx).user_id, video_url)
        if isinstance(result, FailedBreakdown):
            raise _breakdown_failure(result.reason, last_attempt=ctx.last_attempt)
        await write_or_retry(files, namespace, path, result)
        return done

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        await require_media([("视频地址", video_url)], kind="video", what="视频地址")


def _breakdown_failure(reason: BreakdownFailureReason, *, last_attempt: bool) -> Exception:
    if reason == "video_unreadable":
        return ToolFailed("拆解失败，视频无法打开，不要重试，告诉用户换一条视频。")
    if reason == "model_unavailable":
        return ToolFailed(
            "拆解失败，拆解模型没有启用，不要重试，告诉用户需要管理员在配置页启用这个模型。"
        )
    if reason == "model_call_failed" and not last_attempt:
        return ModelRetry("拆解失败，再调用一次。")
    return ToolFailed("拆解失败，不要重试，告诉用户稍后再试。")


def _deps(ctx: RunContext[Any]) -> AgentRunDeps:
    deps = ctx.deps
    if not isinstance(deps, AgentRunDeps):
        raise RuntimeError(
            f"这次运行的 deps 是 {type(deps).__name__}，不是 AgentRunDeps——运行身份没有注入进来。"
        )
    return deps


def _video_name(args: Any) -> str | None:
    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = [
    "BREAKDOWN_RETRIES",
    "CAPABILITY_ID",
    "VideoBreakdown",
    "VideoBreakdownPlugin",
    "VideoBreakdownToolset",
    "breakdown_doc_path",
]

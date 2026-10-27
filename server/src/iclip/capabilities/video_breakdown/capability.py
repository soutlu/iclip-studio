"""视频拆解能力：登记 breakdown_video，把参考视频的拆解文档写进工作区。"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Final

from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.video_breakdown.ports import (
    BreakdownFailureReason,
    FailedBreakdown,
    ReferenceBreakdowns,
)
from iclip.common.urls import is_http_url
from iclip.domains.agents.public import AgentRunDeps
from iclip.harness.files import write_or_retry
from iclip.platform.file_store.store import FileSpace
from iclip.platform.transcript.display import DisplayFn, GenericDisplay, url_filename

CAPABILITY_ID: Final = "video_breakdown"

BREAKDOWN_RETRIES: Final = 3
"""拆解遇到可以重试的失败时，让模型再调几次；每次都把这条视频重新排一次付费拆解。"""

_DOC_DIR: Final = "references"
_STEM_CHARS: Final = 40
_UNSAFE_STEM: Final = re.compile(r"[^A-Za-z0-9._-]+")


def breakdown_doc_path(video_url: str) -> str:
    """这条视频的拆解文档在工作区的路径；哈希后缀让同名的两条视频各有一份。"""

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


@dataclass
class VideoBreakdown(AbstractCapability[AgentDepsT]):
    """拆解参考视频，拆解与资料库共用一份。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """写下的文件经 workspace 的文件工具读取。"""

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    breakdowns: ReferenceBreakdowns
    """参考视频的拆解：工具交给它拆，等它的结果。"""

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoBreakdownToolset[AgentDepsT]:
        return VideoBreakdownToolset(self)

    def display_table(self) -> Mapping[str, DisplayFn]:
        """供组合根合并的工具卡声明。"""

        return {
            "breakdown_video": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
        }

    @classmethod
    def get_serialization_name(cls) -> str | None:
        return None


class VideoBreakdownToolset(FunctionToolset[AgentDepsT]):
    """参数的范围规则挂在登记处的验证器上。"""

    def __init__(self, capability: VideoBreakdown[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.breakdown_video,
                name="breakdown_video",
                max_retries=BREAKDOWN_RETRIES,
                args_validator=self._validate_video_url,
                # 拆一条视频要等几分钟：挂了 BackgroundTools 的 agent 在等待时可以接着干别的。
                metadata={"background": True},
            )
        )

    async def breakdown_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解输入视频，返回结构化拆解文档路径，文档中详细列出输入视频的出场元素、逐镜时间线和整片分析。

        Args:
            video_url: 输入提供的视频的 url。
        """

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        path = breakdown_doc_path(video_url)
        done = f"视频拆解完毕，文档在 {path}。"
        # 工作区里已有的那份可能被用户指正过，不能拿参考视频里的那份盖掉。
        if await files.read(namespace, path) is not None:
            return done
        result = await self._cap.breakdowns.ensure(_deps(ctx).principal, video_url)
        if isinstance(result, FailedBreakdown):
            raise _breakdown_failure(result.reason, last_attempt=ctx.last_attempt)
        # 拆解已存在参考视频那一行上：工作区写入被配额等原因退回时，重试直接取到，不再付费。
        await write_or_retry(files, namespace, path, result)
        return done

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        if not is_http_url(video_url):
            raise ModelRetry("视频地址不对，输入提供的视频的 url。")


def _breakdown_failure(reason: BreakdownFailureReason, *, last_attempt: bool) -> Exception:
    """没拆成时回给模型的话。只有模型调用失败值得再调一次（再调会把这一行重新排队）；重试次数由
    登记处的 max_retries 管，用完后改报终局失败，不让整次运行中止。"""

    if reason == "video_unreadable":
        return ToolFailed("拆解失败，视频无法打开，不要重试，告诉用户换一条视频。")
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
    """工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = [
    "BREAKDOWN_RETRIES",
    "CAPABILITY_ID",
    "VideoBreakdown",
    "VideoBreakdownToolset",
    "breakdown_doc_path",
]

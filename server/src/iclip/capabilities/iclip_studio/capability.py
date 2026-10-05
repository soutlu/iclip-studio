"""iClip Studio 能力：登记视频拆解工具。"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Final

from pydantic_ai import ToolFailed
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.ports import BreakdownError, SharedBreakdowns
from iclip.harness.files import write_or_retry
from iclip.harness.materials import require_http
from iclip.platform.file_store.store import FileSpace
from iclip.platform.media.ffmpeg import MediaError
from iclip.platform.transcript.display import DisplayFn, GenericDisplay, url_filename

CAPABILITY_ID: Final = "iclip_studio"

_DOC_DIR: Final = "references"
_STEM_CHARS: Final = 40
_UNSAFE_STEM: Final = re.compile(r"[^A-Za-z0-9._-]+")


def breakdown_doc_path(video_url: str) -> str:
    """这条视频的拆解文档在工作区的路径；哈希后缀让同名的两条视频各有一份。"""

    stem = _UNSAFE_STEM.sub("-", video_url.rsplit("/", 1)[-1].rsplit(".", 1)[0]).strip("-")
    digest = hashlib.sha256(video_url.encode("utf-8")).hexdigest()[:8]
    return f"{_DOC_DIR}/{(stem[:_STEM_CHARS] or 'video')}-{digest}.md"


@dataclass
class IclipStudio(AbstractCapability[AgentDepsT]):
    """导演流程用的工具集。"""

    REQUIRES: ClassVar[tuple[str, ...]] = ("workspace",)
    """写下的文件经 workspace 的文件工具读取。"""

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    breakdown: VideoBreakdown

    shared: SharedBreakdowns

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> IclipStudioToolset[AgentDepsT]:
        return IclipStudioToolset(self)

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


class IclipStudioToolset(FunctionToolset[AgentDepsT]):
    """参数的范围规则挂在登记处的验证器上。"""

    def __init__(self, capability: IclipStudio[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.breakdown_video,
                name="breakdown_video",
                args_validator=self._validate_video_url,
            )
        )

    async def breakdown_video(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解一条视频，把出场元素、逐镜时间线和整片分析写成一份文档，返回文档路径。

        同一条视频只拆一次：文档已经在工作区里时直接返回它的路径，不重新拆解，也不改动已有内容。

        拆解失败时不写文件，返回失败原因；失败后本轮不再对这条视频调用。

        Args:
            video_url: 视频地址，取消息中视频媒体 tag 的 url 原值。
        """

        files, namespace = self._cap.space.store, self._cap.space.resolve(ctx)
        path = breakdown_doc_path(video_url)
        done = f"视频拆解完毕，文档在 {path}。"
        # 工作区里已有的那份可能被用户指正过，不能拿共享的原始结果盖掉。
        if await files.read(namespace, path) is not None:
            return done
        document = await self._cap.shared.get(video_url)
        fresh = document is None
        if document is None:
            try:
                document = await self._cap.breakdown.run(video_url)
            except (MediaError, BreakdownError) as exc:
                raise ToolFailed(f"这条视频没拆解成功：{exc}") from exc
        if fresh:
            # 先存共用的那份：工作区写入被配额等原因退回时，重试能直接取到，不必再付一次拆解。
            await self._cap.shared.put(video_url, document)
        await write_or_retry(files, namespace, path, document)
        return done

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        require_http(video_url, what="视频地址")


def _video_name(args: Any) -> str | None:
    """工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = ["CAPABILITY_ID", "IclipStudio", "IclipStudioToolset", "breakdown_doc_path"]

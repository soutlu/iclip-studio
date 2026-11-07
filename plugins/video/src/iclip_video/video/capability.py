from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from cue.file_store.store import FileSpace, FileStore
from cue.harness.files import write_or_retry
from cue.harness.materials import require_http
from cue.plugins.base import CapPlugin
from cue.plugins.workspace.capability import Workspace
from cue.transcript.display import DisplayFn, GenericDisplay, url_filename
from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.capabilities import CapabilityOrdering
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip_video.video_document import video_doc_path
from iclip_video.video_understanding import (
    VideoUnderstanding,
    VideoUnderstandingError,
    VideoUnderstandingUnavailable,
)

CAPABILITY_ID: Final = "video"


@dataclass
class Video(CapPlugin[AgentDepsT]):
    label = "视频理解"
    summary = "把参考视频交给视频理解模型拆解，拆解内容写进工作区，当场返回。"

    space: FileSpace

    understanding: VideoUnderstanding

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoToolset[AgentDepsT]:
        return VideoToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(cls, *, space: FileSpace, understanding: VideoUnderstanding) -> type[Self]:
        return cls._bound(space=space, understanding=understanding)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn]:
        return {
            "video_parser": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
        }


class VideoToolset(FunctionToolset[AgentDepsT]):
    def __init__(self, capability: Video[AgentDepsT]) -> None:
        super().__init__(id=capability.id)
        self._cap = capability
        self.add_tool(
            Tool(
                self.video_parser,
                name="video_parser",
                args_validator=self._validate_video_url,
            )
        )

    async def video_parser(self, ctx: RunContext[AgentDepsT], video_url: str) -> str:
        """拆解参考视频，把拆解内容写进文件，返回它的路径。

        Args:
            video_url: 参考视频地址。
        """

        files, namespace = self._workspace(ctx)
        path = video_doc_path(video_url)
        try:
            content = await self._cap.understanding.parse(video_url)
        except VideoUnderstandingUnavailable as exc:
            raise ToolFailed(
                f"拆解失败：{exc}。不要重试，告诉用户需要管理员在配置页启用这个模型。"
            ) from exc
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        await write_or_retry(files, namespace, path, content)
        return f"视频解析完毕，文档在 {path}。"

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        _ = ctx
        require_http(video_url, what="视频地址")

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        return self._cap.space.store, self._cap.space.resolve(ctx)


def _video_name(args: Any) -> str | None:
    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = ["CAPABILITY_ID", "Video", "VideoToolset"]

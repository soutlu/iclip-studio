"""视频理解插件：拆解参考视频，拆解内容写进工作区。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Self

from pydantic_ai import ModelRetry
from pydantic_ai.capabilities import CapabilityOrdering
from pydantic_ai.tools import AgentDepsT, RunContext, Tool
from pydantic_ai.toolsets import FunctionToolset

from iclip.harness.files import write_or_retry
from iclip.harness.materials import require_materials
from iclip.platform.file_store.store import FileSpace, FileStore
from iclip.platform.material_ledger.store import MaterialLedger
from iclip.platform.transcript.display import DisplayFn, GenericDisplay, url_filename
from iclip.plugins.base import CapPlugin
from iclip.plugins.video_document import video_doc_path
from iclip.plugins.video_understanding import VideoUnderstanding, VideoUnderstandingError
from iclip.plugins.workspace.capability import Workspace

CAPABILITY_ID: Final = "video"


@dataclass
class Video(CapPlugin[AgentDepsT]):
    """视频理解插件。"""

    label = "视频理解"
    summary = "把参考视频交给视频理解模型拆解，拆解内容写进工作区，当场返回。"

    space: FileSpace
    """与工作区能力相同的 FileSpace。"""

    ledger: MaterialLedger
    """素材来源台账，供工具输入验证使用。"""

    understanding: VideoUnderstanding

    id: str | None = field(default=CAPABILITY_ID, kw_only=True)

    def get_toolset(self) -> VideoToolset[AgentDepsT]:
        return VideoToolset(self)

    @classmethod
    def get_serialization_name(cls) -> str:
        return CAPABILITY_ID

    @classmethod
    def bind(
        cls, *, space: FileSpace, ledger: MaterialLedger, understanding: VideoUnderstanding
    ) -> type[Self]:
        """把运行服务绑进类，交给登记表。"""

        return cls._bound(space=space, ledger=ledger, understanding=understanding)

    @classmethod
    def from_spec(cls) -> Self:
        return cls(**cls._bound_services())

    def get_ordering(self) -> CapabilityOrdering:
        # 写下的文件经 workspace 的文件工具读取。
        return CapabilityOrdering(requires=(Workspace,))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn]:
        """工具卡声明。"""

        return {
            "video_parser": lambda args: GenericDisplay(
                summary="拆解视频", detail=_video_name(args)
            ),
        }


class VideoToolset(FunctionToolset[AgentDepsT]):
    """拆解工具；视频地址的范围规则挂在登记处的验证器上。"""

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
        except VideoUnderstandingError as exc:
            raise ModelRetry(f"这段视频没拆解成功：{exc}") from exc
        await write_or_retry(files, namespace, path, content)
        return f"视频解析完毕，文档在 {path}。"

    async def _validate_video_url(self, ctx: RunContext[Any], video_url: str) -> None:
        """视频地址须是本对话已登记的视频素材。"""

        await require_materials(
            self._cap.ledger,
            self._cap.space.resolve(ctx),
            (video_url,),
            kind="video",
            what="视频地址",
        )

    def _workspace(self, ctx: RunContext[AgentDepsT]) -> tuple[FileStore, str]:
        """这次运行的文件存储与命名空间。"""

        return self._cap.space.store, self._cap.space.resolve(ctx)


def _video_name(args: Any) -> str | None:
    """视频工具卡展示原素材文件名。"""

    url = args.get("video_url") if isinstance(args, dict) else None
    return url_filename(url) if isinstance(url, str) else None


__all__ = ["CAPABILITY_ID", "Video", "VideoToolset"]

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Self

from agent_runtime.file_store.store import FileSpace
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.ports import ImageInfo, MediaProbeFailed
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai.capabilities import AbstractCapability, CombinedCapability

from iclip_video.video.capability import Video
from tests.helpers.video_understanding import FakeUnderstanding


@dataclass
class FixedPlugin(CapPlugin[Any]):
    label = "测试插件"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return str(cls._bound_services()["name"]) if cls._services is not None else "fixed"

    @classmethod
    def bind(cls, *, name: str, capabilities: Sequence[AbstractCapability[Any]]) -> type[Self]:
        return cls._bound(name=name, capabilities=tuple(capabilities))

    @classmethod
    def from_spec(cls) -> AbstractCapability[Any]:
        capabilities: tuple[AbstractCapability[Any], ...] = cls._bound_services()["capabilities"]
        if len(capabilities) == 1:
            return capabilities[0]
        return CombinedCapability[Any](capabilities=list(capabilities))

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


class _NoProbe:
    async def image_info(self, url: str) -> ImageInfo:
        raise MediaProbeFailed(f"测试没有接图片信息：{url}")


def workspace_for(space: FileSpace) -> Workspace[Any]:
    return Workspace[Any](space=space, probe=_NoProbe())


def with_requirements(
    capability: AbstractCapability[Any], space: FileSpace
) -> list[AbstractCapability[Any]]:
    stand_ins: dict[type[AbstractCapability[Any]], AbstractCapability[Any]] = {
        Workspace: workspace_for(space),
        Video: Video[Any](space=space, understanding=FakeUnderstanding(document="")),
    }
    return [*(stand_ins[one] for one in _required(capability)), capability]


def required_tools(capability: AbstractCapability[Any]) -> frozenset[str]:
    return frozenset(
        name
        for one in _required(capability)
        if issubclass(one, CapPlugin)
        for name in one.display_table()
    )


def _required(capability: AbstractCapability[Any]) -> Sequence[type[AbstractCapability[Any]]]:
    ordering = capability.get_ordering()
    return ordering.requires if ordering is not None else ()


__all__ = ["FixedPlugin", "required_tools", "with_requirements", "workspace_for"]

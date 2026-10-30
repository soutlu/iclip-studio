"""插件替身与测试里补挂工作区的办法。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Self

from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import MaterialLedger
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.ports import ImageInfo, MediaProbeFailed
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai.capabilities import AbstractCapability, CombinedCapability

from iclip.plugins.video.capability import Video
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.shot_video import FakeUnderstanding


@dataclass
class FixedPlugin(CapPlugin[Any]):
    """插件替身：``bind(name=…, capabilities=…)`` 定插件名，``from_spec`` 交回绑进来的那几项
    capability（只有一项时就是它本身）；不要求同挂别的插件，没有工具卡声明。"""

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
    """补挂的工作区不查图片信息。"""

    async def image_info(self, url: str) -> ImageInfo:
        raise MediaProbeFailed(f"测试没有接图片信息：{url}")


def workspace_for(space: FileSpace, ledger: MaterialLedger | None = None) -> Workspace[Any]:
    """与被测插件共用 ``space`` 的工作区：插件 ``get_ordering().requires`` 要求同挂 workspace，
    单测其它插件时一起挂上它。"""

    return Workspace[Any](
        space=space, probe=_NoProbe(), ledger=ledger if ledger is not None else FakeMaterialLedger()
    )


def with_requirements(
    capability: AbstractCapability[Any], space: FileSpace
) -> list[AbstractCapability[Any]]:
    """被测插件连同它 ``get_ordering().requires`` 要求同挂的插件（与它共用 ``space``），交给 Agent；
    pydantic-ai 装配时会查这些依赖，少挂了直接报错。"""

    stand_ins: dict[type[AbstractCapability[Any]], AbstractCapability[Any]] = {
        Workspace: workspace_for(space),
        Video: Video[Any](
            space=space, ledger=FakeMaterialLedger(), understanding=FakeUnderstanding(document="")
        ),
    }
    return [*(stand_ins[one] for one in _required(capability)), capability]


def required_tools(capability: AbstractCapability[Any]) -> frozenset[str]:
    """``with_requirements`` 补挂的插件的工具名（每件工具都有工具卡声明）；看「被测插件有哪些工具
    到了模型面前」时把它们去掉。"""

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

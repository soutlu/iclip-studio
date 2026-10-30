"""插件替身：build 时交回构造时给的那几项 capability，没有工具卡声明。"""

from __future__ import annotations

from collections.abc import Mapping

from iclip.harness.agents import AgentCapabilities
from iclip.platform.transcript.display import DisplayFn, ToolDisplayEntry
from iclip.plugins.base import CapPlugin, PluginParameters


class FixedPlugin(CapPlugin[PluginParameters]):
    """登记表里放在哪个名字下由测试决定；不要求同挂别的插件。"""

    name = "fixed"
    label = "测试插件"
    description = "测试用。"

    def __init__(self, capabilities: AgentCapabilities) -> None:
        self._capabilities = capabilities

    def build(self, parameters: PluginParameters) -> AgentCapabilities:
        return self._capabilities

    def display_table(self) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}

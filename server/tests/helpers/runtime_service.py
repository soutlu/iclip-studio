"""运行时服务测试的常量与替身：两个应用的密钥（一个有管理权限）与只带一个参数的测试插件。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from agent_runtime.plugins.base import CapPlugin
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai.capabilities import Capability

ADMIN_KEY = "runtime-admin-key-0123456789-abcdefg"
"""有管理权限的应用 ``bff`` 的密钥。"""

READER_KEY = "runtime-reader-key-0123456789-abcdef"
"""没有管理权限的应用 ``reader`` 的密钥。"""


@dataclass
class LimitedPlugin(CapPlugin[Any]):
    """测试插件 ``limited``：带一个整数参数 ``limit``。"""

    label = "限量"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "limited"

    @classmethod
    def from_spec(cls, *, limit: int = 10) -> Capability[Any]:
        return Capability[Any](id="limited", instructions=f"最多 {limit} 条。")

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


__all__ = ["ADMIN_KEY", "READER_KEY", "LimitedPlugin"]

"""按代码里写定的模型找配置页里接的连接：模型供应商域实现查找，插件与给应用的模型调用接口经它直接调上游。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class ModelConnection:
    """调一个模型的 Responses 接口要的地址与密钥。``api_key`` 是明文，不进 repr。"""

    responses_url: str
    """``{接口地址}/responses``。"""

    api_key: str = field(repr=False)


ModelConnectionLookup = Callable[[str, str], Awaitable[ModelConnection]]
"""收（供应商声明名，模型名），交回那个模型此刻的连接；配置页里没有可用的抛
``agent_runtime.errors.ModelUnavailable``。每次调用都现查，配置页的改动下一次调用就生效。"""


__all__ = ["ModelConnection", "ModelConnectionLookup"]

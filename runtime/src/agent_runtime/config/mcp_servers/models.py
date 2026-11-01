"""MCP 服务的领域形状：表里的一行、连接参数、试连结果与发现的工具。术语见 docs/CONTEXT.md「MCP 服务」。"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

McpTransport = Literal["streamable_http", "sse"]
"""连接方式。没有 stdio：运行时不起子进程。"""

MCP_SERVER_ID_PATTERN: Final = re.compile(r"[a-z][a-z0-9-]{0,39}")
"""MCP 服务的标识，规矩同 agent 标识：小写字母开头，后面是小写字母、数字或连字符，最多 40 个字符，创建后
不能改。不含下划线，工具名前缀 ``mcp_<标识>_`` 因此拆得开。"""

MAX_NAME_CHARS: Final = 50
MAX_DESCRIPTION_CHARS: Final = 1024
MAX_URL_CHARS: Final = 2000
MAX_HEADERS: Final = 20
MAX_HEADER_VALUE_CHARS: Final = 4000
MIN_TIMEOUT_SECONDS: Final = 1
MAX_TIMEOUT_SECONDS: Final = 300
DEFAULT_TIMEOUT_SECONDS: Final = 30
"""连接与每次请求等答复的上限（秒）。"""

HEADER_NAME_PATTERN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
"""请求头名按 HTTP 的 token 字符。"""


@dataclass(frozen=True, slots=True)
class McpHeader:
    """一个请求头。``value`` 在存储形态里是密文，在明文形态里是原值。"""

    name: str
    value: str


@dataclass(frozen=True, slots=True)
class McpTool:
    """服务交出的一个工具：服务自己给的名字与说明。"""

    name: str
    description: str | None


@dataclass(frozen=True, slots=True)
class McpCheck:
    """上一次试连：通没通、耗时、没通的原因与时刻。"""

    ok: bool
    elapsed_ms: int
    reason: str | None
    checked_at: datetime


@dataclass(frozen=True, slots=True)
class McpServerRecord:
    """``mcp_servers`` 的一行。``headers`` 是存储形态（值是密文）；``tools`` 是最后一次试连成功时发现的
    工具，从没成功过为 ``None``；``check`` 是最后一次试连，从没试过为 ``None``。"""

    id: str
    name: str
    description: str
    url: str
    transport: McpTransport
    timeout_seconds: int
    headers: tuple[McpHeader, ...]
    enabled: bool
    check: McpCheck | None
    tools: tuple[McpTool, ...] | None
    created_by: uuid.UUID
    updated_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class McpEndpoint:
    """连一个 MCP 服务要的全部：地址、连接方式、时限与明文请求头。"""

    url: str
    transport: McpTransport
    timeout_seconds: int
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class McpProbeResult:
    """一次试连的结果：通了带发现的工具，没通带原因。原因里不带请求头的值。"""

    ok: bool
    elapsed_ms: int
    reason: str | None
    tools: tuple[McpTool, ...] | None


@dataclass(frozen=True, slots=True)
class RuntimeMcpServer:
    """运行时挂一个 MCP 服务要的：标识、名称、明文的连接参数与修改时刻（缓存键用）。"""

    id: str
    name: str
    endpoint: McpEndpoint
    updated_at: datetime


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "HEADER_NAME_PATTERN",
    "MAX_DESCRIPTION_CHARS",
    "MAX_HEADERS",
    "MAX_HEADER_VALUE_CHARS",
    "MAX_NAME_CHARS",
    "MAX_TIMEOUT_SECONDS",
    "MAX_URL_CHARS",
    "MCP_SERVER_ID_PATTERN",
    "MIN_TIMEOUT_SECONDS",
    "McpCheck",
    "McpEndpoint",
    "McpHeader",
    "McpProbeResult",
    "McpServerRecord",
    "McpTool",
    "McpTransport",
    "RuntimeMcpServer",
]

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

McpTransport = Literal["streamable_http", "sse"]

MCP_SERVER_ID_PATTERN: Final = re.compile(r"[a-z][a-z0-9-]{0,39}")

MAX_NAME_CHARS: Final = 50
MAX_DESCRIPTION_CHARS: Final = 1024
MAX_URL_CHARS: Final = 2000
MAX_HEADERS: Final = 20
MAX_HEADER_VALUE_CHARS: Final = 4000
MIN_TIMEOUT_SECONDS: Final = 1
MAX_TIMEOUT_SECONDS: Final = 300
DEFAULT_TIMEOUT_SECONDS: Final = 30

HEADER_NAME_PATTERN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")


@dataclass(frozen=True, slots=True)
class McpHeader:
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class McpTool:
    name: str
    title: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class McpCheck:
    ok: bool
    elapsed_ms: int
    reason: str | None
    checked_at: datetime


@dataclass(frozen=True, slots=True)
class McpServerRecord:
    id: str
    name: str
    description: str
    url: str
    url_hash: str
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
    url: str
    transport: McpTransport
    timeout_seconds: int
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class McpProbeResult:
    ok: bool
    elapsed_ms: int
    reason: str | None
    tools: tuple[McpTool, ...] | None


@dataclass(frozen=True, slots=True)
class RuntimeMcpServer:
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

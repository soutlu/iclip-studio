from __future__ import annotations

from typing import Final, Literal

McpTransport = Literal["streamable_http", "sse"]

McpAuthMode = Literal["shared", "per_user"]

McpClientStatus = Literal["unknown", "automatic", "preset", "required"]

DEFAULT_TIMEOUT_SECONDS: Final = 30


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "McpAuthMode",
    "McpClientStatus",
    "McpTransport",
]

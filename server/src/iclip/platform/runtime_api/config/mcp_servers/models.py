from __future__ import annotations

from typing import Final, Literal

McpTransport = Literal["streamable_http", "sse"]

DEFAULT_TIMEOUT_SECONDS: Final = 30


__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "McpTransport",
]

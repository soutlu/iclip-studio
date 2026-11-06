from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from agent_runtime.agent_usage import AgentUsage
from agent_runtime.config.mcp_servers.models import (
    McpEndpoint,
    McpHeader,
    McpProbeResult,
    McpServerRecord,
    McpTool,
    McpTransport,
)


class McpServerEditor(Protocol):
    @property
    def record(self) -> McpServerRecord: ...

    async def update(
        self,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        clear_check: bool,
        by: uuid.UUID,
    ) -> None: ...

    async def delete(self) -> None: ...


class McpServerStore(Protocol):
    async def list(self) -> tuple[McpServerRecord, ...]: ...

    async def get(self, server_id: str) -> McpServerRecord | None: ...

    async def insert(
        self,
        server_id: str,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        by: uuid.UUID,
    ) -> None: ...

    def edit(self, server_id: str) -> AbstractAsyncContextManager[McpServerEditor]: ...

    async def record_check(
        self,
        server_id: str,
        *,
        ok: bool,
        elapsed_ms: int,
        reason: str | None,
        tools: Sequence[McpTool] | None,
    ) -> bool: ...

    async def rewrite_secrets(
        self, rewrite: Callable[[McpServerRecord], McpServerRecord]
    ) -> int: ...


class McpProbe(Protocol):
    async def probe(self, endpoint: McpEndpoint) -> McpProbeResult: ...


class McpUsages(Protocol):
    async def mcp_server_users(self) -> Mapping[str, tuple[AgentUsage, ...]]: ...


__all__ = ["McpProbe", "McpServerEditor", "McpServerStore", "McpUsages"]

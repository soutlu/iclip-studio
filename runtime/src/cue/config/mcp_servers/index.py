from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from cue.config.mcp_servers.models import McpServerRecord


@dataclass(frozen=True, slots=True)
class IndexedMcpServer:
    name: str
    tools: Mapping[str, str | None]


def _entry(record: McpServerRecord) -> IndexedMcpServer:
    return IndexedMcpServer(
        name=record.name,
        tools=MappingProxyType({one.name: one.title for one in record.tools or ()}),
    )


class McpServerIndex:
    def __init__(self) -> None:
        self._servers: dict[str, IndexedMcpServer] = {}

    def get(self, server_id: str) -> IndexedMcpServer | None:
        return self._servers.get(server_id)

    def replace(self, records: Iterable[McpServerRecord]) -> None:
        self._servers = {record.id: _entry(record) for record in records}

    def put(self, record: McpServerRecord) -> None:
        self._servers[record.id] = _entry(record)

    def remove(self, server_id: str) -> None:
        self._servers.pop(server_id, None)


__all__ = ["IndexedMcpServer", "McpServerIndex"]

"""进程内的 MCP 服务名册：服务标识到名称与最后一次发现的工具说明，给工具卡按标识查。

投影是同步的、只看得到工具名与参数，查不了库；名册在启动时从库里整份读一次，之后由 ``McpServerService``
在每次建、改、删、试连提交之后跟着换。运行时服务是单进程，MCP 服务的写入都经那个服务。"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from agent_runtime.config.mcp_servers.models import McpServerRecord


@dataclass(frozen=True, slots=True)
class IndexedMcpServer:
    """名册里的一个服务：名称，与最后一次试连成功时发现的工具（工具名到说明，没给说明为 ``None``）；
    从没连通过或换了地址后还没再连通时工具为空。"""

    name: str
    tools: Mapping[str, str | None]


def _entry(record: McpServerRecord) -> IndexedMcpServer:
    return IndexedMcpServer(
        name=record.name,
        tools=MappingProxyType({one.name: one.description for one in record.tools or ()}),
    )


class McpServerIndex:
    """服务标识到 ``IndexedMcpServer``。停用的服务照样在册，删掉的不在。"""

    def __init__(self) -> None:
        self._servers: dict[str, IndexedMcpServer] = {}

    def get(self, server_id: str) -> IndexedMcpServer | None:
        return self._servers.get(server_id)

    def replace(self, records: Iterable[McpServerRecord]) -> None:
        """整份换成这些服务。"""

        self._servers = {record.id: _entry(record) for record in records}

    def put(self, record: McpServerRecord) -> None:
        """记下或换掉一个服务。"""

        self._servers[record.id] = _entry(record)

    def remove(self, server_id: str) -> None:
        self._servers.pop(server_id, None)


__all__ = ["IndexedMcpServer", "McpServerIndex"]

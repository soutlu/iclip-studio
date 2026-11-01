"""MCP 服务接到引擎：试连端口的实现，以及把服务的连接参数换成引擎认的形状。"""

from __future__ import annotations

from agent_runtime.config.mcp_servers.public import McpEndpoint, McpProbeResult, McpTool
from agent_runtime.harness.mcp import McpConnection, probe_mcp


def mcp_connection(endpoint: McpEndpoint) -> McpConnection:
    return McpConnection(
        url=endpoint.url,
        transport=endpoint.transport,
        timeout_seconds=endpoint.timeout_seconds,
        headers=dict(endpoint.headers),
    )


class HarnessMcpProbe:
    """``McpProbe`` 的实现：用官方 MCP 客户端连一次、列出工具。"""

    async def probe(self, endpoint: McpEndpoint) -> McpProbeResult:
        outcome = await probe_mcp(mcp_connection(endpoint))
        return McpProbeResult(
            ok=outcome.ok,
            elapsed_ms=outcome.elapsed_ms,
            reason=outcome.reason,
            tools=None
            if outcome.tools is None
            else tuple(
                McpTool(name=one.name, description=one.description) for one in outcome.tools
            ),
        )


__all__ = ["HarnessMcpProbe", "mcp_connection"]

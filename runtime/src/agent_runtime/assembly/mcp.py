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
    async def probe(self, endpoint: McpEndpoint) -> McpProbeResult:
        outcome = await probe_mcp(mcp_connection(endpoint))
        return McpProbeResult(
            ok=outcome.ok,
            elapsed_ms=outcome.elapsed_ms,
            reason=outcome.reason,
            tools=None
            if outcome.tools is None
            else tuple(
                McpTool(name=one.name, title=one.title, description=one.description)
                for one in outcome.tools
            ),
        )


__all__ = ["HarnessMcpProbe", "mcp_connection"]

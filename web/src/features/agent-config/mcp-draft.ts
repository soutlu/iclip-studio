import type { AgentConfig } from './agents.api'
import type { McpServer } from './mcp-servers.api'

type Tool = NonNullable<AgentConfig['tools']>[number]
export type McpBinding = Extract<Tool, { type: 'mcp' }>

const isMcp = (tool: Tool): tool is McpBinding => tool.type === 'mcp'

export const mcpBindings = (config: AgentConfig): McpBinding[] => (config.tools ?? []).filter(isMcp)

export const mcpBindingOf = (config: AgentConfig, serverId: string): McpBinding | undefined =>
  mcpBindings(config).find((binding) => binding.server === serverId)

export const bindMcp = (config: AgentConfig, serverId: string): AgentConfig =>
  mcpBindingOf(config, serverId) === undefined
    ? {
        ...config,
        tools: [
          ...(config.tools ?? []),
          { approval_tools: [], server: serverId, tools: null, type: 'mcp' },
        ],
      }
    : config

export const unbindMcp = (config: AgentConfig, serverId: string): AgentConfig => ({
  ...config,
  tools: (config.tools ?? []).filter((tool) => !isMcp(tool) || tool.server !== serverId),
})

const discovered = (server: McpServer | undefined): string[] =>
  (server?.tools ?? []).map((tool) => tool.name)

export const selectedMcpTools = (binding: McpBinding, server: McpServer | undefined): string[] => {
  const names = discovered(server)
  if (binding.tools === null || binding.tools === undefined) return names
  return names.filter((name) => binding.tools?.includes(name))
}

export const setMcpTool = (
  config: AgentConfig,
  server: McpServer,
  tool: string,
  on: boolean,
): AgentConfig => {
  const binding = mcpBindingOf(config, server.id)
  if (binding === undefined) return config
  const names = discovered(server)
  const current = selectedMcpTools(binding, server)
  const next = on ? [...current, tool] : current.filter((name) => name !== tool)
  const stale = (binding.tools ?? []).filter((name) => !names.includes(name))
  return writeTools(config, server.id, [...names.filter((name) => next.includes(name)), ...stale])
}

export const selectAllMcpTools = (config: AgentConfig, server: McpServer): AgentConfig => {
  const binding = mcpBindingOf(config, server.id)
  if (binding === undefined) return config
  const names = discovered(server)
  const stale = (binding.tools ?? []).filter((name) => !names.includes(name))
  return writeTools(config, server.id, [...names, ...stale])
}

const writeTools = (config: AgentConfig, serverId: string, tools: string[]): AgentConfig => ({
  ...config,
  tools: (config.tools ?? []).map((tool) =>
    isMcp(tool) && tool.server === serverId ? { ...tool, tools } : tool,
  ),
})

export type McpStatus = 'connected' | 'failed' | 'unchecked'

export const MCP_STATUS_LABEL: Record<McpStatus, string> = {
  connected: '已连接',
  failed: '连接失败',
  unchecked: '未测试连接',
}

export const mcpStatusOf = (server: McpServer | undefined): McpStatus =>
  server?.lastCheck === null || server?.lastCheck === undefined
    ? 'unchecked'
    : server.lastCheck.ok
      ? 'connected'
      : 'failed'

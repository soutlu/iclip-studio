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
          { approval_tools: [], server: serverId, tools: [], type: 'mcp' },
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

/** 工具在这个 Agent 上的三种状态：允许、要求审批（调用前要用户同意）、关闭。 */
export type McpToolState = 'allow' | 'ask' | 'off'

export const mcpToolStateOf = (binding: McpBinding, tool: string): McpToolState => {
  const given =
    binding.tools === null || binding.tools === undefined || binding.tools.includes(tool)
  if (!given) return 'off'
  return (binding.approval_tools ?? []).includes(tool) ? 'ask' : 'allow'
}

/**
 * 把 `tools` 里的工具都设成 `state`，其余工具不变。`tools: null`（全部工具）在第一次改动时
 * 写成已发现工具的完整名单；名单里已不在服务上的工具原样保留。
 */
export const setMcpToolStates = (
  config: AgentConfig,
  server: McpServer,
  tools: readonly string[],
  state: McpToolState,
): AgentConfig => {
  const binding = mcpBindingOf(config, server.id)
  if (binding === undefined) return config
  const names = discovered(server)
  const stateOf = (name: string) => (tools.includes(name) ? state : mcpToolStateOf(binding, name))
  const stale = (binding.tools ?? []).filter((name) => !names.includes(name))
  const given = [...names.filter((name) => stateOf(name) !== 'off'), ...stale]
  const approvals = given.filter((name) =>
    names.includes(name) ? stateOf(name) === 'ask' : (binding.approval_tools ?? []).includes(name),
  )
  return {
    ...config,
    tools: (config.tools ?? []).map((tool) =>
      isMcp(tool) && tool.server === server.id
        ? { ...tool, approval_tools: approvals, tools: given }
        : tool,
    ),
  }
}

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

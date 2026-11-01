/**
 * 草稿里挂的 MCP 服务：`config.tools` 里 `type: "mcp"` 的项（合同 §19）。`tools` 为 `null` 是放出服务的全部工具，
 * 以后服务多了工具也跟着放出；写成名单就只放名单里的。名单至少一个工具，空名单保存草稿时就是 422。
 */

import type { AgentConfig } from './agents.api'
import type { McpServer } from './mcp-servers.api'

type Tool = NonNullable<AgentConfig['tools']>[number]
export type McpBinding = Extract<Tool, { type: 'mcp' }>

const isMcp = (tool: Tool): tool is McpBinding => tool.type === 'mcp'

/** 挂着的 MCP 服务，按配置里的先后。 */
export const mcpBindings = (config: AgentConfig): McpBinding[] => (config.tools ?? []).filter(isMcp)

export const mcpBindingOf = (config: AgentConfig, serverId: string): McpBinding | undefined =>
  mcpBindings(config).find((binding) => binding.server === serverId)

/** 挂上一个服务，放出它的全部工具（`tools: null`），排在已有各项之后。已挂着的不动。 */
export const bindMcp = (config: AgentConfig, serverId: string): AgentConfig =>
  mcpBindingOf(config, serverId) === undefined
    ? {
        ...config,
        tools: [...(config.tools ?? []), { server: serverId, tools: null, type: 'mcp' }],
      }
    : config

export const unbindMcp = (config: AgentConfig, serverId: string): AgentConfig => ({
  ...config,
  tools: (config.tools ?? []).filter((tool) => !isMcp(tool) || tool.server !== serverId),
})

/** 服务最后一次发现的工具名；没试连成功过为空。 */
const discovered = (server: McpServer | undefined): string[] =>
  (server?.tools ?? []).map((tool) => tool.name)

/** 放出的工具里在服务最后一次发现的工具之中的那几个；`null` 是全部。 */
export const selectedMcpTools = (binding: McpBinding, server: McpServer | undefined): string[] => {
  const names = discovered(server)
  if (binding.tools === null || binding.tools === undefined) return names
  return names.filter((name) => binding.tools?.includes(name))
}

/**
 * 开或关一个工具，写成名单：按服务发现的先后排，名单里已不在服务上的名字原样留着，留给发布检查标出。
 * 不会写出空名单，关最后一个由界面拦下。
 */
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

/** 全选：写成服务此刻发现的全部工具的名单（不改成 `null`，那样以后服务新加的工具也会放出）。 */
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

/** 服务的连接状态，按最后一次试连：通了、没通、还没试过（新建或改了地址、连接方式后清空）。 */
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

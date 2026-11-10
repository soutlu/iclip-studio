import { describe, expect, it } from 'vitest'
import type { AgentConfig } from './agents.api'
import { mcpBindingOf, mcpToolStateOf, setMcpToolStates } from './mcp-draft'
import type { McpServer } from './mcp-servers.api'

const server = {
  id: 'docs',
  tools: ['search', 'read', 'write'].map((name) => ({ description: null, name, title: null })),
} as McpServer

const configWith = (tools: string[] | null, approvals: string[]): AgentConfig => ({
  instructions: '',
  model: null,
  schema_version: 1,
  subagents: [],
  tools: [{ approval_tools: approvals, server: 'docs', tools, type: 'mcp' }],
})

const bindingOf = (config: AgentConfig) => {
  const binding = mcpBindingOf(config, 'docs')
  if (binding === undefined) throw new Error('没有挂 docs')
  return binding
}

describe('setMcpToolStates', () => {
  it('全部工具（tools: null）第一次改动写成完整名单，已要求审批的保持要求审批', () => {
    const before = configWith(null, ['read'])
    expect(mcpToolStateOf(bindingOf(before), 'search')).toBe('allow')
    expect(mcpToolStateOf(bindingOf(before), 'read')).toBe('ask')

    const after = bindingOf(setMcpToolStates(before, server, ['write'], 'off'))
    expect(after.tools).toEqual(['search', 'read'])
    expect(after.approval_tools).toEqual(['read'])
  })

  it('名单里已不在服务上的工具原样保留，审批随它保留；关掉的工具同时移出审批', () => {
    const before = configWith(['search', 'archive'], ['search', 'archive'])
    const after = bindingOf(setMcpToolStates(before, server, ['search'], 'off'))
    expect(after.tools).toEqual(['archive'])
    expect(after.approval_tools).toEqual(['archive'])
  })
})

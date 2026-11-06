import type { ThinkingLevel } from '@/shared/ui/thinking-level'
import type { Agent, AgentConfig, AgentPlugin, AgentProblem, ProviderOption } from './agents.api'

type Tool = NonNullable<AgentConfig['tools']>[number]
type CapTool = Extract<Tool, { type: 'cap' }>

export type DraftValue = { config: AgentConfig; skillIds: string[] }

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, inner]) => inner !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value

export const sameDraft = (a: DraftValue, b: DraftValue): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const isCap = (tool: Tool): tool is CapTool => tool.type === 'cap'

export const enabledPluginNames = (config: AgentConfig): string[] =>
  (config.tools ?? [])
    .filter(isCap)
    .flatMap((tool) => (tool.enabled === false ? [] : [tool.toolset]))

export const setPluginEnabled = (
  config: AgentConfig,
  name: string,
  on: boolean,
  registry: readonly string[],
): AgentConfig => {
  const tools = config.tools ?? []
  const index = tools.findIndex((tool) => isCap(tool) && tool.toolset === name)
  const existing = index === -1 ? undefined : tools[index]
  if (on) {
    if (existing === undefined) {
      const rank = registry.indexOf(name)
      const before = tools.findIndex(
        (tool) => isCap(tool) && rank !== -1 && registry.indexOf(tool.toolset) > rank,
      )
      const at = before === -1 ? tools.length : before
      const entry: Tool = { enabled: true, parameters: {}, toolset: name, type: 'cap' }
      return { ...config, tools: [...tools.slice(0, at), entry, ...tools.slice(at)] }
    }
    return {
      ...config,
      tools: tools.map((tool, i) => (i === index ? { ...tool, enabled: true } : tool)),
    }
  }
  if (existing === undefined || !isCap(existing)) return config
  const hasParameters = Object.keys(existing.parameters ?? {}).length > 0
  return {
    ...config,
    tools: hasParameters
      ? tools.map((tool, i) => (i === index ? { ...existing, enabled: false } : tool))
      : tools.filter((_, i) => i !== index),
  }
}

export const missingRequiresReason = (
  plugin: AgentPlugin,
  enabled: readonly string[],
  plugins: readonly AgentPlugin[],
): string | undefined => {
  const missing = plugin.requires.filter((name) => !enabled.includes(name))
  if (missing.length === 0) return undefined
  const labels = missing.map((name) => plugins.find((item) => item.name === name)?.label ?? name)
  return `需要同时启用${labels.map((label) => `「${label}」`).join('、')}`
}

export const chooseModel = (
  config: AgentConfig,
  provider: ProviderOption,
  model: ProviderOption['models'][number],
): AgentConfig => {
  const current = config.model ?? null
  const sameProvider = current?.provider === provider.name
  const previous = current?.settings?.thinking ?? null
  const thinking: ThinkingLevel | null =
    model.thinking.length === 0
      ? null
      : previous !== null && model.thinking.includes(previous)
        ? previous
        : model.thinking.includes('medium')
          ? 'medium'
          : (model.thinking[0] ?? null)
  const { thinking: _dropped, ...otherSettings } = current?.settings ?? {}
  return {
    ...config,
    model: {
      ...(sameProvider ? current : {}),
      credential_id: sameProvider ? (current.credential_id ?? null) : null,
      name: model.name,
      provider: provider.name,
      settings: thinking === null ? otherSettings : { ...otherSettings, thinking },
    },
  }
}

export const setThinking = (config: AgentConfig, thinking: ThinkingLevel | null): AgentConfig => {
  if (config.model === null || config.model === undefined) return config
  const { thinking: _previous, ...settings } = config.model.settings ?? {}
  return {
    ...config,
    model: {
      ...config.model,
      settings: thinking === null ? settings : { ...settings, thinking },
    },
  }
}

export const setCredential = (config: AgentConfig, credentialId: string | null): AgentConfig =>
  config.model === null || config.model === undefined
    ? config
    : { ...config, model: { ...config.model, credential_id: credentialId } }

export type EditorSection = 'instructions' | 'skills' | 'plugins' | 'mcp' | 'subagents' | 'general'

export const sectionOfProblem = (problem: AgentProblem, config: AgentConfig): EditorSection => {
  const { path } = problem
  if (path === 'model' || path.startsWith('model.')) return 'instructions'
  if (path.startsWith('skills')) return 'skills'
  if (path.startsWith('subagents')) return 'subagents'
  const tool = /^tools\[(\d+)\]/.exec(path)
  if (tool !== null) {
    const entry = (config.tools ?? [])[Number(tool[1])]
    if (entry === undefined) return 'general'
    return isCap(entry) ? 'plugins' : 'mcp'
  }
  return 'general'
}

export const subagentBlockReason = (
  candidate: Agent,
  current: { isSubagent: boolean },
): string | undefined => {
  if (current.isSubagent) return '当前 Agent 正被用作子 Agent，不能再添加子 Agent'
  if (candidate.status === 'archived') return '已归档，不能选作子 Agent'
  if (candidate.activeVersion === null) return '还没有发布，发布后才能选作子 Agent'
  if (candidate.hasSubagents) return '它自己有子 Agent，不能再被选作子 Agent'
  return undefined
}

export const formatContextSize = (tokens: number): string => {
  const base = tokens % 1024 === 0 ? 1024 : 1000
  if (tokens >= base * base) return `${Math.round((tokens / base / base) * 10) / 10}M`
  if (tokens >= base) return `${Math.round(tokens / base)}K`
  return String(tokens)
}

export const maskedCredential = (fields: Record<string, string>): string | null =>
  Object.values(fields).find((value) => value.startsWith('••••')) ?? null

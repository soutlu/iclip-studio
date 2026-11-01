/**
 * 草稿的纯逻辑：页面只改服务端草稿的一份拷贝里自己管的那几处，其余（MCP 项、插件参数、密钥、提示词）原样带回，
 * 因为保存是整份覆盖（合同 §19「lockVersion」）。另有发布问题归到哪一节、子 agent 能不能选、上下文长度怎么写。
 */

import type { ThinkingLevel } from '@/shared/ui/thinking-level'
import type { Agent, AgentConfig, AgentPlugin, AgentProblem, ProviderOption } from './agents.api'

type Tool = NonNullable<AgentConfig['tools']>[number]
type CapTool = Extract<Tool, { type: 'cap' }>

/** 一份可编辑的草稿：配置文档加按先后绑定的技能。 */
export type DraftValue = { config: AgentConfig; skillIds: string[] }

/** 键序无关、略去 undefined 的比较；配置是 JSON 文档。 */
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

/** 启用着的插件名，按配置里的先后。 */
export const enabledPluginNames = (config: AgentConfig): string[] =>
  (config.tools ?? [])
    .filter(isCap)
    .flatMap((tool) => (tool.enabled === false ? [] : [tool.toolset]))

/**
 * 开或关一个插件。开：已有这一项就置为启用，否则按插件登记表的先后插到插件项里（排在登记表里比它靠后的第一个插件之前），
 * 关了再开回到原位、草稿不算改过；关：带参数的项置为停用、参数留着，没参数的项直接去掉。
 * 不顺带开关它依赖的插件，缺的依赖由界面标出、发布时检查。`registry` 是插件登记表里的插件名，按登记先后。
 */
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

/** 插件要求一起启用、但还没启用的依赖，写成「需要同时启用「工作区文件」」；依赖都在为 undefined。 */
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

/**
 * 选一个模型。换了供应商时密钥回到默认（`credential_id` 置空），同一供应商里换模型保留密钥；
 * 思考档位能沿用就沿用，不在新模型允许的档位里时取「中」或它的第一档，模型不能设档位就去掉。
 */
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

export const setThinking = (config: AgentConfig, thinking: ThinkingLevel): AgentConfig =>
  config.model === null || config.model === undefined
    ? config
    : { ...config, model: { ...config.model, settings: { ...config.model.settings, thinking } } }

/** `null` 是用供应商的默认密钥。 */
export const setCredential = (config: AgentConfig, credentialId: string | null): AgentConfig =>
  config.model === null || config.model === undefined
    ? config
    : { ...config, model: { ...config.model, credential_id: credentialId } }

/** 编辑页上的几节；发布问题按 `path` 落到其中一节，认不出的放在最上面。 */
export type EditorSection = 'instructions' | 'skills' | 'plugins' | 'subagents' | 'general'

/** `path` 写法见合同 §19「发布」；`tools[i]` 按草稿里那一项的种类分：插件归插件一节，MCP 这一版没有对应的节。 */
export const sectionOfProblem = (problem: AgentProblem, config: AgentConfig): EditorSection => {
  const { path } = problem
  if (path === 'model' || path.startsWith('model.')) return 'instructions'
  if (path.startsWith('skills')) return 'skills'
  if (path.startsWith('subagents')) return 'subagents'
  const tool = /^tools\[(\d+)\]/.exec(path)
  if (tool !== null) {
    const entry = (config.tools ?? [])[Number(tool[1])]
    return entry !== undefined && isCap(entry) ? 'plugins' : 'general'
  }
  return 'general'
}

/**
 * 能不能把 `candidate` 选作 `current` 的子 agent；能选为 undefined。规则见 CONTEXT「子 agent」：
 * 子 agent 只有一层，被选的要发布过、没归档、自己没有子 agent，正被别人当作子 agent 的不能再有子 agent。
 */
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

/** 上下文长度写成 128K、1M：整 1024 倍的按 1024 进位，否则按 1000。 */
export const formatContextSize = (tokens: number): string => {
  const base = tokens % 1024 === 0 ? 1024 : 1000
  if (tokens >= base * base) return `${Math.round((tokens / base / base) * 10) / 10}M`
  if (tokens >= base) return `${Math.round(tokens / base)}K`
  return String(tokens)
}

/** 密钥给人认的那一段：第一个打码的字段值（合同 §18 只给 `••••` 加末 4 位），没有就用不上。 */
export const maskedCredential = (fields: Record<string, string>): string | null =>
  Object.values(fields).find((value) => value.startsWith('••••')) ?? null

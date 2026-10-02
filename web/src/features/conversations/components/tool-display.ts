/**
 * 工具卡的数据全部来自服务端的 display / view / metadata：display 画卡头，
 * view 选卡身，metadata 填角标与卡身。工具名属于内部标识，不展示给用户。
 * 标题词表与写法见 docs/tool-design.md §4。
 */

import { z } from 'zod'
import type { ToolCallFrame, TranscriptInteraction } from '@/shared/transcript/vendor'
import type { IconName } from '@/shared/icons'
import { baseName, fileKindOf } from '@/shared/lib/file-kind'
import { workspacePathOf } from '@/shared/workbench'

const fileOperationLabels = {
  edit: '编辑文件',
  glob: '浏览目录',
  grep: '搜索内容',
  read: '读取文件',
  write: '写入文件',
} as const

type FileOperation = keyof typeof fileOperationLabels

const fileOperationIcons: Record<FileOperation, IconName> = {
  edit: 'edit',
  glob: 'folder',
  grep: 'search',
  read: 'file',
  write: 'file',
}

/** 服务端按 pydantic 序列化，可选字段可能是 null 也可能缺席，两种都当没有。 */
const optionalText = z.string().nullish()

const displaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file_io'),
    operation: z.enum(['read', 'write', 'edit', 'glob', 'grep']),
    path: z.string(),
    content: optionalText,
    before: optionalText,
    after: optionalText,
  }),
  z.object({ kind: z.literal('search'), query: z.string(), scope: optionalText }),
  z.object({ kind: z.literal('url_fetch'), url: z.string() }),
  z.object({ kind: z.literal('skill_call'), skill_name: z.string(), args: optionalText }),
  z.object({ kind: z.literal('agent_call'), agent_name: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal('generic'), summary: z.string(), detail: optionalText }),
])

/** 主语最长 60 字，再长就挤掉角标和状态。 */
const DETAIL_MAX = 60

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

/** 仅显示域名与路径；无法解析时按原文截断。 */
const shortUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    return clip(`${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`)
  } catch {
    return clip(url)
  }
}

export type ToolCard = {
  icon: IconName
  /** 标题：书面动宾短语。 */
  label: string
  /** 主语：这一步作用的对象实例；文件只写文件名，不带目录。 */
  detail?: string
  /** 活动组按操作类型聚合；检索按 grep 归类。 */
  operation?: FileOperation
  /** 读、写、改的那份工作区文件（规范化后的键）；路径不合法或操作的是目录时没有。 */
  file?: string
}

/** 这三种操作作用在一份文件上；浏览目录与检索不是。 */
const FILE_TARGET_OPERATIONS: ReadonlySet<FileOperation> = new Set(['read', 'write', 'edit'])

const FALLBACK_CARD: ToolCard = { icon: 'task', label: '调用工具' }

/** 卡头。媒体类结果的兜底卡用图片图标，其余兜底卡用清单图标。 */
export const toolCard = (display: unknown, view?: string): ToolCard => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success) return FALLBACK_CARD
  const card = parsed.data
  switch (card.kind) {
    case 'file_io': {
      const base = {
        icon: fileOperationIcons[card.operation],
        label: fileOperationLabels[card.operation],
        operation: card.operation,
      }
      if (!FILE_TARGET_OPERATIONS.has(card.operation)) return { ...base, detail: card.path }
      const file = workspacePathOf(card.path)
      return file === undefined
        ? { ...base, detail: baseName(card.path) }
        : { ...base, detail: baseName(file), file }
    }
    case 'search':
      return {
        detail: clip(card.query),
        icon: 'search',
        label: '搜索工作区',
        operation: 'grep',
      }
    case 'url_fetch':
      return { detail: shortUrl(card.url), icon: 'external', label: '读取网页' }
    case 'skill_call':
      // 只展示文档名，skill 名不进入界面。
      return card.args
        ? { detail: card.args, icon: 'reference', label: '查阅规范' }
        : { icon: 'reference', label: '查阅规范' }
    case 'agent_call':
      return { detail: clip(card.prompt), icon: 'agent', label: '委派任务' }
    case 'generic': {
      const icon: IconName = view === 'media_grid' ? 'image' : 'task'
      return card.detail
        ? { detail: card.detail, icon, label: card.summary }
        : { icon, label: card.summary }
    }
  }
}

/** 派活卡上的子代理名与任务文本；不是派活卡就没有。 */
export const agentCallOf = (
  display: unknown,
): { agentName: string; prompt: string } | undefined => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success || parsed.data.kind !== 'agent_call') return undefined
  return { agentName: parsed.data.agent_name, prompt: parsed.data.prompt }
}

export type FileChange = { path: string } & (
  { before: string; after: string } | { content: string }
)

/** 审批卡预览用：编辑给前后文，写入给整份内容；别的 display 没有可预览的东西。 */
export const fileChangeOf = (display: unknown): FileChange | undefined => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success || parsed.data.kind !== 'file_io') return undefined
  const { after, before, content, path } = parsed.data
  if (typeof before === 'string' && typeof after === 'string') return { after, before, path }
  if (typeof content === 'string') return { content, path }
  return undefined
}

// --- 结果：metadata 的形状由 view 决定 ---------------------------------------

const fileContentMeta = z.object({
  path: z.string(),
  lines: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

const searchResultsMeta = z.object({
  query: z.string(),
  matches: z.array(z.object({ file: z.string(), line: z.number().int(), text: z.string() })),
  truncated: z.boolean(),
})

const mediaGridMeta = z.object({
  items: z.array(z.object({ caption: z.string(), url: z.string() })),
})

/** 没有卡身渲染器的工具可以声明正文不给展开。 */
const noteMeta = z.object({
  body: z.literal('none').nullish(),
})

export type SearchMatch = z.output<typeof searchResultsMeta>['matches'][number]
export type MediaGridItem = z.output<typeof mediaGridMeta>['items'][number]

type ToolResult =
  | { kind: 'file_content' }
  | { kind: 'search_results'; matches: readonly SearchMatch[]; truncated: boolean }
  | { kind: 'media_grid'; items: readonly MediaGridItem[] }
  | { kind: 'note'; hideBody: boolean }

/** 按 view 解析 metadata；形状对不上就当没有结果，卡退回朴素行。 */
const toolResult = (frame: ToolCallFrame): ToolResult | undefined => {
  switch (frame.view) {
    case 'file_content':
      return fileContentMeta.safeParse(frame.metadata).success
        ? { kind: 'file_content' }
        : undefined
    case 'search_results': {
      const parsed = searchResultsMeta.safeParse(frame.metadata)
      if (!parsed.success) return undefined
      return {
        kind: 'search_results',
        matches: parsed.data.matches,
        truncated: parsed.data.truncated,
      }
    }
    case 'media_grid': {
      const parsed = mediaGridMeta.safeParse(frame.metadata)
      return parsed.success ? { items: parsed.data.items, kind: 'media_grid' } : undefined
    }
    case undefined: {
      const parsed = noteMeta.safeParse(frame.metadata ?? {})
      return parsed.success ? { hideBody: parsed.data.body === 'none', kind: 'note' } : undefined
    }
    default:
      return undefined
  }
}

/** 一次调用给人看的结局：协议给的三态，外加「被拒绝」——它在协议里是 error，审批交互记着 rejected。 */
export type ToolOutcome = ToolCallFrame['state'] | 'denied'

export const toolOutcome = (
  frame: ToolCallFrame,
  interactions: ReadonlyMap<string, TranscriptInteraction>,
): ToolOutcome => {
  if (frame.state !== 'error' || frame.approvalId === undefined) return frame.state
  return interactions.get(frame.approvalId)?.state === 'rejected' ? 'denied' : 'error'
}

/** 行尾只留检索的命中数；行数、增删数、张数都不上行尾。 */
export const toolSearchCount = (frame: ToolCallFrame): string | undefined => {
  const result = toolResult(frame)
  if (result?.kind !== 'search_results') return undefined
  return result.matches.length === 0 ? '无命中' : `${result.matches.length} 处命中`
}

/** 仅展示已完成且形状合法的媒体墙；活动分组复用此判据，保证媒体始终可见。 */
export const toolMedia = (frame: ToolCallFrame): readonly MediaGridItem[] => {
  if (frame.state !== 'done') return []
  const result = toolResult(frame)
  return result?.kind === 'media_grid' ? result.items : []
}

/** 能展开看的原始结果：多行字符串，且工具没声明不给看。一句话的结果卡头已经说完。 */
export const toolBodyText = (frame: ToolCallFrame): string | undefined => {
  if (typeof frame.output !== 'string' || !frame.output.includes('\n')) return undefined
  const result = toolResult(frame)
  return result?.kind === 'note' && result.hideBody ? undefined : frame.output
}

// --- 详情面板：展开后看的东西 --------------------------------------------------

const NUMBERED_LINE = /^\s*\d+\t(.*)$/

/**
 * 读文件的返回每行带「行号 + 制表符」，末尾可能跟几句写给模型的续读提示。
 * 给人看的只要文件本身：去掉行号，提示句不是文件内容，不要。
 */
export const fileTextOf = (output: string): string =>
  output
    .split('\n')
    .flatMap((line) => {
      const match = NUMBERED_LINE.exec(line)
      return match === null ? [] : [match[1] ?? '']
    })
    .join('\n')

export type DiffLine = { kind: 'context' | 'removed' | 'added'; text: string }

/** 一次替换改了哪些行：首尾相同的行是上下文，中间是真正改了的部分，先列删掉的、再列新写的。 */
export const diffLinesOf = (before: string, after: string): DiffLine[] => {
  const old = before.split('\n')
  const next = after.split('\n')
  let head = 0
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1
  let tail = 0
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1
  }
  const context = (text: string): DiffLine => ({ kind: 'context', text })
  return [
    ...old.slice(0, head).map(context),
    ...old.slice(head, old.length - tail).map((text): DiffLine => ({ kind: 'removed', text })),
    ...next.slice(head, next.length - tail).map((text): DiffLine => ({ kind: 'added', text })),
    ...old.slice(old.length - tail).map(context),
  ]
}

/**
 * 展开后的面板，照 Kimi ToolPanel：失败给错误原文，读写给文件内容，编辑给改动行，检索给命中，
 * 其余多行结果给原文。被拒绝与运行中的调用没有面板；没有可看的东西也没有。
 */
export type ToolPanel =
  | { kind: 'error'; text: string }
  | { kind: 'file'; text: string; markdown: boolean }
  | { kind: 'diff'; before: string; after: string }
  | { kind: 'matches'; matches: readonly SearchMatch[]; truncated: boolean }
  | { kind: 'text'; text: string }

export const toolPanel = (frame: ToolCallFrame, outcome: ToolOutcome): ToolPanel | undefined => {
  if (outcome === 'running' || outcome === 'denied') return undefined
  if (outcome === 'error')
    return frame.error === undefined ? undefined : { kind: 'error', text: frame.error }
  const parsed = displaySchema.safeParse(frame.display)
  const display = parsed.success ? parsed.data : undefined
  if (display?.kind === 'file_io') {
    const markdown = fileKindOf(display.path).kind === 'markdown'
    if (display.operation === 'read' && toolResult(frame)?.kind === 'file_content') {
      return typeof frame.output === 'string'
        ? { kind: 'file', markdown, text: fileTextOf(frame.output) }
        : undefined
    }
    if (display.operation === 'write' && typeof display.content === 'string') {
      return { kind: 'file', markdown, text: display.content }
    }
    if (
      display.operation === 'edit' &&
      typeof display.before === 'string' &&
      typeof display.after === 'string'
    ) {
      return { after: display.after, before: display.before, kind: 'diff' }
    }
  }
  const result = toolResult(frame)
  if (result?.kind === 'search_results') {
    return result.matches.length === 0
      ? undefined
      : { kind: 'matches', matches: result.matches, truncated: result.truncated }
  }
  const text = toolBodyText(frame)
  return text === undefined ? undefined : { kind: 'text', text }
}

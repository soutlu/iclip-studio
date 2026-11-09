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

const DETAIL_MAX = 60

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

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
  label: string
  detail?: string
  operation?: FileOperation
  file?: string
}

const FILE_TARGET_OPERATIONS: ReadonlySet<FileOperation> = new Set(['read', 'write', 'edit'])

const FALLBACK_CARD: ToolCard = { icon: 'task', label: '调用工具' }

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
      return card.args
        ? { detail: card.args, icon: 'reference', label: '查阅规范' }
        : { icon: 'reference', label: '查阅规范' }
    case 'agent_call':
      return { detail: clip(card.prompt), icon: 'agent', label: '委派任务' }
    case 'generic': {
      const icon: IconName = view === 'media_grid' ? 'image' : 'task'
      return card.detail
        ? { detail: clip(card.detail), icon, label: card.summary }
        : { icon, label: card.summary }
    }
  }
}

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

export const fileChangeOf = (display: unknown): FileChange | undefined => {
  const parsed = displaySchema.safeParse(display)
  if (!parsed.success || parsed.data.kind !== 'file_io') return undefined
  const { after, before, content, path } = parsed.data
  if (typeof before === 'string' && typeof after === 'string') return { after, before, path }
  if (typeof content === 'string') return { content, path }
  return undefined
}

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
  items: z.array(z.object({ caption: z.string().optional(), url: z.string() })),
})

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

export type ToolOutcome = ToolCallFrame['state'] | 'denied'

export const toolOutcome = (
  frame: ToolCallFrame,
  interactions: ReadonlyMap<string, TranscriptInteraction>,
): ToolOutcome => {
  if (frame.state !== 'error' || frame.approvalId === undefined) return frame.state
  return interactions.get(frame.approvalId)?.state === 'rejected' ? 'denied' : 'error'
}

export const toolSearchCount = (frame: ToolCallFrame): string | undefined => {
  const result = toolResult(frame)
  if (result?.kind !== 'search_results') return undefined
  return result.matches.length === 0 ? '无命中' : `${result.matches.length} 处命中`
}

export const toolMedia = (frame: ToolCallFrame): readonly MediaGridItem[] => {
  if (frame.state !== 'done') return []
  const result = toolResult(frame)
  return result?.kind === 'media_grid' ? result.items : []
}

export const toolBodyText = (frame: ToolCallFrame): string | undefined => {
  if (typeof frame.output !== 'string' || !frame.output.includes('\n')) return undefined
  const result = toolResult(frame)
  return result?.kind === 'note' && result.hideBody ? undefined : frame.output
}

const NUMBERED_LINE = /^\s*\d+\t(.*)$/

export const fileTextOf = (output: string): string =>
  output
    .split('\n')
    .flatMap((line) => {
      const match = NUMBERED_LINE.exec(line)
      return match === null ? [] : [match[1] ?? '']
    })
    .join('\n')

export type DiffLine = { kind: 'context' | 'removed' | 'added'; text: string }

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

export type ToolPanel =
  | { kind: 'file'; text: string; markdown: boolean }
  | { kind: 'diff'; before: string; after: string }
  | { kind: 'matches'; matches: readonly SearchMatch[]; truncated: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'error'; text: string }

export const toolPanel = (frame: ToolCallFrame, outcome: ToolOutcome): ToolPanel | undefined => {
  if (outcome === 'error') {
    return frame.error === undefined || frame.error === ''
      ? undefined
      : { kind: 'error', text: frame.error }
  }
  if (outcome !== 'done') return undefined
  const parsed = displaySchema.safeParse(frame.display)
  const display = parsed.success ? parsed.data : undefined
  if (display?.kind === 'file_io') {
    const markdown = fileKindOf(display.path) === 'markdown'
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

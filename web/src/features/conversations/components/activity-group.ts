import type {
  ToolCallFrame,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
} from '@/shared/transcript/vendor'
import { toolCard, toolMedia, toolOutcome } from './tool-display'

export type TurnEntry = {
  frame: TranscriptFrame
  step: TranscriptStep
}

export type ActivityNode =
  { kind: 'entry'; entry: TurnEntry } | { kind: 'run'; runId: string; items: readonly TurnEntry[] }

export type SummaryClause = {
  text: string
  tone?: 'danger' | 'faint'
  pinned?: boolean
}

const foldable = (frame: TranscriptFrame) =>
  frame.kind === 'thinking' ||
  (frame.kind === 'tool' && toolMedia(frame).length === 0 && (frame.agentRefs?.length ?? 0) === 0)

export const groupTurnEntries = (entries: readonly TurnEntry[]): ActivityNode[] => {
  const out: ActivityNode[] = []
  let buffer: TurnEntry[] = []

  const flush = () => {
    if (buffer.length >= 2 && buffer.some((entry) => entry.frame.kind === 'tool')) {
      out.push({ items: buffer, kind: 'run', runId: `${buffer[0]?.frame.frameId}.run` })
    } else {
      for (const entry of buffer) out.push({ entry, kind: 'entry' })
    }
    buffer = []
  }

  for (const entry of entries) {
    if (foldable(entry.frame)) {
      buffer.push(entry)
    } else {
      flush()
      out.push({ entry, kind: 'entry' })
    }
  }
  flush()
  return out
}

export type TurnBlock =
  | { kind: 'card'; cardId: string; nodes: readonly ActivityNode[] }
  | { kind: 'entry'; entry: TurnEntry }

export const groupActivityCards = (nodes: readonly ActivityNode[]): TurnBlock[] => {
  const out: TurnBlock[] = []
  let card: ActivityNode[] = []

  const flush = () => {
    const first = card[0]
    if (first !== undefined) {
      const key = first.kind === 'run' ? first.runId : first.entry.frame.frameId
      out.push({ cardId: `${key}.card`, kind: 'card', nodes: card })
    }
    card = []
  }

  for (const node of nodes) {
    if (node.kind === 'run' || node.entry.frame.kind === 'tool') {
      card.push(node)
    } else {
      flush()
      out.push({ entry: node.entry, kind: 'entry' })
    }
  }
  flush()
  return out
}

export const formatActivityDuration = (ms: number): string => {
  if (ms < 1000) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m${restSeconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
}

type ToolFrame = ToolCallFrame
type Interactions = ReadonlyMap<string, TranscriptInteraction>

export const failedTools = (items: readonly TurnEntry[], interactions: Interactions): TurnEntry[] =>
  items.filter(({ frame }) => frame.kind === 'tool' && toolOutcome(frame, interactions) === 'error')

const bucketKey = (frame: ToolFrame): string => {
  const { label, operation } = toolCard(frame.display, frame.view)
  if (operation !== undefined) return `op:${operation}`
  return label === FALLBACK_LABEL ? 'other' : `summary:${label}`
}

const FALLBACK_LABEL = toolCard(undefined).label

const doneClause = (key: string, count: number, live: boolean): string => {
  const prefix = live ? '已' : ''
  if (key.startsWith('op:')) {
    const operation = key.slice(3) as keyof typeof OPERATION_LABELS
    return `${prefix}${OPERATION_LABELS[operation](count)}`
  }
  if (key === 'other') return `${prefix}执行 ${count} 次操作`
  return `${prefix}${key.slice(8)} ×${count}`
}

const OPERATION_LABELS = {
  read: (n: number) => `读取 ${n} 个文件`,
  write: (n: number) => `写入 ${n} 个文件`,
  edit: (n: number) => `编辑 ${n} 处`,
  glob: (n: number) => `浏览 ${n} 个目录`,
  grep: (n: number) => `搜索 ${n} 次`,
} as const

const doingClause = (frame: TranscriptFrame): string => {
  if (frame.kind === 'thinking') return '思考中…'
  if (frame.kind !== 'tool') return ''
  const { detail, label, operation } = toolCard(frame.display, frame.view)
  const subject = detail === undefined ? '' : ` ${detail}`
  if (operation === undefined) return `正在${label}${subject}`
  return `${DOING_VERB[operation]}${subject}`
}

const DOING_VERB = {
  read: '正在读取',
  write: '正在写入',
  edit: '正在编辑',
  glob: '正在浏览',
  grep: '正在搜索',
} as const

const aggregate = (
  tools: readonly ToolFrame[],
  live: boolean,
  interactions: Interactions,
): SummaryClause[] => {
  const buckets = new Map<string, { count: number; errors: number; denied: number }>()
  for (const frame of tools) {
    const key = bucketKey(frame)
    const bucket = buckets.get(key) ?? { count: 0, denied: 0, errors: 0 }
    bucket.count += 1
    const outcome = toolOutcome(frame, interactions)
    if (outcome === 'error') bucket.errors += 1
    if (outcome === 'denied') bucket.denied += 1
    buckets.set(key, bucket)
  }
  const clauses: SummaryClause[] = []
  for (const [key, bucket] of buckets) {
    clauses.push({ text: doneClause(key, bucket.count, live) })
    if (bucket.errors > 0) {
      clauses.push({ pinned: true, text: `（${bucket.errors} 失败）`, tone: 'danger' })
    }
    if (bucket.denied > 0) {
      clauses.push({ pinned: true, text: `（${bucket.denied} 已拒绝）`, tone: 'faint' })
    }
  }
  return clauses
}

export const summarizeDone = (
  items: readonly TurnEntry[],
  durationMs: number | undefined,
  interactions: Interactions,
): SummaryClause[] => {
  const tools = items.flatMap((entry) => (entry.frame.kind === 'tool' ? [entry.frame] : []))
  const clauses = aggregate(tools, false, interactions)
  const duration = durationMs === undefined ? '' : formatActivityDuration(durationMs)
  if (duration !== '') clauses.push({ pinned: true, text: duration, tone: 'faint' })
  return clauses
}

export const summarizeRunning = (
  items: readonly TurnEntry[],
  liveFrameId: string | undefined,
  elapsedMs: number | undefined,
  interactions: Interactions,
): SummaryClause[] => {
  const current =
    items.find((entry) => entry.frame.frameId === liveFrameId) ??
    items.find((entry) => entry.frame.kind === 'tool' && entry.frame.state === 'running') ??
    items.at(-1)
  const done = items.flatMap((entry) =>
    entry.frame.kind === 'tool' &&
    entry.frame.frameId !== current?.frame.frameId &&
    entry.frame.state !== 'running'
      ? [entry.frame]
      : [],
  )
  const clauses: SummaryClause[] = []
  if (current !== undefined) {
    const text = doingClause(current.frame)
    if (text !== '') clauses.push({ text })
  }
  clauses.push(
    ...aggregate(done, true, interactions).map((clause) => ({ ...clause, tone: 'faint' as const })),
  )
  const elapsed = elapsedMs === undefined ? '' : formatActivityDuration(elapsedMs)
  if (elapsed !== '') clauses.push({ pinned: true, text: elapsed, tone: 'faint' })
  return clauses
}

export const runHistoryMs = (items: readonly TurnEntry[]): number | undefined => {
  const steps = new Map<string, TranscriptStep>()
  for (const { step } of items) steps.set(step.stepId, step)
  let start: number | undefined
  let end: number | undefined
  for (const step of steps.values()) {
    if (step.startedAt !== undefined) {
      const at = Date.parse(step.startedAt)
      if (!Number.isNaN(at)) start = start === undefined ? at : Math.min(start, at)
    }
    if (step.endedAt !== undefined) {
      const at = Date.parse(step.endedAt)
      if (!Number.isNaN(at)) end = end === undefined ? at : Math.max(end, at)
    }
  }
  if (start === undefined || end === undefined || end < start) return undefined
  return end - start
}

import { useEffect, useRef, useState } from 'react'
import type { TranscriptInteraction, TranscriptTask } from '@/shared/transcript/vendor'
import { cn } from '@/shared/lib/utils'
import {
  failedTools,
  runHistoryMs,
  summarizeDone,
  summarizeRunning,
  type SummaryClause,
  type TurnEntry,
} from './activity-group'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { TurnFrame } from './turn-frame'

type ActivityRunProps = {
  items: readonly TurnEntry[]
  liveFrameId: string | undefined
  settled: boolean
  interactions: ReadonlyMap<string, TranscriptInteraction>
  toolTasks: ReadonlyMap<string, TranscriptTask>
}

function useActivityMs(running: boolean, historyMs: number | undefined): number | undefined {
  const startedRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!running) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const tick = () => setElapsed(Date.now() - started)
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [running])

  if (running) return elapsed ?? 0
  return elapsed ?? historyMs
}

const CLAUSE_TONE_CLASS = {
  faint: 'text-chat-muted-text',
} as const

const toneClass = (clause: SummaryClause) =>
  clause.tone === undefined ? undefined : CLAUSE_TONE_CLASS[clause.tone]

export function ActivityRun({
  interactions,
  items,
  liveFrameId,
  settled,
  toolTasks,
}: ActivityRunProps) {
  const running =
    !settled &&
    items.some(
      (entry) =>
        entry.frame.frameId === liveFrameId ||
        (entry.frame.kind === 'tool' && entry.frame.state === 'running'),
    )
  const failed = failedTools(items, interactions)

  const [open, setOpen] = useState(running)
  const [prevRunning, setPrevRunning] = useState(running)
  if (running !== prevRunning) {
    setPrevRunning(running)
    setOpen(running)
  }

  const elapsedMs = useActivityMs(running, runHistoryMs(items))
  const clauses = running
    ? summarizeRunning(items, liveFrameId, elapsedMs, interactions)
    : summarizeDone(items, elapsedMs, interactions)
  const stateLabel = running ? '进行中' : failed.length > 0 ? '有失败' : '已完成'
  const summaryText = clauses.map((clause) => clause.text).join(' · ')
  const seen = new Map<string, number>()
  const keyed = clauses.map((clause) => {
    const base = `${clause.tone ?? ''}:${clause.text}`
    const nth = (seen.get(base) ?? 0) + 1
    seen.set(base, nth)
    return { clause, key: `${base}:${nth}` }
  })
  const flowing = keyed.filter(({ clause }) => clause.pinned !== true)
  const pinned = keyed.filter(({ clause }) => clause.pinned === true)

  const frameOf = (entry: TurnEntry) => (
    <TurnFrame
      frame={entry.frame}
      interactions={interactions}
      key={entry.frame.frameId}
      live={entry.frame.frameId === liveFrameId}
      toolTasks={toolTasks}
    />
  )

  return (
    <div className="flex flex-col">
      <button
        aria-expanded={open}
        aria-label={`${stateLabel}：${summaryText}`}
        className="group/head flex min-h-5 w-full min-w-0 cursor-pointer items-center gap-2 rounded-xs text-left text-body leading-5 text-chat-secondary-text ui-focus ui-motion-s hover:text-chat-message-text"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span aria-hidden className="flex min-w-0 items-center">
          <span className="min-w-0 truncate">
            {flowing.map(({ clause, key }, index) => (
              <span className={toneClass(clause)} key={key}>
                {index === 0 ? clause.text : ` · ${clause.text}`}
              </span>
            ))}
          </span>
          {pinned.map(({ clause, key }) => (
            <span className={cn('shrink-0 whitespace-pre', toneClass(clause))} key={key}>
              {flowing.length === 0 ? clause.text : ` · ${clause.text}`}
            </span>
          ))}
        </span>
        <DisclosureChevron
          className="text-chat-muted-text ui-motion-s group-hover/head:text-chat-message-text"
          open={open}
        />
      </button>
      <DisclosureBody open={open}>
        <div className="flex flex-col gap-2 pt-2.5">{items.map(frameOf)}</div>
      </DisclosureBody>
    </div>
  )
}

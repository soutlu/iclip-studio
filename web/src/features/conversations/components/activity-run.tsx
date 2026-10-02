/**
 * 参考 Kimi activity-run：卡头一行摘要加紧跟的小箭头；运行时自动展开，结束后自动收起，用户点过就以用户为准。
 * 收起时组里失败的那几次调用照样露在卡头下面——只看每次调用自己的状态，不看前后有没有补救。
 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptInteraction } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
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
}

/** 运行时本地计时并在结束时冻结；历史记录使用步骤起止时间，缺失时不显示。 */
function useActivityMs(running: boolean, historyMs: number | undefined): number | undefined {
  const startedRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!running) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const tick = () => setElapsed(Date.now() - started)
    // 立即记录初始读数，避免一秒内结束的活动没有计时结果。
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
  danger: 'text-chat-status-error',
  faint: 'text-chat-muted-text',
} as const

const toneClass = (clause: SummaryClause) =>
  clause.tone === undefined ? undefined : CLAUSE_TONE_CLASS[clause.tone]

export function ActivityRun({ interactions, items, liveFrameId, settled }: ActivityRunProps) {
  const running =
    !settled &&
    items.some(
      (entry) =>
        entry.frame.frameId === liveFrameId ||
        (entry.frame.kind === 'tool' && entry.frame.state === 'running'),
    )
  const failed = failedTools(items, interactions)

  // 用户手动切换后，自动开合不再覆盖其选择，直到下一次运行状态变化。
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
  const stateLabel = running ? '进行中' : failed.length > 0 ? '有失败' : '完成'
  // 显式提供 aria-label，避免分色 span 的边界空白被可访问名称计算裁掉。
  const summaryText = clauses.map((clause) => clause.text).join(' · ')
  // 以内容和出现次数组成 key，区分相同的失败子句。
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
        {running ? (
          <Icon
            className="shrink-0 animate-spin text-chat-status-running"
            decorative
            name="loading"
            size="sm"
          />
        ) : null}
        {/* 摘要正文窄屏下截断；失败数、拒绝数与时长钉在后面不被截掉（照 mockup 的 .sum 与 .pin）。 */}
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
      {open || failed.length === 0 ? null : (
        <div className="flex flex-col gap-2 pt-2.5">{failed.map(frameOf)}</div>
      )}
      <DisclosureBody open={open}>
        <div className="flex flex-col gap-2 pt-2.5">{items.map(frameOf)}</div>
      </DisclosureBody>
    </div>
  )
}

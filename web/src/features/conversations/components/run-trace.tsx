/** 运行过程：一段对话每一轮的步骤清单，图标、名称、耗时一行，点开看这一步调了什么。数据见 run-steps。 */

import { useState } from 'react'
import { useTranscript } from '@/shared/transcript/use-transcript'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { DisclosureBody } from './disclosure'
import { durationLabel, runTurns, type RunCall, type RunStep, type RunTurn } from './run-steps'
import type { ToolOutcome } from './tool-display'

const OUTCOME_LABELS: Partial<Record<ToolOutcome, string>> = {
  denied: '已拒绝',
  error: '失败',
  running: '进行中',
}

/** 会话还没开（`conversationId` 为 null）时是空的。 */
export function RunTrace({ conversationId }: { conversationId: string | null }) {
  const { view } = useTranscript(conversationId)
  const turns = runTurns(
    view.items.filter((item) => item.kind === 'turn'),
    view.interactions,
  )
  if (turns.length === 0)
    return (
      <p className="px-6 py-16 text-center text-body-sm text-on-surface-variant">
        暂无运行记录，请先在「测试预览」发送一条消息
      </p>
    )
  return (
    <div aria-label="运行过程" className="flex flex-col gap-6 px-6 pt-4 pb-8" role="region">
      {turns.map((turn) => (
        <TurnSteps key={turn.turnId} turn={turn} />
      ))}
    </div>
  )
}

function TurnSteps({ turn }: { turn: RunTurn }) {
  const title = turn.prompt.trim() === '' ? '附件消息' : turn.prompt
  return (
    <section aria-label={title} className="flex flex-col">
      <header className="flex items-center gap-3 pb-1 text-body-sm text-on-surface-variant">
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        <Tail
          durationMs={turn.durationMs}
          failed={turn.state === 'failed'}
          running={turn.state === 'running' || turn.state === 'queued'}
        />
      </header>
      <ol className="flex flex-col">
        {turn.steps.map((step) => (
          <li className="border-b border-hairline" key={step.id}>
            <StepRow step={step} />
          </li>
        ))}
      </ol>
    </section>
  )
}

const expandable = (step: RunStep): boolean => {
  if (step.calls.length > 1) return true
  const [call] = step.calls
  return (
    call !== undefined && (call.detail !== undefined || OUTCOME_LABELS[call.outcome] !== undefined)
  )
}

function StepRow({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false)
  const canOpen = expandable(step)
  const head = (
    <>
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-sm bg-surface-container-high text-on-surface-variant"
      >
        <Icon decorative name={step.icon} size="sm" />
      </span>
      <span className="min-w-0 flex-1 truncate text-body text-on-surface">{step.label}</span>
      <Tail
        durationMs={step.durationMs}
        failed={step.state === 'failed' || step.state === 'interrupted'}
        running={step.state === 'running'}
      />
      {canOpen ? (
        <Icon
          className={cn(
            'shrink-0 text-on-surface-variant transition-transform duration-(--dur-s) ease-(--ease)',
            open && 'rotate-180',
          )}
          decorative
          name="expand"
          size="sm"
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}
    </>
  )
  const rowClass = 'flex min-h-13 w-full items-center gap-3 py-2.5 text-left'
  if (!canOpen) return <div className={rowClass}>{head}</div>
  return (
    <>
      <button
        aria-expanded={open}
        className={cn(rowClass, 'cursor-pointer rounded-xs ui-focus')}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {head}
      </button>
      <DisclosureBody open={open}>
        <div className="pb-3 pl-11">
          {step.calls.length === 1 && step.calls[0] !== undefined ? (
            <CallLine call={step.calls[0]} showLabel={false} />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {step.calls.map((call) => (
                <li key={call.id}>
                  <CallLine call={call} showLabel />
                </li>
              ))}
            </ul>
          )}
        </div>
      </DisclosureBody>
    </>
  )
}

function CallLine({ call, showLabel }: { call: RunCall; showLabel: boolean }) {
  const outcome = OUTCOME_LABELS[call.outcome]
  return (
    <p className="flex min-w-0 items-center gap-2 text-body-sm text-on-surface-variant">
      {showLabel ? <CallIcon name={call.icon} /> : null}
      {showLabel ? <span className="shrink-0 text-on-surface">{call.label}</span> : null}
      {call.detail === undefined ? null : <span className="min-w-0 truncate">{call.detail}</span>}
      {outcome === undefined ? null : (
        <span className={cn('shrink-0', call.outcome === 'error' && 'text-error')}>{outcome}</span>
      )}
    </p>
  )
}

function CallIcon({ name }: { name: IconName }) {
  return <Icon className="shrink-0" decorative name={name} size="xs" />
}

/** 行尾：在跑转圈，失败红 ×，跑完写耗时；没有起止时刻就不写。 */
function Tail({
  durationMs,
  failed,
  running,
}: {
  durationMs: number | undefined
  failed: boolean
  running: boolean
}) {
  if (running)
    return (
      <Icon
        className="shrink-0 animate-spin text-on-surface-variant"
        label="进行中"
        name="loading"
        size="sm"
      />
    )
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-body-sm text-on-surface-variant tabular-nums">
      {failed ? <Icon className="text-error" label="失败" name="failed" size="sm" /> : null}
      {durationMs === undefined ? null : durationLabel(durationMs)}
    </span>
  )
}

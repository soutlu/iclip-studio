/**
 * 输入框上方的后台任务卡，不随对话滚动：只列进行中的后台工具任务，各自按开始时间每秒计时。
 * 一个任务直接写「正在…」；多个时汇总成一行，点开后列表在这一行上方展开。
 */

import { useEffect, useId, useState } from 'react'
import type { TranscriptTask } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { formatActivityDuration } from './activity-group'
import { DisclosureBody } from './disclosure'

type BackgroundTaskBarProps = {
  /** 本段对话的任务；只取 kind 为 tool、仍在进行中的那些。 */
  tasks: ReadonlyMap<string, TranscriptTask>
}

const ROW = 'flex min-w-0 items-center gap-2 px-3.5 py-2 text-body-sm text-chat-secondary-text'
const FRAME = 'rounded-lg border-[0.5px] border-chat-hairline bg-top-layer'

export function BackgroundTaskBar({ tasks }: BackgroundTaskBarProps) {
  const running = [...tasks.values()].filter(
    (task) => task.kind === 'tool' && task.state === 'running',
  )
  if (running.length === 0) return null
  // 计时只在有任务时挂载：起点取挂载那一刻，不拿很久以前的读数算第一秒。
  return <RunningTasks tasks={running} />
}

/** 每秒取一次当前时间；整张卡共用一个计时器，不是每行一个。 */
function useNow(): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

const doingLabel = (task: TranscriptTask): string =>
  task.description === undefined ? '后台任务进行中' : `正在${task.description}`

/** 不足一秒、没有开始时间或时间读不出来时不写。 */
const elapsedOf = (task: TranscriptTask, now: number): string | undefined => {
  const started = task.startedAt === undefined ? Number.NaN : Date.parse(task.startedAt)
  if (Number.isNaN(started)) return undefined
  const text = formatActivityDuration(Math.max(0, now - started))
  return text === '' ? undefined : text
}

function TaskRow({ now, task }: { now: number; task: TranscriptTask }) {
  const elapsed = elapsedOf(task, now)
  return (
    <>
      <Icon className="shrink-0 text-chat-muted-text" decorative name="duration" size="sm" />
      <span className="min-w-0 flex-1 truncate">{doingLabel(task)}</span>
      {elapsed === undefined ? null : (
        <span className="shrink-0 text-chat-muted-text tabular-nums">{elapsed}</span>
      )}
    </>
  )
}

function RunningTasks({ tasks }: { tasks: readonly TranscriptTask[] }) {
  const now = useNow()
  const [open, setOpen] = useState(false)
  const listId = useId()
  const [only] = tasks

  if (tasks.length === 1 && only !== undefined) {
    return (
      <p aria-label="后台任务" className={cn('mb-2', ROW, FRAME)} role="note">
        <TaskRow now={now} task={only} />
      </p>
    )
  }

  return (
    // DOM 里按钮在前、列表在后，读屏与键盘顺序照常；画面上列表翻到按钮上方展开。
    <div aria-label="后台任务" className="mb-2 flex flex-col-reverse" role="group">
      <button
        aria-controls={listId}
        aria-expanded={open}
        className={cn(ROW, FRAME, 'w-full ui-state cursor-pointer text-left ui-focus')}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <Icon className="shrink-0 text-chat-muted-text" decorative name="duration" size="sm" />
        <span className="min-w-0 flex-1 truncate">{tasks.length} 个后台任务进行中</span>
        <Icon
          className={cn(
            'shrink-0 text-chat-muted-text transition-transform duration-(--dur-s) ease-(--ease)',
            open && 'rotate-180',
          )}
          decorative
          name="collapse"
          size="xs"
        />
      </button>
      <div id={listId}>
        <DisclosureBody open={open}>
          <ul className={cn('mb-2 divide-y-[0.5px] divide-chat-hairline', FRAME)}>
            {tasks.map((task) => (
              <li className={ROW} key={task.taskId}>
                <TaskRow now={now} task={task} />
              </li>
            ))}
          </ul>
        </DisclosureBody>
      </div>
    </div>
  )
}

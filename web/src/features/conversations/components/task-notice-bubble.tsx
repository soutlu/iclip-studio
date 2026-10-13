/**
 * 后台任务的完成通知：结果到达处插进来的那一块，role 是 user 但不是人说的话。
 * 与用户气泡同形状、靠右，只描细边、不填底色；图标看任务状态，第二行是任务用时。没有复制、修改等操作。
 */

import type { TranscriptTask } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { formatActivityDuration } from './activity-group'

type TaskNoticeBubbleProps = {
  text: string
  /** 通知对应的后台工具任务；找不到时只写文字，不猜状态。 */
  task: TranscriptTask | undefined
}

/** 开始与结束时间都读得出来才算；不足一秒的不写。 */
const durationOf = (task: TranscriptTask | undefined): string | undefined => {
  if (task?.startedAt === undefined || task.endedAt === undefined) return undefined
  const ms = Date.parse(task.endedAt) - Date.parse(task.startedAt)
  if (Number.isNaN(ms)) return undefined
  const text = formatActivityDuration(Math.max(0, ms))
  return text === '' ? undefined : text
}

export function TaskNoticeBubble({ task, text }: TaskNoticeBubbleProps) {
  const duration = durationOf(task)
  const icon =
    task?.state === 'failed' ? (
      <Icon className="text-chat-status-error" label="失败" name="failed" size="md" />
    ) : task?.state === 'completed' ? (
      <Icon className="text-chat-secondary-text" label="已完成" name="check" size="md" />
    ) : null
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[min(80%,100vw-52px)] min-w-0 items-start gap-2 rounded-xl rounded-br-sm border-[0.5px] border-chat-hairline px-3.5 py-2">
        {icon === null ? null : <span className="flex h-5 shrink-0 items-center">{icon}</span>}
        <div className="flex min-w-0 flex-col">
          <p className="text-body leading-5 break-words text-chat-secondary-text">{text}</p>
          {duration === undefined ? null : (
            <p className="text-body-sm text-chat-muted-text tabular-nums">{duration}</p>
          )}
        </div>
      </div>
    </div>
  )
}

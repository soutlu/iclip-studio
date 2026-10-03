/** 回复的终态栏：复制、重新生成、分叉、时刻，用量收在时刻的提示里（悬停、聚焦或点一下弹出）。只有最新一轮常驻，历史轮悬停才露出（触屏上常驻），别让每条回复下面都挂一排小图标。 */

import { useRef, useState } from 'react'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { CopyButton } from './copy-button'

const exactTokens = (tokens: number): string => tokens.toLocaleString('zh-CN')

const pad2 = (value: number): string => String(value).padStart(2, '0')

const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** 参考 WorkBuddy formatMessageTime：今天显示时分、昨天加前缀、更早显示月日，跨年补年份。 */
const messageTime = (iso: string, now: Date): string => {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const time = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
  if (isSameDay(then, now)) return time
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(then, yesterday)) return `昨天 ${time}`
  const date = `${then.getMonth() + 1}月${then.getDate()}日`
  if (then.getFullYear() === now.getFullYear()) return `${date} ${time}`
  return `${then.getFullYear()}年${date} ${time}`
}

/** 悬停里的精确完整时刻：YYYY/MM/DD HH:mm:ss。调用前已确认 iso 能解析。 */
const fullTime = (iso: string): string => {
  const then = new Date(iso)
  return `${then.getFullYear()}/${pad2(then.getMonth() + 1)}/${pad2(then.getDate())} ${pad2(then.getHours())}:${pad2(then.getMinutes())}:${pad2(then.getSeconds())}`
}

/** 悬停里的精确用量，千分位；缺的项按 0 计。 */
const usageLine = (usage: TranscriptUsage): string =>
  `输入 ${exactTokens(usage.inputTokens ?? 0)} · 缓存 ${exactTokens(usage.cachedTokens ?? 0)} · 输出 ${exactTokens(usage.outputTokens ?? 0)}`

/** 时刻：悬停、聚焦弹出完整时刻与用量；触屏没有悬停，Radix 提示又不接触摸，所以受控开合、点一下开、再点收起，做法同成片信息按钮。 */
const TurnTime = ({ endedAt, usage }: { endedAt: string; usage: TranscriptUsage | undefined }) => {
  // 相对日期以组件挂载时刻为参照。
  const [now] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  // 按下那一刻提示开没开：Radix 在按下时就先把提示关了，点击要按按下前的状态翻转。键盘合成的点击没有按下，用当前状态。
  const openAtPressRef = useRef<boolean | null>(null)
  const label = messageTime(endedAt, now)
  if (label === '') return null
  return (
    <TooltipRoot onOpenChange={setOpen} open={open}>
      <TooltipTrigger
        asChild
        onPointerDown={() => {
          openAtPressRef.current = open
        }}
        // 拦下默认处理，Radix 才不会在点击时把提示关掉。
        onClick={(event) => {
          event.preventDefault()
          const wasOpen = openAtPressRef.current ?? open
          openAtPressRef.current = null
          setOpen(!wasOpen)
        }}
      >
        <button
          className="shrink-0 rounded-xs text-caption text-chat-muted-text tabular-nums ui-focus"
          type="button"
        >
          <time dateTime={endedAt}>{label}</time>
        </button>
      </TooltipTrigger>
      {/* 完整时刻一行，有用量再接一行精确用量。 */}
      <TooltipContent className="tabular-nums" side="top">
        <p>{fullTime(endedAt)}</p>
        {usage === undefined ? null : <p>{usageLine(usage)}</p>}
      </TooltipContent>
    </TooltipRoot>
  )
}

type TurnActionsProps = {
  /** 复制使用原始 Markdown。 */
  copyText: string
  /** 缺失或无效的结束时间不显示。 */
  endedAt?: string | undefined
  /** 只进时刻的悬停提示；缺少 usage 或时刻不显示时都不出用量。 */
  usage?: TranscriptUsage | undefined
  /** 未提供回调时隐藏按钮；调用方负责末轮与空闲状态判断。 */
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
  /** 未提供回调时隐藏按钮。每一轮都能分叉，不限末轮。 */
  onFork?: (() => void) | undefined
  forkDisabled?: boolean | undefined
  /** 最新一轮常驻；历史轮只在悬停或聚焦时露出，触屏上常驻。 */
  revealed?: boolean | undefined
  /** 摆放位置由所在轮决定。 */
  className?: string | undefined
}

export function TurnActions({
  className,
  copyText,
  endedAt,
  forkDisabled = false,
  onFork,
  onRegenerate,
  regenerateDisabled = false,
  revealed = false,
  usage,
}: TurnActionsProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 transition-opacity ui-motion-s',
        !revealed && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100',
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2">
        <CopyButton text={copyText} />
        {onRegenerate === undefined ? null : (
          <IconButton
            className="text-chat-muted-text"
            disabled={regenerateDisabled}
            label="重新生成"
            name="refresh"
            onClick={onRegenerate}
            size="xs"
            tooltip={regenerateDisabled ? '等这一条跑完再重新生成' : undefined}
            variant="standard"
          />
        )}
        {onFork === undefined ? null : (
          <IconButton
            className="text-chat-muted-text"
            disabled={forkDisabled}
            label="从这里另开一段对话"
            name="fork"
            onClick={onFork}
            size="xs"
            tooltip={forkDisabled ? '等这一条跑完再分叉' : undefined}
            variant="standard"
          />
        )}
      </div>
      {endedAt === undefined ? null : <TurnTime endedAt={endedAt} usage={usage} />}
    </div>
  )
}

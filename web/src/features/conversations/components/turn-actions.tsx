import { useRef, useState } from 'react'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { CopyButton } from './copy-button'
import { TOUCH_HIT_40 } from './touch-hit'

const exactTokens = (tokens: number): string => tokens.toLocaleString('zh-CN')

const pad2 = (value: number): string => String(value).padStart(2, '0')

const isSameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

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

const fullTime = (iso: string): string => {
  const then = new Date(iso)
  return `${then.getFullYear()}/${pad2(then.getMonth() + 1)}/${pad2(then.getDate())} ${pad2(then.getHours())}:${pad2(then.getMinutes())}:${pad2(then.getSeconds())}`
}

const usageLine = (usage: TranscriptUsage): string =>
  `输入 ${exactTokens(usage.inputTokens ?? 0)} · 缓存 ${exactTokens(usage.cachedTokens ?? 0)} · 输出 ${exactTokens(usage.outputTokens ?? 0)}`

const TurnTime = ({ endedAt, usage }: { endedAt: string; usage: TranscriptUsage | undefined }) => {
  const [now] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const openAtPressRef = useRef<boolean | null>(null)
  const label = messageTime(endedAt, now)
  if (label === '') return null
  return (
    <>
      <span aria-hidden className="mx-0.5 text-caption text-chat-muted-text">
        ·
      </span>
      <TooltipRoot onOpenChange={setOpen} open={open}>
        <TooltipTrigger
          asChild
          onPointerDown={() => {
            openAtPressRef.current = open
          }}
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
        <TooltipContent className="tabular-nums" side="top">
          <p>{fullTime(endedAt)}</p>
          {usage === undefined ? null : <p>{usageLine(usage)}</p>}
        </TooltipContent>
      </TooltipRoot>
    </>
  )
}

type TurnActionsProps = {
  copyText: string
  endedAt?: string | undefined
  usage?: TranscriptUsage | undefined
  onRegenerate?: (() => void) | undefined
  regenerateDisabled?: boolean | undefined
  onFork?: (() => void) | undefined
  forkDisabled?: boolean | undefined
  revealed?: boolean | undefined
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
        'flex items-center gap-2 transition-opacity ui-motion-s touch:min-h-10',
        !revealed && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100',
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2 touch:gap-4">
        <CopyButton className={TOUCH_HIT_40} text={copyText} />
        {onRegenerate === undefined ? null : (
          <IconButton
            className={cn('text-chat-muted-text', TOUCH_HIT_40)}
            disabled={regenerateDisabled}
            label="重新生成"
            name="refresh"
            onClick={onRegenerate}
            size="xs"
            tooltip={regenerateDisabled ? '该条消息尚未完成，无法重新生成' : undefined}
            variant="standard"
          />
        )}
        {onFork === undefined ? null : (
          <IconButton
            className={cn('text-chat-muted-text', TOUCH_HIT_40)}
            disabled={forkDisabled}
            label="从此处另开任务"
            name="fork"
            onClick={onFork}
            size="xs"
            tooltip={forkDisabled ? '该条消息尚未完成，无法另开任务' : undefined}
            variant="standard"
          />
        )}
      </div>
      {endedAt === undefined ? null : <TurnTime endedAt={endedAt} usage={usage} />}
    </div>
  )
}

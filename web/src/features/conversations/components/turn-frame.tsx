import { useEffect, useRef, useState } from 'react'
import type {
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
} from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { Markdown } from '@/shared/ui/markdown'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { TaskNoticeBubble } from './task-notice-bubble'
import { DetailText, Indented, RowIcon, ToolLine } from './tool-line'
import { UserBubble } from './user-bubble'

type TurnFrameProps = {
  frame: TranscriptFrame
  live: boolean
  interactions: ReadonlyMap<string, TranscriptInteraction>
  toolTasks: ReadonlyMap<string, TranscriptTask>
}

export function TurnFrame({ frame, interactions, live, toolTasks }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      if (frame.role === 'assistant') {
        return <Markdown className="leading-[1.75]" text={frame.text} />
      }
      return frame.taskId === undefined ? (
        <UserBubble content={frame.content} />
      ) : (
        <TaskNoticeBubble task={toolTasks.get(frame.taskId)} text={frame.text} />
      )
    case 'thinking':
      return <ThinkingBlock live={live} text={frame.text} />
    case 'tool':
      return (
        <ToolLine
          backgrounded={toolTasks.has(frame.toolCallId)}
          frame={frame}
          interactions={interactions}
        />
      )
    case 'notice':
      return frame.level === 'error' ? (
        <ErrorNotice message={frame.message} />
      ) : (
        <p className="text-body-sm text-chat-muted-text">{frame.message}</p>
      )
  }
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-chat-secondary-text">
      <Icon className="mt-0.5 shrink-0 text-chat-status-error" decorative name="failed" size="sm" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  )
}

type RunFailedNoticeProps = {
  error: string
  onRetry?: (() => void) | undefined
  retryDisabled?: boolean | undefined
}

export function RunFailedNotice({ error, onRetry, retryDisabled = false }: RunFailedNoticeProps) {
  const { copied, copy } = useCopyFeedback()
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 text-body">
      <Icon className="shrink-0 text-chat-status-error" decorative name="failed" size="sm" />
      <span className="text-chat-secondary-text">该轮未完成</span>
      {onRetry === undefined ? null : (
        <button
          className="inline-flex h-7 ui-state cursor-pointer items-center gap-1 rounded-full px-2.5 text-body-sm font-medium text-chat-message-text ui-focus"
          disabled={retryDisabled}
          onClick={onRetry}
          type="button"
        >
          <Icon decorative name="refresh" size="xs" />
          重试
        </button>
      )}
      <button
        className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-xs text-body-sm text-chat-muted-text decoration-1 underline-offset-3 ui-focus ui-motion-s hover:text-chat-secondary-text hover:underline"
        onClick={() => void copy(error)}
        type="button"
      >
        <Icon decorative name={copied ? 'check' : 'copy'} size="xs" />
        {copied ? '已复制' : '复制错误信息'}
      </button>
    </div>
  )
}

function useThinkingSeconds(live: boolean): number | null {
  const startedRef = useRef<number | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    if (!live) return
    startedRef.current ??= Date.now()
    const started = startedRef.current
    const id = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [live])

  return live ? (seconds ?? 0) : seconds
}

function ThinkingBlock({ live, text }: { live: boolean; text: string }) {
  const [open, setOpen] = useState(false)
  const seconds = useThinkingSeconds(live)

  return (
    <div className="flex flex-col">
      <button
        aria-expanded={open}
        className="group/row flex min-h-5 w-full cursor-pointer items-center gap-2 rounded-xs text-left text-body leading-5 text-chat-secondary-text ui-focus"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <RowIcon name="thinking" />
        <span className={cn(live && 'animate-pulse')}>{live ? '思考中…' : '思考过程'}</span>
        {seconds === null ? null : <span className="text-chat-muted-text">{seconds} 秒</span>}
        <DisclosureChevron
          className="text-chat-muted-text ui-motion-s group-hover/row:text-chat-message-text"
          open={open}
        />
      </button>
      <DisclosureBody open={open}>
        <Indented>
          <DetailText>{text}</DetailText>
        </Indented>
      </DisclosureBody>
    </div>
  )
}

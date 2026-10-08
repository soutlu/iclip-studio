/** 单块分派由普通轮次与活动组共用，避免两者循环依赖。 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptFrame, TranscriptInteraction } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'
import { Markdown } from '@/shared/ui/markdown'
import { DisclosureBody, DisclosureChevron } from './disclosure'
import { Indented, RowIcon, ToolLine } from './tool-line'
import { UserBubble } from './user-bubble'

type TurnFrameProps = {
  frame: TranscriptFrame
  /** 未结束轮次的最后一块，用于思考计时与动效。 */
  live: boolean
  interactions: ReadonlyMap<string, TranscriptInteraction>
}

export function TurnFrame({ frame, interactions, live }: TurnFrameProps) {
  switch (frame.kind) {
    case 'text':
      return frame.role === 'user' ? (
        <UserBubble content={frame.content} />
      ) : (
        // 助手正文不加气泡，行距比共用排版松一档，长段中文读着不挤。
        <Markdown className="leading-[1.75]" text={frame.text} />
      )
    case 'thinking':
      return <ThinkingBlock live={live} text={frame.text} />
    case 'tool':
      return <ToolLine frame={frame} interactions={interactions} />
    case 'notice':
      return frame.level === 'error' ? (
        <ErrorNotice message={frame.message} />
      ) : (
        <p className="text-body-sm text-chat-muted-text">{frame.message}</p>
      )
  }
}

/** 一行中性文字，只有图标是红的。 */
function ErrorNotice({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-chat-secondary-text">
      <Icon className="mt-0.5 shrink-0 text-chat-status-error" decorative name="failed" size="sm" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  )
}

type RunFailedNoticeProps = {
  /** 这一轮的运行记录原文，「复制错误信息」复制的就是它。 */
  error: string
  /** 末轮且空闲时才有；没有就不给「重试」。 */
  onRetry?: (() => void) | undefined
  retryDisabled?: boolean | undefined
}

/** 轮次没跑完：一行，红 × 加一句话，能重试就给重试，错误原文只给复制，不铺在对话里。 */
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

/** 仅对实时思考块计时，结束时冻结；历史块没有本地计时记录，返回 null。 */
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

/** 思考与工具行同一结构；展开是全文，不封顶。 */
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
          <p className="text-body-sm leading-5 whitespace-pre-wrap text-chat-secondary-text">
            {text}
          </p>
        </Indented>
      </DisclosureBody>
    </div>
  )
}

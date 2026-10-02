/** 审批与工具卡共用 display 合同；两个正式按钮，数字键 1 / 2 是快捷方式。 */

import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { Icon } from '@/shared/icons'
import { baseName, fileKindOf } from '@/shared/lib/file-kind'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { isBehindModal } from '@/shared/ui/dialog'
import { Markdown } from '@/shared/ui/markdown'
import { toast } from '@/shared/ui/toast'
import { respondInteraction } from '../conversations.api'
import { EditLines } from './edit-lines'
import { fileChangeOf, toolCard, type FileChange } from './tool-display'
import { useClampable } from './use-clampable'

type ApprovalCardProps = {
  conversationId: string
  interactionId: string
  /** 按 approvalId 匹配调用；未匹配时省略参数。 */
  frame: ToolCallFrame | undefined
  /** 决定与服务端状态冲突时刷新内容。 */
  onRefresh: () => void
  /** 看别人的对话：只展示在等什么，按钮与数字快捷键都不接。 */
  readOnly: boolean
}

const DECISION_LABELS = { approved: '已同意', rejected: '已拒绝' } as const

/** 数字键落在输入区里时不算快捷键：用户正在打字。 */
const inEditor = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"]') !== null

export function ApprovalCard({
  conversationId,
  frame,
  interactionId,
  onRefresh,
  readOnly,
}: ApprovalCardProps) {
  const card = toolCard(frame?.display, frame?.view)
  const change = fileChangeOf(frame?.display)
  const cardRef = useRef<HTMLElement | null>(null)
  const [decision, setDecision] = useState<keyof typeof DECISION_LABELS | null>(null)
  const [sending, setSending] = useState(false)
  // 卡片移除由服务端 pending 集合决定；interactionId 变化时由父组件 key 重置本地决定。
  const settled = decision !== null

  const respond = async (approved: boolean) => {
    setSending(true)
    try {
      await respondInteraction(conversationId, interactionId, approved)
      setDecision(approved ? 'approved' : 'rejected')
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('已经做过决定')
        onRefresh()
      } else if (error instanceof ApiError && error.status === 404) {
        toast.error('这张卡已经不在等了')
      } else {
        toast.error(errorMessageOf(error, '提交决定失败'))
      }
    } finally {
      setSending(false)
    }
  }

  const decide = (approved: boolean) => {
    if (readOnly || settled || sending) return
    void respond(approved)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '1' && event.key !== '2') return
      // 弹窗盖着这张卡时数字键是打给弹窗的，不能替看不见的审批做决定。
      if (event.defaultPrevented || inEditor(event.target) || isBehindModal(cardRef.current)) return
      decide(event.key === '1')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section
      aria-label="等你审批"
      className="mb-2 flex animate-in flex-col rounded-lg border-[0.5px] border-chat-hairline bg-chat-card-bg shadow-[var(--shadow-2)] duration-(--dur-m) ease-(--ease-decel) fade-in slide-in-from-bottom-2"
      ref={cardRef}
    >
      <header className="flex min-w-0 items-baseline gap-2 px-4 pt-3">
        <h2 className="shrink-0 text-body font-medium text-chat-message-text">{card.label}</h2>
        {/* 写入与编辑只给文件名；其余审批照旧显示主语原文。 */}
        {change !== undefined ? (
          <p className="min-w-0 truncate text-body-sm text-chat-muted-text">
            {baseName(change.path)}
          </p>
        ) : card.detail === undefined ? null : (
          <p className="min-w-0 truncate font-mono text-body-sm text-chat-muted-text">
            {card.detail}
          </p>
        )}
      </header>
      {/* display 提供操作说明与可预览的改动，内部参数不进入审批正文。 */}
      {change === undefined ? null : <ChangePreview change={change} />}
      <p className="px-4 pt-3 text-body text-chat-message-text">这一步要你点头才会继续</p>
      <footer className="mt-3 flex items-center justify-between gap-3 border-t-[0.5px] border-chat-hairline px-4 py-3">
        {settled ? (
          <p className="flex items-center gap-1 text-body-sm text-chat-muted-text">
            <Icon decorative name="check" size="sm" />
            {DECISION_LABELS[decision]}
          </p>
        ) : readOnly ? (
          <p className="text-caption text-chat-muted-text">等属主来决定</p>
        ) : (
          <>
            <p className="text-caption text-chat-muted-text">按 1 同意，按 2 拒绝</p>
            <div className="flex items-center gap-2">
              <Button
                disabled={sending}
                onClick={() => decide(false)}
                size="md"
                type="button"
                variant="tonal"
              >
                拒绝
              </Button>
              {/* 主操作用墨色：品牌绿只留给「生成」。 */}
              <Button
                disabled={sending}
                onClick={() => decide(true)}
                size="md"
                type="button"
                variant="inverted"
              >
                同意
              </Button>
            </div>
          </>
        )}
      </footer>
    </section>
  )
}

/** 收起时的可见行数；展开后的上限（二十四行）写在 .chat-preview-expanded。 */
const PREVIEW_LINES = 12

/**
 * 给用户看「要写进去的是什么」：Markdown 排成文档，其余按正文字体原样换行；
 * 编辑只给改动前后的片段，相同的首尾行当上下文，删掉的行灰色划线，新写的行墨色加浅灰底。
 * 超过十二行先收起，「展开全部」后在框内滚动。
 */
function ChangePreview({ change }: { change: FileChange }) {
  const [expanded, setExpanded] = useState(false)
  // fileChangeOf 每次渲染都给新对象，按文本重新测量。
  const text = 'content' in change ? change.content : `${change.before}\n${change.after}`
  const { clampable, ref } = useClampable(PREVIEW_LINES, text)
  const bodyId = useId()
  return (
    <>
      <div className="mx-4 mt-3 rounded-md bg-surface-container-low py-1.5">
        <div
          aria-label="改动预览"
          className={cn(
            'text-body leading-relaxed text-chat-message-text',
            clampable && (expanded ? 'chat-preview-expanded' : 'chat-preview-clamp'),
          )}
          id={bodyId}
          ref={ref}
          role="region"
        >
          {'content' in change ? (
            fileKindOf(change.path).kind === 'markdown' ? (
              <Markdown className="px-3" text={change.content} />
            ) : (
              <p className="px-3 break-words whitespace-pre-wrap">{change.content}</p>
            )
          ) : (
            <EditLines after={change.after} before={change.before} />
          )}
        </div>
      </div>
      {clampable ? (
        <button
          aria-controls={bodyId}
          aria-expanded={expanded}
          className="mx-4 mt-1.5 inline-flex items-center gap-0.5 self-start rounded-xs px-0.5 text-body-sm text-chat-muted-text underline-offset-3 ui-focus hover:text-chat-secondary-text hover:underline"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? '收起' : '展开全部'}
          <Icon decorative name={expanded ? 'collapse' : 'expand'} size="xs" />
        </button>
      ) : null}
    </>
  )
}

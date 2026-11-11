import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import type { ComposerHandle, ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { ComposerConnectorsButton, type McpConnectionsScope } from '@/shared/mcp-connections'
import { Composer } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import { ContextUsageIndicator } from './context-usage-indicator'

type ComposerEditing = {
  parts: readonly ComposerPart[]
}

type ConversationComposerProps = {
  onSend: (parts: ComposerSubmission['parts']) => Promise<void>
  busy?: boolean
  awaitingApproval?: boolean
  contextTokens: number | undefined
  maxContextTokens: number | undefined
  onStop?: (() => void) | undefined
  editing?: ComposerEditing | undefined
  onCancelEdit?: (() => void) | undefined
  placeholder?: string | undefined
  onSendError?: ((error: unknown) => void) | undefined
  /** 给了就在「+」旁放连接器按钮，列这段对话运行会连的、使用自有账户的服务。 */
  connections?: McpConnectionsScope | undefined
}

const submissionOf = (parts: readonly ComposerPart[]): ComposerSubmission => ({
  media: parts.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
  parts,
  text: parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join(''),
})

export function ConversationComposer({
  awaitingApproval = false,
  busy = false,
  contextTokens,
  editing,
  maxContextTokens,
  onCancelEdit,
  onSend,
  connections,
  onSendError,
  onStop,
  placeholder = '继续输入…',
}: ConversationComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const [sending, setSending] = useState(false)
  const { data: user } = useUser()

  useEffect(() => {
    const handle = composerRef.current
    if (handle === null) return
    if (editing === undefined) {
      handle.clear()
      return
    }
    handle.restore(submissionOf(editing.parts))
    handle.focus()
  }, [editing])

  const send = async (submission: ComposerSubmission) => {
    composerRef.current?.clear()
    setSending(true)
    try {
      await onSend(submission.parts)
    } catch (error) {
      composerRef.current?.restore(submission)
      if (onSendError === undefined) toast.error(errorMessageOf(error, '发送失败'))
      else onSendError(error)
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {editing === undefined ? null : (
        <div className="mb-2 flex items-center justify-between rounded-sm border-[0.5px] border-chat-hairline bg-top-layer px-3 py-1.5 text-body-sm text-chat-secondary-text">
          <span>正在修改上一条消息</span>
          <button
            className="cursor-pointer ui-focus ui-motion-s hover:text-chat-message-text"
            onClick={onCancelEdit}
            type="button"
          >
            取消
          </button>
        </div>
      )}
      <Composer
        attachmentsEnabled={hasPermission(user, PERMISSION.uploadsWrite)}
        busy={busy}
        dense
        leading={
          connections === undefined ? undefined : <ComposerConnectorsButton scope={connections} />
        }
        onStop={onStop}
        onSubmit={(submission) => void send(submission)}
        placeholder={awaitingApproval ? '请先确认上方的步骤' : placeholder}
        ref={composerRef}
        sending={sending}
        trailing={
          contextTokens !== undefined && maxContextTokens !== undefined && maxContextTokens > 0 ? (
            <ContextUsageIndicator max={maxContextTokens} used={contextTokens} />
          ) : undefined
        }
      />
    </>
  )
}

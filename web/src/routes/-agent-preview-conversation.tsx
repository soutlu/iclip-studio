import type { PreviewConversationProps } from '@/features/agent-config'
import { ConversationTimeline, RunTrace } from '@/features/conversations'

export function AgentPreviewConversation({
  agentId,
  beforeSend,
  draft,
  openPreview,
  placeholder,
  previewId,
  view,
}: PreviewConversationProps) {
  return (
    <ConversationTimeline
      beforeSend={beforeSend}
      connections={previewId === null ? { agentId, draft } : { conversationId: previewId }}
      conversationId={previewId}
      inlineSendError
      openConversation={openPreview}
      overlay={view === 'trace' ? <RunTrace conversationId={previewId} /> : undefined}
      placeholder={placeholder}
      workbench={false}
    />
  )
}

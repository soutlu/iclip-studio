import type { PreviewConversationProps } from '@/features/agent-config'
import { ConversationTimeline, RunTrace } from '@/features/conversations'

export function AgentPreviewConversation({
  openPreview,
  placeholder,
  previewId,
  view,
}: PreviewConversationProps) {
  return (
    <ConversationTimeline
      conversationId={previewId}
      inlineSendError
      openConversation={openPreview}
      overlay={view === 'trace' ? <RunTrace conversationId={previewId} /> : undefined}
      placeholder={placeholder}
      workbench={false}
    />
  )
}

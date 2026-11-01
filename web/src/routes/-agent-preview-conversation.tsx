import type { PreviewConversationProps } from '@/features/agent-config'
import { ConversationTimeline, RunTrace } from '@/features/conversations'

/**
 * Agent 配置页右栏的测试预览：对话模块的消息区与输入区原样拿来，预览 id 当对话 id。
 * 切到「运行过程」时消息区上盖运行过程，输入区照常可用；配置页没有工作台，在工作台打开东西的入口都不出现；
 * 草稿此刻装配不起来（`agent_unavailable`）是试草稿的正常结果，写在输入框上方，不弹 toast。
 */
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

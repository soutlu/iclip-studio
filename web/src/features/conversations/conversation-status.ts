/** 由 activity 推出的一格状态，侧栏行尾与全部对话页的状态列共用；两处的状态词都取自 @/shared/ui/status-badge。 */

import type { ConversationBadgeStatus } from '@/shared/ui/status-badge'
import type { Conversation } from './conversations.api'

export type ConversationStatus = ConversationBadgeStatus

/** 侧栏行尾要画出来的轮次状态。 */
export type AttentionStatus = Extract<
  ConversationStatus,
  'approval' | 'question' | 'running' | 'failed'
>

/** 优先级：待审批、待回答、运行、失败、完成、中止、从没跑过。 */
export const conversationStatus = (activity: Conversation['activity']): ConversationStatus => {
  if (activity.pendingInteraction === 'approval') return 'approval'
  if (activity.pendingInteraction === 'question') return 'question'
  if (activity.busy) return 'running'
  if (activity.lastTurnReason === 'failed') return 'failed'
  if (activity.lastTurnReason === 'completed') return 'completed'
  if (activity.lastTurnReason === 'aborted') return 'aborted'
  return 'idle'
}

/** 侧栏行尾只画还需要人看一眼的四种；完成与中止不画，未读另有小点。 */
export const needsAttention = (status: ConversationStatus): status is AttentionStatus =>
  status === 'approval' || status === 'question' || status === 'running' || status === 'failed'

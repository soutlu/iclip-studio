import type { ConversationBadgeStatus } from '@/shared/ui/status-badge'
import type { Conversation } from './conversations.api'

export type ConversationStatus = ConversationBadgeStatus

export type AttentionStatus = Extract<
  ConversationStatus,
  'approval' | 'question' | 'running' | 'failed'
>

export const conversationStatus = (activity: Conversation['activity']): ConversationStatus => {
  if (activity.pendingInteraction === 'approval') return 'approval'
  if (activity.pendingInteraction === 'question') return 'question'
  if (activity.busy) return 'running'
  if (activity.lastTurnReason === 'failed') return 'failed'
  if (activity.lastTurnReason === 'completed') return 'completed'
  if (activity.lastTurnReason === 'aborted') return 'aborted'
  return 'idle'
}

export const needsAttention = (status: ConversationStatus): status is AttentionStatus =>
  status === 'approval' || status === 'question' || status === 'running' || status === 'failed'

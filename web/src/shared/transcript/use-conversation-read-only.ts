import { useUser } from '@/shared/auth'
import type { TranscriptView } from './view'

export const useConversationReadOnly = (view: TranscriptView): boolean => {
  const { data: user } = useUser()
  if (view.status !== 'ready' || user == null) return false
  return view.ownerUserId !== user.id || view.deletedAt !== null
}

import { useNavigate } from '@tanstack/react-router'
import { useConversationAgents, useStartConversation } from '@/features/conversations'
import type { TaskCreationStarter } from '@/features/tasks'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'

export function useStartTaskCreation(): TaskCreationStarter {
  const navigate = useNavigate()
  const { data: user } = useUser()
  const agents = useConversationAgents(hasPermission(user, PERMISSION.agentRun))
  const start = useStartConversation(user?.id ?? null, (conversationId) => {
    void navigate({ params: { conversationId }, to: '/c/$conversationId' })
  })

  return {
    agents: {
      items: agents.data?.items,
      pending: agents.isPending,
      error: agents.error,
      retry: () => void agents.refetch(),
    },
    start: async (draft, agentId) => {
      await start.mutateAsync({
        agentId,
        content: draft.content,
        taskId: draft.taskId,
        title: draft.title,
      })
    },
  }
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { TasksRoute } from '@/features/tasks'
import { ensureSessionUser } from '@/shared/auth'
import { useStartTaskCreation } from '../-use-start-task-creation'
import { TaskRelatedConversations } from '../-task-related-conversations'

export const Route = createFileRoute('/_shell/tasks')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: TasksIndexRoute,
})

function TasksIndexRoute() {
  const creation = useStartTaskCreation()
  return (
    <TasksRoute
      creation={creation}
      relatedContent={(taskId) => <TaskRelatedConversations taskId={taskId} />}
    />
  )
}

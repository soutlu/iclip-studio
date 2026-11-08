import { useQueries } from '@tanstack/react-query'
import { listTasksByIds, taskPreviewOf, tasksQueryKeys, type Task } from '@/features/tasks'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

export function useAuditTaskPreviews(taskIdGroups: readonly (readonly string[])[]): {
  taskPreviews: ReadonlyMap<string, TaskPreview>
  taskPreviewState: TaskPreviewState
  taskPreviewRetry: () => void
} {
  const { data: user } = useUser()
  const canReadTasks = hasPermission(user, PERMISSION.tasksRead)
  const groups = taskIdGroups.map((ids) => [...new Set(ids)].sort()).filter((ids) => ids.length > 0)
  const batches = useQueries({
    queries: groups.map((ids) => ({
      enabled: canReadTasks,
      queryFn: ({ signal }: { signal: AbortSignal }) => listTasksByIds(ids, signal),
      queryKey: tasksQueryKeys.byIds(ids),
    })),
  })

  const tasks = new Map<string, Task>()
  for (const batch of batches) {
    for (const task of batch.data ?? []) tasks.set(task.id, task)
  }

  let taskPreviewState: TaskPreviewState = 'ready'
  if (!canReadTasks) taskPreviewState = 'forbidden'
  else if (batches.some((batch) => batch.isError)) taskPreviewState = 'error'
  else if (batches.some((batch) => batch.isPending)) taskPreviewState = 'loading'

  return {
    taskPreviews: canReadTasks
      ? new Map([...tasks].map(([id, task]) => [id, taskPreviewOf(task)]))
      : new Map(),
    taskPreviewState,
    taskPreviewRetry: () => {
      for (const batch of batches) {
        if (batch.isError) void batch.refetch()
      }
    },
  }
}

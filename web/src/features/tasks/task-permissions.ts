import { hasPermission, PERMISSION } from '@/shared/auth'
import type { Task } from './tasks.api'

type TaskActor = { id: string; permissions: readonly string[] } | null | undefined

export type TaskField =
  | 'title'
  | 'deadline'
  | 'platform'
  | 'video_type'
  | 'content_type'
  | 'resolution'
  | 'aspect_ratio'
  | 'duration_seconds'
  | 'products'
  | 'style_no'
  | 'product'
  | 'references'
  | 'creative_requirement'

const PLANNER_EDITABLE: ReadonlySet<TaskField> = new Set([
  'title',
  'deadline',
  'creative_requirement',
  'duration_seconds',
  'aspect_ratio',
  'resolution',
  'references',
])

export const canManageDraft = (user: TaskActor, task: Task): boolean =>
  hasPermission(user, PERMISSION.tasksWrite) &&
  (user?.id === task.creatorUserId || hasPermission(user, PERMISSION.usersManage))

export const canEditTaskField = (user: TaskActor, task: Task, field: TaskField): boolean => {
  if (!hasPermission(user, PERMISSION.tasksWrite)) return false
  if (field === 'style_no' || field === 'products') return false
  switch (task.status) {
    case 'draft':
      return canManageDraft(user, task)
    case 'published':
    case 'confirmed':
      return PLANNER_EDITABLE.has(field)
    case 'withdrawn':
      return false
  }
}

export const creationBlockReason = (user: TaskActor, task: Task | undefined): string | null => {
  if (!user || !hasPermission(user, PERMISSION.agentRun))
    return '当前账号没有创作权限，无法开始创作'
  if (!task) return '需求单读取失败，请返回后重试'
  switch (task.status) {
    case 'withdrawn':
      return '需求单已撤回，无法开始创作'
    case 'draft':
    case 'published':
      return '需求单尚未认领，无法开始创作'
    case 'confirmed':
      return task.assigneeUserIds.includes(user.id)
        ? null
        : '当前账号尚未认领该需求单，无法开始创作'
  }
}

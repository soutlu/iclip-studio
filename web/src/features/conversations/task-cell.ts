import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

const PREVIEW_TEXT: Record<TaskPreviewState, string> = {
  loading: '正在读取需求单…',
  error: '需求单信息暂不可用',
  forbidden: '当前账号没有查看需求单权限',
  ready: '需求单暂不可用',
}

export const taskCellOf = (
  taskId: string | null,
  preview: TaskPreview | undefined,
  label: string | undefined,
  state: TaskPreviewState,
): string => {
  if (taskId === null) return '未关联'
  if (preview === undefined) return label ?? PREVIEW_TEXT[state]
  return preview.title
}

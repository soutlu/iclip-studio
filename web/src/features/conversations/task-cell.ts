/** 全部对话页一行里「关联需求单」一格的文字：按有没有关联、预览拿没拿到、读取状态给说法。 */

import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

const PREVIEW_TEXT: Record<TaskPreviewState, string> = {
  loading: '正在读取需求单…',
  error: '需求单信息暂不可用',
  forbidden: '无需求单查看权限',
  ready: '需求单暂不可用',
}

/** ``label`` 是选择器候选里的标题，预览没到时顶一下名字。 */
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

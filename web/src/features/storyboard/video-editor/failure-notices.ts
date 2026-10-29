import { useState } from 'react'
import { z } from 'zod'
import { toast } from '@/shared/ui/toast'
import { readStored, useStorageFailureNotice } from '../editing/browser-storage'
import { finishedAt } from '../editing/version-lineage'
import type { GenerationJob } from '../storyboard.api'
import { failureMessageOf, spanName, type AlignedEdit } from './edit-blocks'

const STORAGE_FAILURE = '当前浏览器无法保存已关闭的失败提醒，重新打开编辑器后提醒会再次出现'

/** 工具条上常驻的一条失败提醒：某几个镜头生成失败（带它的镜头与原片起止），或合成失败。 */
export type FailureNotice = {
  id: string
  text: string
  /** 失败的时刻（毫秒），排序用。 */
  at: number
  edit: AlignedEdit | undefined
}

/** 还算数的失败，最近的在前：编辑段与合成混在一起排，点 ✕ 关掉的不算。 */
export const failureNoticesOf = (
  edits: readonly AlignedEdit[],
  composite: GenerationJob | undefined,
  dismissed: ReadonlySet<string>,
): FailureNotice[] =>
  [
    ...edits.map((edit) => ({
      id: edit.job.id,
      text: `${spanName(edit)} 生成失败：${failureMessageOf(edit.job)}`,
      at: finishedAt(edit.job),
      edit,
    })),
    ...(composite === undefined
      ? []
      : [
          {
            id: composite.id,
            text: `合成失败：${composite.errorMessage?.trim() || '未返回合成结果'}`,
            at: finishedAt(composite),
            edit: undefined,
          },
        ]),
  ]
    .filter((notice) => !dismissed.has(notice.id))
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id))

const dismissedStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-dismissed-failures:${conversationId}:${rootJobId}`

const zDismissed = z.array(z.string().min(1))

const readDismissed = (key: string): ReadonlySet<string> => {
  const raw = readStored(key)
  if (raw === null) return new Set()
  try {
    const parsed = zDismissed.safeParse(JSON.parse(raw))
    return new Set(parsed.success ? parsed.data : [])
  } catch {
    return new Set()
  }
}

/** 这条原片上点 ✕ 关掉的失败提醒，按任务 id 记进浏览器；存不进去时提示一次，照常关掉。 */
export function useDismissedFailures(conversationId: string, rootJobId: string) {
  const key = dismissedStorageKey(conversationId, rootJobId)
  const [dismissed, setDismissed] = useState(() => readDismissed(key))
  const noticeFailure = useStorageFailureNotice(STORAGE_FAILURE, (message) => toast.error(message))
  return {
    dismissed,
    dismiss: (id: string) => {
      const next = new Set(dismissed).add(id)
      setDismissed(next)
      try {
        window.localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        noticeFailure()
      }
    },
  }
}

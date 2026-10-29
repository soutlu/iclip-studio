import { useState } from 'react'
import { toast } from '@/shared/ui/toast'
import { readStoredJson, useStorageFailureNotice, writeStored } from '../editing/browser-storage'
import {
  EMPTY_DRAFT,
  isUsableDraft,
  restoreDraft,
  zDraft,
  type Draft,
  type DraftSource,
  type Segment,
} from './draft'

const STORAGE_FAILURE = '当前浏览器无法保存草稿，关闭编辑器后草稿将丢失'

export const draftStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-tracks:${conversationId}:${rootJobId}`

type Args = {
  conversationId: string
  rootJobId: string
  source: DraftSource | undefined
  /** 最近一次完成的合成的片段：存着的草稿用不了时从它还原。 */
  latest: readonly Segment[] | undefined
  /** 编辑记录、原片关键帧与所有编辑段的关键帧都读好了；之前不定草稿。 */
  ready: boolean
}

/**
 * 这条原片的草稿。打开时定一次：存着的每一处都对得上就用它，否则从最近一次合成还原，再不行就是默认草稿；
 * 之后只随用户的改动变，每次改动后整份存进浏览器。存不进去时提示一次，改动照常生效。
 */
export function useDraft({ conversationId, rootJobId, source, latest, ready }: Args) {
  const key = draftStorageKey(conversationId, rootJobId)
  const [draft, setDraft] = useState<Draft>()
  const noticeFailure = useStorageFailureNotice(STORAGE_FAILURE, (message) => toast.error(message))
  if (draft === undefined && ready && source !== undefined) {
    const stored = readStoredJson(key, zDraft)
    setDraft(
      stored !== undefined && isUsableDraft(source, stored)
        ? stored
        : ((latest === undefined ? undefined : restoreDraft(source, latest)) ?? EMPTY_DRAFT),
    )
  }
  return {
    draft: draft ?? EMPTY_DRAFT,
    change: (next: Draft) => {
      setDraft(next)
      if (!writeStored(key, next)) noticeFailure()
    },
  }
}

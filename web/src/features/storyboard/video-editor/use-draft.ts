import { useState } from 'react'
import { toast } from '@/shared/ui/toast'
import { readStoredJson, useStorageFailureNotice, writeStored } from '../editing/browser-storage'
import {
  defaultDraft,
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
  latest: readonly Segment[] | undefined
  ready: boolean
}

export function useDraft({ conversationId, rootJobId, source, latest, ready }: Args) {
  const key = draftStorageKey(conversationId, rootJobId)
  const [draft, setDraft] = useState<Draft>()
  const noticeFailure = useStorageFailureNotice(STORAGE_FAILURE, (message) => toast.error(message))
  if (draft === undefined && ready && source !== undefined) {
    const stored = readStoredJson(key, zDraft)
    setDraft(
      stored !== undefined && isUsableDraft(source, stored)
        ? stored
        : ((latest === undefined ? undefined : restoreDraft(source, latest)) ??
            defaultDraft(source)),
    )
  }
  return {
    draft,
    change: (next: Draft) => {
      if (draft === undefined) return
      setDraft(next)
      if (!writeStored(key, next)) noticeFailure()
    },
  }
}

import { useState } from 'react'
import { z } from 'zod'
import { toast } from '@/shared/ui/toast'
import { readStored, useStorageFailureNotice } from '../editing/browser-storage'
import { arePicksUsable, pickEdit } from './composition'
import type { EditBlock } from './edit-blocks'

const STORAGE_FAILURE = '当前浏览器无法保存选用的编辑片段，关闭编辑器后选用将丢失'
const NO_PICKS: readonly string[] = []

export const picksStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-picks:${conversationId}:${rootJobId}`

const zPicks = z.array(z.string().min(1))

const readPicks = (key: string): string[] | undefined => {
  const raw = readStored(key)
  if (raw === null) return undefined
  try {
    const parsed = zPicks.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

type Args = {
  conversationId: string
  rootJobId: string
  blocks: readonly EditBlock[]
  /** 存着的选用用不了时的选用：从最近一次合成推出来的。 */
  fallback: readonly string[]
  /** 编辑记录、镜头与编辑片段的时长都读好了；之前不定选用。 */
  ready: boolean
}

/**
 * 这条原片上选用了哪几条编辑片段。打开时定一次：存着的每条都在轨上、可用且互不重叠就用它，否则用 `fallback`；
 * 之后只随用户的选用、取消改变，并存进浏览器。存不进去时提示一次，选用照常生效。
 */
export function usePicks({ conversationId, rootJobId, blocks, fallback, ready }: Args) {
  const key = picksStorageKey(conversationId, rootJobId)
  const [picks, setPicks] = useState<readonly string[]>()
  const noticeFailure = useStorageFailureNotice(STORAGE_FAILURE, (message) => toast.error(message))
  if (picks === undefined && ready) {
    const stored = readPicks(key)
    setPicks(stored !== undefined && arePicksUsable(stored, blocks) ? stored : fallback)
  }
  const current = picks ?? NO_PICKS
  const change = (next: readonly string[]) => {
    setPicks(next)
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      noticeFailure()
    }
  }
  return {
    picks: current,
    pick: (id: string) => change(pickEdit(current, blocks, id)),
    unpick: (id: string) => change(current.filter((other) => other !== id)),
  }
}

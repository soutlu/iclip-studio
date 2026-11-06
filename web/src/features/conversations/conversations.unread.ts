import { useParams } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'
import type { Conversation, SidebarTopology } from './conversations.api'
import { useConversationRow } from './conversation-rows'

const STORAGE_KEY = 'cue.conversations.seen-run'

type SeenRuns = Readonly<Record<string, string | null>>

const read = (): SeenRuns => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, one]) => one === null || typeof one === 'string'),
    )
  } catch {
    return {}
  }
}

let seen: SeenRuns = read()
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return
  seen = read()
  notify()
})

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export const recordSeenRun = (conversationId: string, lastRunId: string | null): void => {
  if (conversationId in seen && seen[conversationId] === lastRunId) return
  seen = { ...seen, [conversationId]: lastRunId }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seen))
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }
  notify()
}

export const useSeenRun = (conversationId: string): string | null | undefined =>
  useSyncExternalStore(subscribe, () => seen[conversationId])

const findRow = (topology: SidebarTopology, conversationId: string): Conversation | undefined =>
  [topology.ungrouped, ...topology.collections.map((one) => one.page)]
    .flatMap((page) => page.items)
    .find((row) => row.id === conversationId)

export const useRecordOpenedConversation = (topology: SidebarTopology | undefined): void => {
  const openedId = useParams({ select: (params) => params.conversationId, strict: false })
  const opened =
    useConversationRow(
      openedId === undefined || topology === undefined ? undefined : findRow(topology, openedId),
    ) ?? undefined
  const seenRun = opened === undefined ? undefined : opened.activity.busy ? null : opened.lastRunId
  useEffect(() => {
    if (openedId !== undefined && seenRun !== undefined) recordSeenRun(openedId, seenRun)
  }, [openedId, seenRun])
}

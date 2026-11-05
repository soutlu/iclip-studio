import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'cue.video-enhancements.seen'

const LIMIT = 300

type SeenIds = readonly string[]

const read = (): SeenIds => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = stored === null ? null : JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((one): one is string => typeof one === 'string').slice(-LIMIT)
  } catch {
    return []
  }
}

let ids: SeenIds = read()
let snapshot: ReadonlySet<string> = new Set(ids)
const listeners = new Set<() => void>()

const replace = (next: SeenIds) => {
  ids = next
  snapshot = new Set(next)
  for (const listener of listeners) listener()
}

window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return
  replace(read())
})

const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export const markEnhancementsSeen = (jobIds: readonly string[]): void => {
  const fresh = jobIds.filter((id, index) => !snapshot.has(id) && jobIds.indexOf(id) === index)
  if (fresh.length === 0) return
  const next = [...ids, ...fresh].slice(-LIMIT)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }
  replace(next)
}

export const useSeenEnhancements = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => snapshot)

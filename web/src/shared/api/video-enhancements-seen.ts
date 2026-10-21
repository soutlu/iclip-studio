/** 本机看过结果的超分记录：下载按钮上的点按它判断出不出。记在这台电脑的浏览器里，各处按钮共用一份，
 * 同一浏览器的其他标签页跟着同步；站点存储不可用时只记在这次打开的页面里。 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'cue.video-enhancements.seen'

/** 只留最近看过的这么多条；更早的记录早已不是各档最近的那条，丢了也不会再出点。 */
const LIMIT = 300

/** 按看过的先后，最新的在后。 */
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
// 快照必须稳定：只在写入或别的标签页改了时换新的一份。
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

/** 把这些超分记录记成看过；都看过了就什么也不做。 */
export const markEnhancementsSeen = (jobIds: readonly string[]): void => {
  const fresh = jobIds.filter((id, index) => !snapshot.has(id) && jobIds.indexOf(id) === index)
  if (fresh.length === 0) return
  const next = [...ids, ...fresh].slice(-LIMIT)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存储不可用时只记在这个页面里。
  }
  replace(next)
}

/** 看过的超分记录 id；任何一处记了看过，用它的组件都跟着重画。 */
export const useSeenEnhancements = (): ReadonlySet<string> =>
  useSyncExternalStore(subscribe, () => snapshot)

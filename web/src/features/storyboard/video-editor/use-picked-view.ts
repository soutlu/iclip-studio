/** 编辑器看哪一版、看它的草稿还是它本身：按（对话，根）记在浏览器里，刷新或重开后接着看那一版。 */

import { useEffect, useEffectEvent, useState } from 'react'
import { z } from 'zod'

/** 看哪一版、看它的草稿还是它本身。只有草稿有改动时两者才不同。 */
export type Picked = { jobId: string; view: 'draft' | 'version' }

export const viewStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-view:${conversationId}:${rootJobId}`

const zPicked = z.object({ jobId: z.string().min(1), view: z.enum(['draft', 'version']) })

/** 读不出、解析不了都当没记过：这只是浏览偏好，调用方按默认看最新版。 */
const readPicked = (key: string): Picked | undefined => {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return undefined
    const parsed = zPicked.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 挂载时读出上次看的那一版作初值，之后每次改都写回去；没选过时是 `undefined`。
 * 浏览器拒绝写入时调 `onStorageFailure`，由调用方决定怎么说。 */
export const usePickedView = (
  conversationId: string,
  rootJobId: string,
  onStorageFailure: () => void,
) => {
  const key = viewStorageKey(conversationId, rootJobId)
  const [picked, setPicked] = useState(() => readPicked(key))
  const reportStorageFailure = useEffectEvent(onStorageFailure)
  useEffect(() => {
    if (picked === undefined) return
    try {
      window.localStorage.setItem(key, JSON.stringify(picked))
    } catch {
      reportStorageFailure()
    }
  }, [key, picked])
  return [picked, setPicked] as const
}

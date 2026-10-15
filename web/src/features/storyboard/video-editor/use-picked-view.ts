/** 整片浏览与当前编辑基底分别保存，查看历史不改变各片段的选用。 */

import { useEffect, useEffectEvent, useState } from 'react'
import { z } from 'zod'

/** 当前查看的整片、编辑基底，以及整片或片段视图。 */
export type Picked = { jobId: string; baseJobId: string; view: 'whole' | 'clips' }

export const viewStorageKey = (conversationId: string, rootJobId: string) =>
  `video-editor-view:${conversationId}:${rootJobId}`

const zPicked = z.object({
  jobId: z.string().min(1),
  baseJobId: z.string().min(1),
  view: z.enum(['whole', 'clips']),
})

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

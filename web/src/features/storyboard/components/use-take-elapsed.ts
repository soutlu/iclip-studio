/** 在途成片的已用时长，每秒走一格；两端时钟有偏差时不出负数。成片卡与舞台共用。 */

import { useEffect, useState } from 'react'
import { formatDuration } from '@/shared/ui/media-preview'

/** `since` 是提交时刻（ISO），返回形如 `0:38` 的时长。 */
export const useTakeElapsed = (since: string): string => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return formatDuration(Math.max(0, (now - Date.parse(since)) / 1000))
}

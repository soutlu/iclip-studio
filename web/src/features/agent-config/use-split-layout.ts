import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { DEFAULT_SPLIT, type SplitLayout } from './split-layout'

const STORAGE_KEY = 'cue.layout.agent-config'
const share = z.number().gt(0).lt(1)
const layoutSchema = z.object({ normal: share, wide: share })

const read = (): SplitLayout => {
  const fallback = { ...DEFAULT_SPLIT }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === null) return fallback
    const parsed = layoutSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

const write = (layout: SplitLayout): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }
}

/** Agent 配置页两栏占比，跨刷新保留；拖动过程中传 persist=false，松手后再调 persist 写入。 */
export function useSplitLayout() {
  const [layout, setLayout] = useState(read)
  const latestRef = useRef(layout)
  const update = useCallback((updater: (current: SplitLayout) => SplitLayout, persist = true) => {
    const next = updater(latestRef.current)
    latestRef.current = next
    setLayout(next)
    if (persist) write(next)
  }, [])
  const persist = useCallback(() => write(latestRef.current), [])
  return { layout, update, persist }
}

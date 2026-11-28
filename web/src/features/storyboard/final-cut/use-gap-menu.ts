import { useState, type MouseEvent } from 'react'
import { gapClosing, type GapClosing } from './clip-edit'
import type { FilmClip } from './composition/film'
import type { RowKey } from './placement'

/**
 * 行的空档右键菜单开不开、开了合拢哪些片段：`openGapMenu` 挂在各行的右键上，点在空档里、这一行有可合拢的空档时
 * 记下两种合拢各自要挪的片段（`closing`），不然不开菜单。`timeAt` 把屏幕横坐标换成 final-cut 的时间。
 */
export function useGapMenu({
  clips,
  gesturing,
  timeAt,
}: {
  clips: readonly FilmClip[]
  /** 正在拖动或框选：不开菜单。 */
  gesturing: boolean
  timeAt: (clientX: number) => number
}) {
  // 在一行的空处点右键时，两种合拢各自要挪哪些片段
  const [closing, setClosing] = useState<GapClosing>()

  // 点在片段上（那里出片段的菜单）、点在弹出的菜单上（沿组件树传上来）、正在拖动或框选，
  // 或者这一行没有可合拢的空档：不开菜单
  const openGapMenu = (event: MouseEvent<HTMLElement>, row: RowKey) => {
    const { target } = event
    const inGap =
      !gesturing &&
      target instanceof Element &&
      event.currentTarget.contains(target) &&
      target.closest('[data-clip-id]') === null
    const next = inGap ? gapClosing(clips, row, timeAt(event.clientX)) : undefined
    if (next === undefined || (next.one.size === 0 && next.all.size === 0)) {
      event.preventDefault()
      return
    }
    setClosing(next)
  }

  return { closing, openGapMenu }
}

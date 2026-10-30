import { useEffect, useEffectEvent, type RefObject } from 'react'

/** 拖动中指针离时间线可视范围左右边缘这么近就自动横向滚动，每秒滚这么多像素。 */
const SCROLL_EDGE_PX = 40
const SCROLL_SPEED = 420

type EdgePointer = { clientX: number; clientY: number }

type Options = {
  /** 时间线的横向滚动区。 */
  viewportRef: RefObject<HTMLElement | null>
  /** 正在拖：为 true 期间每帧看一次指针。 */
  active: boolean
  /** 指针此刻在哪；为 null 时不滚（如还没超过拖动阈值）。 */
  pointer: () => EdgePointer | null
  /**
   * 指针在这里算不算在能滚的范围里（`box` 是滚动区的可视范围）。不给时只看横向：指针在靠边那一截里或已经出了
   * 边都滚，用于指针被捕获、可能拖出时间线的修剪把手。
   */
  reach?: (pointer: EdgePointer, box: DOMRect) => boolean
  /** 滚动区滚了（指针没动、它下面的时刻变了）：调用方按指针重算落点。不给时调用方自己听滚动区的 scroll。 */
  onScroll?: () => void
}

/**
 * 拖动中指针靠近时间线可视范围左右边缘时自动横向滚动，两个编辑器的修剪把手与成片的拖放、排序共用。
 * 每帧按经过的时间滚，一帧最多按 32ms 算（切回标签页等长停顿后不猛跳）；滚到内容两端停住。滚动是跟着指针的
 * 导航、不是装饰动画，系统要求减少动态效果时照样滚。
 */
export function useEdgeScroll({ viewportRef, active, pointer, reach, onScroll }: Options) {
  const tick = useEffectEvent((elapsed: number) => {
    const at = pointer()
    const viewport = viewportRef.current
    if (at === null || viewport === null) return
    const box = viewport.getBoundingClientRect()
    if (reach !== undefined && !reach(at, box)) return
    const direction =
      at.clientX < box.left + SCROLL_EDGE_PX ? -1 : at.clientX > box.right - SCROLL_EDGE_PX ? 1 : 0
    if (direction === 0) return
    const before = viewport.scrollLeft
    const end = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    const next = Math.max(0, Math.min(end, before + (direction * SCROLL_SPEED * elapsed) / 1000))
    if (next === before) return
    viewport.scrollLeft = next
    onScroll?.()
  })

  useEffect(() => {
    if (!active) return
    let frame = 0
    let last: number | undefined
    const step = (now: number) => {
      const elapsed = last === undefined ? 16 : Math.min(32, now - last)
      last = now
      tick(elapsed)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [active])
}

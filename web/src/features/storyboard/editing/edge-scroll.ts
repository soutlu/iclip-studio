import { useEffect, useEffectEvent, type RefObject } from 'react'

const SCROLL_EDGE_PX = 40
const SCROLL_SPEED = 420

type EdgePointer = { clientX: number; clientY: number }

type Options = {
  viewportRef: RefObject<HTMLElement | null>
  active: boolean
  pointer: () => EdgePointer | null
  reach?: (pointer: EdgePointer, box: DOMRect) => boolean
  onScroll?: () => void
}

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

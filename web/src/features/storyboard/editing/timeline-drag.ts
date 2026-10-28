import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export type Edge = 'start' | 'end'

export const DRAG_THRESHOLD = 4

const KEY_STEP = 0.1

export const arrowStep = (event: KeyboardEvent): number | undefined => {
  const step = event.shiftKey ? 1 : KEY_STEP
  return event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : undefined
}

export const releasePointer = (event: PointerEvent<HTMLElement>) => {
  if (event.currentTarget.hasPointerCapture(event.pointerId))
    event.currentTarget.releasePointerCapture(event.pointerId)
}

// 拖完松手时浏览器还会补一个 click，那一下不算点选；被拖走的元素收不到这个 click，记号留到下一次按下作废。
export const useClickAfterDrag = () => {
  const swallowRef = useRef(false)
  return {
    reset: () => {
      swallowRef.current = false
    },
    swallow: () => {
      swallowRef.current = true
    },
    take: () => {
      if (!swallowRef.current) return false
      swallowRef.current = false
      return true
    },
  }
}

export const useRovingFocus = (ids: readonly string[], preferred: string | undefined) => {
  const [focusId, setFocusId] = useState<string>()
  const elementsRef = useRef(new Map<string, HTMLElement>())
  const tabStop =
    (focusId !== undefined && ids.includes(focusId) ? focusId : undefined) ?? preferred ?? ids[0]
  return {
    remember: (id: string) => setFocusId(id),
    focus: (id: string) => {
      setFocusId(id)
      elementsRef.current.get(id)?.focus()
    },
    tabIndexOf: (id: string) => (id === tabStop ? 0 : -1),
    register: (id: string) => (element: HTMLElement | null) => {
      if (element === null) elementsRef.current.delete(id)
      else elementsRef.current.set(id, element)
    },
  }
}

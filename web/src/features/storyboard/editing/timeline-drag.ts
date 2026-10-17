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

export type Lift<T> = {
  pointerId: number
  payload: T
  originX: number
  grab: number
  clock: number
  moved: boolean
}

export const useLiftDrag = <T>({
  clockAt,
  onScrub,
}: {
  clockAt: (clientX: number) => number
  onScrub: () => void
}) => {
  const [lift, setLift] = useState<Lift<T> | null>(null)
  return {
    lift,
    press: (event: PointerEvent<HTMLElement>, payload: T, start: number) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      const clock = clockAt(event.clientX)
      setLift({
        pointerId: event.pointerId,
        payload,
        originX: event.clientX,
        grab: clock - start,
        clock,
        moved: false,
      })
    },
    move: (event: PointerEvent<HTMLElement>) => {
      if (lift === null || lift.pointerId !== event.pointerId) return
      const moved = lift.moved || Math.abs(event.clientX - lift.originX) > DRAG_THRESHOLD
      if (moved && !lift.moved) onScrub()
      setLift({ ...lift, clock: clockAt(event.clientX), moved })
    },
    release: (event: PointerEvent<HTMLElement>): Lift<T> | undefined => {
      if (lift === null || lift.pointerId !== event.pointerId) return undefined
      releasePointer(event)
      setLift(null)
      return lift.moved ? lift : undefined
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

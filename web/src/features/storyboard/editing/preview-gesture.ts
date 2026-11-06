import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'
import { useEdgeScroll } from './edge-scroll'
import { DRAG_THRESHOLD, type Edge, type useClickAfterDrag } from './timeline-drag'

export type TrimTarget = { slide: string; edge: Edge }

export type Span = { at: number; len: number }

export const trimSpans = (
  edge: Edge,
  { at, len }: Span,
  next: number,
): { block: Span; kept: Span; cut: Span | undefined } => {
  const keptAt = edge === 'start' ? at + len - next : at
  const blockAt = Math.min(at, keptAt)
  const blockLen = Math.max(at + len, keptAt + next) - blockAt
  const shift = Math.max(0, -blockAt)
  const kept = { at: keptAt + shift, len: next }
  const block = { at: blockAt + shift, len: blockLen }
  if (next >= len) return { block, kept, cut: undefined }
  return {
    block,
    kept,
    cut: { at: edge === 'start' ? at : at + next, len: len - next },
  }
}

export type GesturePreview<S> = { last: S; step: S }

type Gesture<S> = {
  pointerId: number
  element: HTMLElement
  originX: number
  originY: number
  scrollX: number
  x: number
  y: number
  compute: (deltaPx: number, clientY: number) => S
  trim: TrimTarget | undefined
  moved: boolean
  last: S | undefined
}

type Held = { trim: boolean }

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const measure = (container: HTMLElement) => {
  const origin = container.getBoundingClientRect().left
  return new Map(
    [...container.querySelectorAll<HTMLElement>('[data-slide]')].map((node) => {
      const box = node.getBoundingClientRect()
      return [node.dataset['slide'] ?? '', { node, left: box.left - origin, width: box.width }]
    }),
  )
}

function useReleaseSlide(
  containerRef: RefObject<HTMLElement | null>,
  trim: TrimTarget | undefined,
) {
  const heldRef = useRef<{ trim: TrimTarget; spans: Map<string, { left: number; width: number }> }>(
    undefined,
  )
  const animationsRef = useRef<Animation[]>([])
  const stop = () => {
    for (const animation of animationsRef.current) animation.cancel()
    animationsRef.current = []
  }

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    if (trim !== undefined) {
      if (heldRef.current === undefined) stop()
      heldRef.current = {
        trim,
        spans: new Map(
          [...measure(container)].map(([key, { left, width }]) => [key, { left, width }] as const),
        ),
      }
      return
    }
    const held = heldRef.current
    heldRef.current = undefined
    if (held === undefined || reducedMotion()) return
    const style = getComputedStyle(container)
    const timing = {
      duration: Number.parseFloat(style.getPropertyValue('--dur-m')),
      easing: style.getPropertyValue('--ease').trim(),
    }
    for (const [key, { node, left, width }] of measure(container)) {
      const span = held.spans.get(key)
      if (span === undefined) continue
      const dragged = key === held.trim.slide && held.trim.edge === 'start'
      const was = dragged ? span.left + span.width - width : span.left
      if (Math.abs(was - left) < 0.5) continue
      animationsRef.current.push(
        node.animate([{ translate: `${was - left}px 0` }, { translate: '0 0' }], timing),
      )
    }
  })

  useEffect(() => stop, [])

  return {
    drop: () => {
      heldRef.current = undefined
    },
  }
}

type Options<S> = {
  containerRef: RefObject<HTMLElement | null>
  viewportRef: RefObject<HTMLElement | null>
  clicks: ReturnType<typeof useClickAfterDrag>
  accepts?: (step: S) => boolean
  onCommit: (last: S) => void
  onPreview?: (preview: GesturePreview<S> | null) => void
  onEnd?: () => void
}

export function usePreviewGesture<S>({
  containerRef,
  viewportRef,
  clicks,
  accepts = () => true,
  onCommit,
  onPreview,
  onEnd,
}: Options<S>) {
  const [state, setState] = useState<{
    preview: GesturePreview<S>
    trim: TrimTarget | undefined
  } | null>(null)
  const [held, setHeld] = useState<Held | null>(null)
  const gestureRef = useRef<Gesture<S> | null>(null)
  const slide = useReleaseSlide(containerRef, state?.trim)

  const show = (preview: GesturePreview<S> | null, trim?: TrimTarget) => {
    setState(preview === null ? null : { preview, trim })
    onPreview?.(preview)
  }

  const advance = (gesture: Gesture<S>) => {
    const scrolled =
      gesture.trim === undefined ? 0 : (viewportRef.current?.scrollLeft ?? 0) - gesture.scrollX
    const step = gesture.compute(gesture.x - gesture.originX + scrolled, gesture.y)
    if (accepts(step)) gesture.last = step
    const { last, trim } = gesture
    show(last === undefined ? null : { last, step }, trim)
  }

  const finish = (gesture: Gesture<S>, commit: boolean): boolean => {
    if (gestureRef.current !== gesture) return false
    gestureRef.current = null
    if (gesture.element.hasPointerCapture(gesture.pointerId))
      gesture.element.releasePointerCapture(gesture.pointerId)
    setHeld(null)
    if (!commit) slide.drop()
    show(null)
    if (gesture.moved) clicks.swallow()
    if (commit && gesture.moved && gesture.last !== undefined) onCommit(gesture.last)
    onEnd?.()
    return gesture.moved
  }

  const ended = useEffectEvent(
    (pointerId: number, commit: boolean, target?: EventTarget | null) => {
      const gesture = gestureRef.current
      if (gesture === null || gesture.pointerId !== pointerId) return
      if (target !== undefined && target !== gesture.element && gesture.element.isConnected) return
      finish(gesture, commit)
    },
  )

  useEffect(() => {
    if (held === null) return
    const up = (event: globalThis.PointerEvent) => ended(event.pointerId, true)
    const cancelled = (event: globalThis.PointerEvent) => ended(event.pointerId, false)
    const lost = (event: globalThis.PointerEvent) => ended(event.pointerId, true, event.target)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancelled)
    window.addEventListener('lostpointercapture', lost)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancelled)
      window.removeEventListener('lostpointercapture', lost)
    }
  }, [held])

  const scrolled = useEffectEvent(() => {
    const gesture = gestureRef.current
    if (gesture?.trim !== undefined && gesture.moved) advance(gesture)
  })

  const trimming = held?.trim === true
  useEffect(() => {
    const viewport = viewportRef.current
    if (!trimming || viewport === null) return
    const listener = () => scrolled()
    viewport.addEventListener('scroll', listener)
    return () => viewport.removeEventListener('scroll', listener)
  }, [trimming, viewportRef])

  useEdgeScroll({
    viewportRef,
    active: trimming,
    pointer: () => {
      const gesture = gestureRef.current
      return gesture?.moved === true ? { clientX: gesture.x, clientY: gesture.y } : null
    },
  })

  const begin = (
    event: PointerEvent<HTMLElement>,
    compute: Gesture<S>['compute'],
    trim: TrimTarget | undefined,
  ) => {
    if (event.button !== 0) return
    clicks.reset()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      element,
      originX: event.clientX,
      originY: event.clientY,
      scrollX: viewportRef.current?.scrollLeft ?? 0,
      x: event.clientX,
      y: event.clientY,
      compute,
      trim,
      moved: false,
      last: undefined,
    }
    setHeld({ trim: trim !== undefined })
  }

  const start = (event: PointerEvent<HTMLElement>, compute: Gesture<S>['compute']) =>
    begin(event, compute, undefined)

  const startTrim = (
    event: PointerEvent<HTMLElement>,
    target: TrimTarget,
    compute: Gesture<S>['compute'],
  ) => {
    event.stopPropagation()
    begin(event, compute, target)
  }

  const move = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    gesture.x = event.clientX
    gesture.y = event.clientY
    const deltaX = event.clientX - gesture.originX
    const deltaY = event.clientY - gesture.originY
    if (!gesture.moved && Math.max(Math.abs(deltaX), Math.abs(deltaY)) <= DRAG_THRESHOLD) return
    gesture.moved = true
    advance(gesture)
  }

  const end = (event: PointerEvent<HTMLElement>): boolean => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return false
    return finish(gesture, true)
  }

  const cancel = () => {
    const gesture = gestureRef.current
    if (gesture !== null) finish(gesture, false)
  }

  return { preview: state?.preview ?? null, start, startTrim, move, end, cancel }
}

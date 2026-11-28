import { useRef, useState, type PointerEvent, type RefObject } from 'react'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { useEditorEscape } from './editor-keys'
import { boxBetween, marqueeMode, marqueeSelection, type Box } from './selection'

/** 在行的空白处按下：拖过一点就是框选，没拖就是点空白处。 */
type Framing = {
  pointerId: number
  /** 按下的点，按时间区左上角算，框选中途滚动也不跑。 */
  origin: { x: number; y: number }
  /** 按下时带着 ⌘ 或 Ctrl：框住的加进原有选中。 */
  adding: boolean
  /** 按下时的选中，框选在它上面换、加或减。 */
  base: ReadonlySet<string>
  /** 触摸按下只算点一下，拖动留给滚动。 */
  canFrame: boolean
  started: boolean
}

/** 正在框选：框在哪（按时间区左上角算），松手的话会选中哪些片段。 */
type Marquee = { box: Box; ids: ReadonlySet<string> }

/**
 * 时间线各行空白处的框选：按下、拖过阈值才开始框，框住的片段随指针换、加或减（见 `marqueeMode`），松手换成框住的选中；
 * 没拖就是点了空白处，取消全部选中。框选中途按 Esc 只取消这次框选。`contentRef` 是时间区，框按它的左上角算。
 * 返回正在框的样子（没在框时是 null）、收起框选的函数，和挂在各行上的按下、拖动、松手处理函数。
 */
export function useTimelineMarquee({
  contentRef,
  selected,
  onSelect,
  onGesture,
}: {
  contentRef: RefObject<HTMLDivElement | null>
  selected: ReadonlySet<string>
  onSelect: (ids: ReadonlySet<string>) => void
  onGesture: (active: boolean) => void
}) {
  const framingRef = useRef<Framing | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)

  const pointIn = (clientX: number, clientY: number) => {
    const origin = contentRef.current?.getBoundingClientRect()
    return { x: clientX - (origin?.left ?? 0), y: clientY - (origin?.top ?? 0) }
  }

  const framed = (framing: Framing, event: PointerEvent<HTMLElement>): Marquee => {
    const box = boxBetween(framing.origin, pointIn(event.clientX, event.clientY))
    const found = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>('[data-clip-id]') ?? []),
    ].map((element) => {
      const { left, top, width, height } = element.getBoundingClientRect()
      const at = pointIn(left, top)
      return { id: element.dataset['clipId'] ?? '', box: { left: at.x, top: at.y, width, height } }
    })
    return {
      box,
      ids: marqueeSelection(found, box, framing.base, marqueeMode(framing.adding, event)),
    }
  }

  const dropFraming = () => {
    if (framingRef.current === null && marquee === null) return
    framingRef.current = null
    setMarquee(null)
    onGesture(false)
  }
  // 框选中途按 Esc：只取消这次框选，原来的选中不变
  useEditorEscape(marquee !== null, dropFraming)

  const pressLanes = (event: PointerEvent<HTMLDivElement>) => {
    const { target } = event
    // 行的右键菜单挂在别处，但它的事件也会沿着组件树传到这里
    if (event.button !== 0 || !(target instanceof Element) || !event.currentTarget.contains(target))
      return
    if (target.closest('[data-clip-id]') !== null) return
    const canFrame = event.pointerType !== 'touch'
    if (canFrame) event.currentTarget.setPointerCapture(event.pointerId)
    framingRef.current = {
      pointerId: event.pointerId,
      origin: pointIn(event.clientX, event.clientY),
      adding: event.metaKey || event.ctrlKey,
      base: selected,
      canFrame,
      started: false,
    }
  }

  const dragLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId || !framing.canFrame) return
    if (!framing.started) {
      const at = pointIn(event.clientX, event.clientY)
      const moved = Math.max(Math.abs(at.x - framing.origin.x), Math.abs(at.y - framing.origin.y))
      if (moved <= DRAG_THRESHOLD) return
      framing.started = true
      onGesture(true)
    }
    setMarquee(framed(framing, event))
  }

  const releaseLanes = (event: PointerEvent<HTMLDivElement>) => {
    const framing = framingRef.current
    if (framing === null || framing.pointerId !== event.pointerId) return
    releasePointer(event)
    // 没拖就是点了空白处：取消全部选中
    onSelect(framing.started ? framed(framing, event).ids : new Set())
    dropFraming()
  }

  return { marquee, dropFraming, pressLanes, dragLanes, releaseLanes }
}

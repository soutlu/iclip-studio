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

/**
 * 时间线上的拖动（修剪把手、挪块）：两个编辑器共用。拖动中只预览，松手才提交一次。
 *
 * 修剪首尾相接的一串块里的一块时，拖动中别的块都按已提交的位置画、不动；被拖的块画成一整块（见
 * {@link trimSpans}），盖在相邻的块上，要剪掉的那一段调暗。松手后后面的块滑到首尾相接的位置。
 */

/** 按下的是一串首尾相接的块里哪一块的哪个把手：`slide` 是这一块的 `data-slide` 值。 */
export type TrimTarget = { slide: string; edge: Edge }

/** 时间线上的一段（调用方的时间单位）。 */
export type Span = { at: number; len: number }

/**
 * 修剪拖动中被拖的那块怎么画：这块已提交时从 `at` 起、长 `len`，修剪后长 `next`。按已提交的布局，被拖的那一端
 * 停在把手处、另一端不动：`kept` 是修剪后的范围（选中框、把手按它摆）；整块按「已提交 ∪ 修剪后」画成一个元素
 * （`block`，里面是这一整段的画面）；往里裁时 `cut` 是要剪掉的那段（调暗）。左把手往外拉长越过 0 时左边没有
 * 轨道：整块左边钉在 0、向右变长，`kept` 跟着右移，把手停在 0。
 */
export const trimSpans = (
  edge: Edge,
  { at, len }: Span,
  next: number,
): { block: Span; kept: Span; cut: Span | undefined } => {
  const keptAt = edge === 'start' ? at + len - next : at
  const blockAt = Math.min(at, keptAt)
  const blockLen = Math.max(at + len, keptAt + next) - blockAt
  // 拉长段越过 0：整块右移到从 0 起
  const shift = Math.max(0, -blockAt)
  const kept = { at: keptAt + shift, len: next }
  const block = { at: blockAt + shift, len: blockLen }
  if (next >= len) return { block, kept, cut: undefined }
  // 剪掉的那一段贴着被拖的那一端：左把手在原来开头与保留段之间，右把手在保留段与原来结尾之间
  return {
    block,
    kept,
    cut: { at: edge === 'start' ? at : at + next, len: len - next },
  }
}

/**
 * 拖动中的样子：`last` 是上一个放得下的一步（按它画），`step` 是指针此刻这一步（可能放不下，提示取它的）。
 */
export type GesturePreview<S> = { last: S; step: S }

type Gesture<S> = {
  pointerId: number
  /** 捕获指针的元素（按下的把手或块）。 */
  element: HTMLElement
  originX: number
  originY: number
  /** 按下时滚动区滚到哪；修剪拖动的位移算上之后滚过的距离。 */
  scrollX: number
  /** 指针最后在哪：滚动区滚了、指针没动时按它重算。 */
  x: number
  y: number
  /** 横向的累计位移，与指针现在的纵坐标（换行的拖动按它算落在哪一行） */
  compute: (deltaPx: number, clientY: number) => S
  trim: TrimTarget | undefined
  moved: boolean
  last: S | undefined
}

/**
 * 正按着的一次拖动（每次按下一个新对象）：拖动期间在 window 上听它的松手、取消与丢失捕获；修剪（`trim`）时
 * 另外边缘滚动、听滚动区的 scroll。
 */
type Held = { trim: boolean }

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 容器里带 `data-slide` 的元素与它们此刻的左边、宽（像素，左边从容器左边量）。 */
const measure = (container: HTMLElement) => {
  const origin = container.getBoundingClientRect().left
  return new Map(
    [...container.querySelectorAll<HTMLElement>('[data-slide]')].map((node) => {
      const box = node.getBoundingClientRect()
      return [node.dataset['slide'] ?? '', { node, left: box.left - origin, width: box.width }]
    }),
  )
}

/**
 * 修剪把手松手后，容器里带 `data-slide`（值是各自的稳定 key）的元素从拖动中的位置平移到首尾相接后的位置，
 * 宽度不变。被拖的块（`trim.slide`）拖的是左把手时，从拖动中修剪后范围所在的地方滑过来（它的右边沿减新宽），与
 * 选中框、把手一起动。时长与缓动取设计系统的 `--dur-m`、`--ease`，系统要求减少动态效果时直接显示结果。
 * `trim` 是正在拖的修剪把手。动画用 CSS 的 `translate` 属性，不碰元素自己的 `transform`（成片画面轨的块由
 * 插入动效按 transform 摆）。返回 `drop`：放弃这次拖动时调用，回到原样不滑。
 */
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

  // 每次画完都要量：拖动中记下最后一次的位置，松手那一次画完再量一次、从记下的位置滑过来。
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
  /** 时间线的内容层：修剪把手松手后在它里面找 `data-slide` 的元素滑过去。 */
  containerRef: RefObject<HTMLElement | null>
  /**
   * 时间线的横向滚动区：修剪拖动中指针靠近它左右边缘时自动滚动（见 useEdgeScroll），`compute` 收到的位移算上
   * 按下以来滚过的距离。
   */
  viewportRef: RefObject<HTMLElement | null>
  /** 拖完松手时浏览器补的那一下 click 由它吞掉。 */
  clicks: ReturnType<typeof useClickAfterDrag>
  /** 这一步放不放得下；放不下时预览停在上一个放得下的一步。不给时每一步都放得下。 */
  accepts?: (step: S) => boolean
  /** 松手：提交上一个放得下的一步，一次拖动只调一次。 */
  onCommit: (last: S) => void
  /** 预览变了（拖动中每一步）；松手、取消时给 null（按下没拖动就松手也给）。 */
  onPreview?: (preview: GesturePreview<S> | null) => void
  /** 这次拖动结束了：松手、取消、丢了指针捕获都算，一次拖动只调一次。 */
  onEnd?: () => void
}

/**
 * 一次拖动是一步编辑：按下时记住当时的数据（由 `compute` 闭包带着），超过拖动阈值才算拖，之后按累计位移算出
 * 预览，放不下的位置不去、停在上一个放得下的地方；松手只提交那一次结果，并吞掉随后的 click。没超过阈值算点按，
 * 不提交。指针被系统取消（pointercancel）或调用方 `cancel` 时什么都不提交，回到按下前的样子。
 *
 * 拖动一定会结束：除了按下的元素上的事件，拖动期间还在 window 上听这个指针的 pointerup、pointercancel 与
 * lostpointercapture（元素被移出文档时这个事件发到 document）。哪个先到就按哪个结束，只结束一次：pointerup 与
 * 丢失捕获按松手，pointercancel 按取消。
 *
 * 修剪一串首尾相接的块用 `startTrim`：拖动中调用方按已提交的布局画（见 {@link trimSpans}），指针靠近时间线
 * 可视范围左右边缘时自动滚动（指针拖出可视范围也接着滚），松手后滑到首尾相接的位置。修剪拖动的位移算上按下
 * 以来滚动区滚过的距离，滚动区滚了（自动滚动、滚轮、内容变短被浏览器收回）而指针没动时也重算一步，把手不脱离
 * 指针。挪块不自动滚动。
 */
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

  /** 按指针最后的位置（修剪拖动另算上滚过的距离）算这一步、更新预览。 */
  const advance = (gesture: Gesture<S>) => {
    const scrolled =
      gesture.trim === undefined ? 0 : (viewportRef.current?.scrollLeft ?? 0) - gesture.scrollX
    const step = gesture.compute(gesture.x - gesture.originX + scrolled, gesture.y)
    if (accepts(step)) gesture.last = step
    const { last, trim } = gesture
    show(last === undefined ? null : { last, step }, trim)
  }

  /** 结束这次拖动；已经结束过（或已换成另一次）时什么都不做。返回这一下算不算拖动。 */
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
      // 丢失捕获只认按下的元素，或它已被移出文档（这时事件发到 document）
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

  /** 滚动区滚了：修剪拖动已经在拖时按指针最后的位置重算一步。 */
  const scrolled = useEffectEvent(() => {
    const gesture = gestureRef.current
    if (gesture?.trim !== undefined && gesture.moved) advance(gesture)
  })

  // 修剪拖动中听滚动区的 scroll：自动滚动、滚轮，以及拖动中内容变短时浏览器收回的滚动都算进位移
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

  /** 按下一处开始拖（挪块）。 */
  const start = (event: PointerEvent<HTMLElement>, compute: Gesture<S>['compute']) =>
    begin(event, compute, undefined)

  /** 按下一串首尾相接的块里某一块的修剪把手；不让按下传到块上（块自己也能拖）。 */
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

  /** 松手；返回这一下算不算拖动（不算就当点按处理） */
  const end = (event: PointerEvent<HTMLElement>): boolean => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return false
    return finish(gesture, true)
  }

  /** 放弃这次拖动：什么都不提交，回到按下前的样子。 */
  const cancel = () => {
    const gesture = gestureRef.current
    if (gesture !== null) finish(gesture, false)
  }

  return { preview: state?.preview ?? null, start, startTrim, move, end, cancel }
}

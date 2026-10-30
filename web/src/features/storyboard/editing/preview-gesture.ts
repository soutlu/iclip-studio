import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from 'react'
import { DRAG_THRESHOLD, releasePointer, type Edge, type useClickAfterDrag } from './timeline-drag'

/**
 * 时间线上的拖动（修剪把手、挪块）：两个编辑器共用。拖动中只预览，松手才提交一次。
 *
 * 修剪首尾相接的一串块里的一块时，拖动中所有块都按已提交的位置画、不动，只有把手跟手；要剪掉的那一段调暗，
 * 往外拉长多出来的那一段标一个框（见 {@link trimSpans}）。松手后后面的块滑到首尾相接的位置。
 */

/** 按下的是一串首尾相接的块里哪一块的哪个把手：`slide` 是这一块的 `data-slide` 值。 */
export type TrimTarget = { slide: string; edge: Edge }

/** 时间线上的一段（调用方的时间单位）。 */
export type Span = { at: number; len: number }

/**
 * 修剪拖动中一块怎么画：这块已提交时从 `at` 起、长 `len`，修剪后长 `next`。按已提交的布局，被拖的那一端停在
 * 把手处、另一端不动：`kept` 是保留下来的那段（选中框、把手按它摆），往里裁时 `cut` 是要剪掉的那段，往外拉长时
 * `added` 是多出来的那段（盖在相邻的块上）。
 */
export const trimSpans = (
  edge: Edge,
  { at, len }: Span,
  next: number,
): { kept: Span; cut: Span | undefined; added: Span | undefined } => {
  const kept = { at: edge === 'start' ? at + len - next : at, len: next }
  const by = Math.abs(len - next)
  if (by === 0) return { kept, cut: undefined, added: undefined }
  // 变化的那一段贴着被拖的那一端：左把手在保留段与原来开头之间，右把手在保留段与原来结尾之间
  const changed = {
    at: edge === 'start' ? Math.min(at, kept.at) : at + Math.min(len, next),
    len: by,
  }
  return next < len
    ? { kept, cut: changed, added: undefined }
    : { kept, cut: undefined, added: changed }
}

/**
 * 拖动中的样子：`last` 是上一个放得下的一步（按它画），`step` 是指针此刻这一步（可能放不下，提示取它的）。
 */
export type GesturePreview<S> = { last: S; step: S }

type Gesture<S> = {
  pointerId: number
  originX: number
  originY: number
  /** 横向的累计位移，与指针现在的纵坐标（换行的拖动按它算落在哪一行） */
  compute: (deltaPx: number, clientY: number) => S
  trim: TrimTarget | undefined
  moved: boolean
  last: S | undefined
}

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
 * 宽度不变。被拖的块（`trim.slide`）拖的是左把手时，从拖动中保留段所在的地方滑过来（它的右边沿减新宽），与
 * 选中框、把手一起动。时长与缓动取设计系统的 `--dur-m`、`--ease`，系统要求减少动态效果时直接显示结果。
 * `trim` 是正在拖的修剪把手。动画用 CSS 的 `translate` 属性，不碰元素自己的 `transform`（成片画面轨的块由
 * 插入动效按 transform 摆）。
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
}

type Options<S> = {
  /** 时间线的内容层：修剪把手松手后在它里面找 `data-slide` 的元素滑过去。 */
  containerRef: RefObject<HTMLElement | null>
  /** 拖完松手时浏览器补的那一下 click 由它吞掉。 */
  clicks: ReturnType<typeof useClickAfterDrag>
  /** 这一步放不放得下；放不下时预览停在上一个放得下的一步。不给时每一步都放得下。 */
  accepts?: (step: S) => boolean
  /** 松手：提交上一个放得下的一步，一次拖动只调一次。 */
  onCommit: (last: S) => void
  /** 预览变了（拖动中每一步）；松手、取消时给 null（按下没拖动就松手也给）。 */
  onPreview?: (preview: GesturePreview<S> | null) => void
}

/**
 * 一次拖动是一步编辑：按下时记住当时的数据（由 `compute` 闭包带着），超过拖动阈值才算拖，之后按累计位移算出
 * 预览，放不下的位置不去、停在上一个放得下的地方；松手只提交那一次结果，并吞掉随后的 click。没超过阈值算点按，
 * 不提交。指针被系统取消（pointercancel）或调用方 `cancel` 时什么都不提交，回到按下前的样子。
 *
 * 修剪一串首尾相接的块用 `startTrim`：拖动中调用方按已提交的布局画（见 {@link trimSpans}），松手后滑到首尾
 * 相接的位置。
 */
export function usePreviewGesture<S>({
  containerRef,
  clicks,
  accepts = () => true,
  onCommit,
  onPreview,
}: Options<S>) {
  const [state, setState] = useState<{
    preview: GesturePreview<S>
    trim: TrimTarget | undefined
  } | null>(null)
  const gestureRef = useRef<Gesture<S> | null>(null)
  useReleaseSlide(containerRef, state?.trim)

  const show = (preview: GesturePreview<S> | null, trim?: TrimTarget) => {
    setState(preview === null ? null : { preview, trim })
    onPreview?.(preview)
  }

  const begin = (
    event: PointerEvent<HTMLElement>,
    compute: Gesture<S>['compute'],
    trim: TrimTarget | undefined,
  ) => {
    if (event.button !== 0) return
    clicks.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      compute,
      trim,
      moved: false,
      last: undefined,
    }
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
    const deltaPx = event.clientX - gesture.originX
    const deltaY = event.clientY - gesture.originY
    if (!gesture.moved && Math.max(Math.abs(deltaPx), Math.abs(deltaY)) <= DRAG_THRESHOLD) return
    gesture.moved = true
    const step = gesture.compute(deltaPx, event.clientY)
    if (accepts(step)) gesture.last = step
    const { last, trim } = gesture
    show(last === undefined ? null : { last, step }, trim)
  }

  /** 松手；返回这一下算不算拖动（不算就当点按处理） */
  const end = (event: PointerEvent<HTMLElement>): boolean => {
    const gesture = gestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return false
    releasePointer(event)
    gestureRef.current = null
    show(null)
    if (gesture.moved) clicks.swallow()
    if (gesture.moved && gesture.last !== undefined) onCommit(gesture.last)
    return gesture.moved
  }

  /** 放弃这次拖动：什么都不提交，回到按下前的样子。 */
  const cancel = () => {
    const gesture = gestureRef.current
    if (gesture === null) return
    gestureRef.current = null
    if (gesture.moved) clicks.swallow()
    show(null)
  }

  return { preview: state?.preview ?? null, start, startTrim, move, end, cancel }
}

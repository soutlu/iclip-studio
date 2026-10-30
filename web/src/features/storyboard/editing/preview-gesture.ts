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
 * 修剪首尾相接的一串块里某一块的左把手时，数据照常首尾相接（这块的开头接在前一块末尾，变的只是长度），显示上
 * 却让左边沿跟着指针、这块的右边沿与后面的块停在按下时的位置，同右把手「拖哪端动哪端」；松手后再从拖动中的
 * 位置滑到首尾相接后的位置。
 */

/** 按下的是一串首尾相接的块里哪一块的哪个把手：`end` 是按下时这块的右边沿（调用方的时间单位）。 */
export type TrimTarget = { id: string; edge: Edge; end: number }

/** 一串首尾相接的块怎么读、怎么挪（调用方的时间单位）。 */
export type Chain<T> = {
  startOf: (item: T) => number
  lengthOf: (item: T) => number
  /** 这一块挪到 `start` 显示。 */
  moved: (item: T, start: number) => T
}

/** 显示用的块，与把此刻的时刻换成显示位置的 `shiftAt`（播放头、提示用）。 */
export type Held<T> = { items: readonly T[]; shiftAt: (time: number) => number }

/**
 * 拖动中的样子：`last` 是上一个放得下的一步（按它画），`step` 是指针此刻这一步（可能放不下，提示取它的）；
 * `hold` 把一串块按这次拖动摆成显示位置（只有修剪左把手时才挪）。
 */
export type GesturePreview<S> = {
  last: S
  step: S
  hold: <T extends { id: string }>(items: readonly T[], chain: Chain<T>) => Held<T>
}

/** 左把手按下时被拖的那一块与它那时的右边沿。 */
type Pin = { id: string; end: number }

type Gesture<S> = {
  pointerId: number
  originX: number
  originY: number
  /** 横向的累计位移，与指针现在的纵坐标（换行的拖动按它算落在哪一行） */
  compute: (deltaPx: number, clientY: number) => S
  pin: Pin | undefined
  moved: boolean
  last: S | undefined
}

/**
 * 拖左把手期间各块的显示位置：被拖的块与它后面的块一起往回挪「按下时的右边沿 − 此刻的右边沿」，前面的块不动；
 * 往左拉长时被拖的块盖在前一块上（由调用方让它在上层），不夹到前一块末尾。只有在时间 0 之前画不下时才停在 0，
 * 后面的块随之后移。
 */
const holdLeftTrim = <T extends { id: string }>(
  items: readonly T[],
  pin: Pin | undefined,
  { startOf, lengthOf, moved }: Chain<T>,
): Held<T> => {
  const index = pin === undefined ? -1 : items.findIndex((item) => item.id === pin.id)
  const dragged = items[index]
  if (pin === undefined || dragged === undefined) return { items, shiftAt: (time) => time }
  const start = startOf(dragged)
  const by = Math.max(pin.end - (start + lengthOf(dragged)), -start)
  if (by === 0) return { items, shiftAt: (time) => time }
  return {
    items: items.map((item, at) => (at < index ? item : moved(item, startOf(item) + by))),
    shiftAt: (time) => (time >= start ? time + by : time),
  }
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 容器里带 `data-slide` 的元素与它们此刻的左边（像素，从容器左边量）。 */
const measure = (container: HTMLElement) => {
  const origin = container.getBoundingClientRect().left
  return new Map(
    [...container.querySelectorAll<HTMLElement>('[data-slide]')].map((node) => [
      node.dataset['slide'] ?? '',
      { node, left: node.getBoundingClientRect().left - origin },
    ]),
  )
}

/**
 * 拖左把手松手后，容器里带 `data-slide`（值是各自的稳定 key）的元素从拖动中的显示位置平移到首尾相接后的位置，
 * 宽度不变；时长与缓动取设计系统的 `--dur-m`、`--ease`，系统要求减少动态效果时直接显示结果。`holding` 是正在
 * 拖左把手。动画用 CSS 的 `translate` 属性，不碰元素自己的 `transform`（成片画面轨的块由插入动效按 transform 摆）。
 */
function useReleaseSlide(containerRef: RefObject<HTMLElement | null>, holding: boolean) {
  const heldRef = useRef<Map<string, number>>(undefined)
  const animationsRef = useRef<Animation[]>([])
  const stop = () => {
    for (const animation of animationsRef.current) animation.cancel()
    animationsRef.current = []
  }

  // 每次画完都要量：拖动中记下最后一次的显示位置，松手那一次画完再量一次、从记下的位置滑过来。
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    if (holding) {
      if (heldRef.current === undefined) stop()
      heldRef.current = new Map(
        [...measure(container)].map(([key, { left }]) => [key, left] as const),
      )
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
    for (const [key, { node, left }] of measure(container)) {
      const was = held.get(key)
      if (was === undefined || Math.abs(was - left) < 0.5) continue
      animationsRef.current.push(
        node.animate([{ translate: `${was - left}px 0` }, { translate: '0 0' }], timing),
      )
    }
  })

  useEffect(() => stop, [])
}

type Options<S> = {
  /** 时间线的内容层：左把手松手后在它里面找 `data-slide` 的元素滑过去。 */
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
 * 修剪把手用 `startTrim`：按的是左把手时，拖动中按 {@link GesturePreview.hold} 画，松手后滑到首尾相接的位置。
 */
export function usePreviewGesture<S>({
  containerRef,
  clicks,
  accepts = () => true,
  onCommit,
  onPreview,
}: Options<S>) {
  const [state, setState] = useState<{ preview: GesturePreview<S>; pin: Pin | undefined } | null>(
    null,
  )
  const gestureRef = useRef<Gesture<S> | null>(null)
  useReleaseSlide(containerRef, state?.pin !== undefined)

  const show = (preview: GesturePreview<S> | null, pin?: Pin) => {
    setState(preview === null ? null : { preview, pin })
    onPreview?.(preview)
  }

  const begin = (
    event: PointerEvent<HTMLElement>,
    compute: Gesture<S>['compute'],
    pin: Pin | undefined,
  ) => {
    if (event.button !== 0) return
    clicks.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      compute,
      pin,
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
    { id, edge, end }: TrimTarget,
    compute: Gesture<S>['compute'],
  ) => {
    event.stopPropagation()
    begin(event, compute, edge === 'start' ? { id, end } : undefined)
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
    const { last, pin } = gesture
    show(
      last === undefined
        ? null
        : { last, step, hold: (items, chain) => holdLeftTrim(items, pin, chain) },
      pin,
    )
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

  return {
    preview: state?.preview ?? null,
    start,
    startTrim,
    move,
    end,
    cancel,
    /** 一串首尾相接的块此刻的显示位置：没在拖左把手时就是它们自己。 */
    hold: <T extends { id: string }>(items: readonly T[], chain: Chain<T>): Held<T> =>
      state === null ? { items, shiftAt: (time) => time } : state.preview.hold(items, chain),
  }
}

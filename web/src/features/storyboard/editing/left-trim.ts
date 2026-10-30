import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * 拖首尾相接的一串块里某一块的左把手：数据照常首尾相接（这块的开头钉在前一块末尾，变的只是长度），显示上
 * 却让左边沿跟着指针、这块的右边沿与后面的块停在按下时的位置，同原片选区的把手、右把手「拖哪端动哪端」。
 * 编辑视频的草稿与成片的画面轨共用这里：拖动中按 {@link holdLeftTrim} 画，松手后由 {@link useReleaseSlide}
 * 滑到首尾相接后的位置。
 */

/** 按下左把手时被拖的那一块：id 与它那时的右边沿（调用方的时间单位）。 */
export type LeftTrimHold = { id: string; end: number }

type Span<T> = {
  startOf: (item: T) => number
  lengthOf: (item: T) => number
  /** 这一块挪到 `start` 显示。 */
  moved: (item: T, start: number) => T
}

/**
 * 拖左把手期间各块的显示位置：被拖的块与它后面的块一起往回挪「按下时的右边沿 − 此刻的右边沿」，前面的块不动；
 * 往左拉长时被拖的块盖在前一块上（由调用方让它在上层），不夹到前一块末尾。只有在时间 0 之前画不下时才停在 0，
 * 后面的块随之后移。返回显示用的块，与把此刻的时刻换成显示位置的 `shiftAt`（播放头用）。
 */
export const holdLeftTrim = <T extends { id: string }>(
  items: readonly T[],
  hold: LeftTrimHold | undefined,
  { startOf, lengthOf, moved }: Span<T>,
): { items: readonly T[]; shiftAt: (time: number) => number } => {
  const index = hold === undefined ? -1 : items.findIndex((item) => item.id === hold.id)
  const dragged = items[index]
  if (hold === undefined || dragged === undefined) return { items, shiftAt: (time) => time }
  const start = startOf(dragged)
  const by = Math.max(hold.end - (start + lengthOf(dragged)), -start)
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
 * 拖左把手、显示位置挪过（见 {@link holdLeftTrim}）。动画用 CSS 的 `translate` 属性，不碰元素自己的
 * `transform`（成片画面轨的块由插入动效按 transform 摆）。
 */
export function useReleaseSlide(containerRef: RefObject<HTMLElement | null>, holding: boolean) {
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

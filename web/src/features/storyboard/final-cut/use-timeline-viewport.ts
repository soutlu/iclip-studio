import { useEffect, useLayoutEffect, type RefObject } from 'react'
import type { TimelineHandle } from './film-timeline'
import type { RowTarget, Zone } from './placement'

// 时间区左右留的空，露出开头的播放头和两端的把手；不算进能排时间的宽度。只在这里定，时间区的外边距用它
export const INSET = { left: 8, right: 6 }

/**
 * 时间线的滚动容器对编辑器的那一面：量出能排时间的宽度报给 `onViewportWidth`（容器或行头那一列变宽变窄时重报），
 * 给编辑器挂上句柄 `handleRef`（素材落点、横向滚到哪、把片段滚进视野），`scrollRequest` 换了新的就横向滚过去。
 * `rowAt`、`timeAt` 把屏幕坐标换成行和 final-cut 的时间。
 */
export function useTimelineViewport({
  scrollRef,
  headsRef,
  contentRef,
  onViewportWidth,
  scrollRequest,
  handleRef,
  rowAt,
  timeAt,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  headsRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onViewportWidth: (width: number) => void
  scrollRequest: { left: number } | null
  handleRef: RefObject<TimelineHandle | null>
  rowAt: (clientY: number, between: boolean, zone: Zone) => RowTarget | undefined
  timeAt: (clientX: number) => number
}) {
  useLayoutEffect(() => {
    const viewport = scrollRef.current
    const heads = headsRef.current
    if (viewport === null || heads === null) return
    // 行头那一列和时间区在同一个滚动容器里，排时间的宽度要把它去掉
    const report = () =>
      onViewportWidth(
        Math.max(0, viewport.clientWidth - heads.offsetWidth - INSET.left - INSET.right),
      )
    report()
    const observer = new ResizeObserver(report)
    observer.observe(viewport)
    observer.observe(heads)
    return () => observer.disconnect()
    // 两个 ref 是调用方 useRef 出来的，不会换；照旧只在 `onViewportWidth` 换了时重新挂
  }, [headsRef, onViewportWidth, scrollRef])

  useEffect(() => {
    handleRef.current = {
      locate: (clientX, clientY, zone) => {
        const viewport = scrollRef.current
        const heads = headsRef.current
        if (viewport === null || heads === null) return null
        const right =
          viewport.getBoundingClientRect().left + viewport.clientLeft + viewport.clientWidth
        if (clientX < heads.getBoundingClientRect().right || clientX > right) return null
        const row = rowAt(clientY, zone === 'audio', zone)
        return row === undefined ? null : { row, timeMs: Math.max(0, timeAt(clientX)) }
      },
      scrollLeft: () => scrollRef.current?.scrollLeft ?? 0,
      reveal: (id) =>
        [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-clip-id]') ?? [])]
          .find((element) => element.dataset['clipId'] === id)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
    }
    return () => {
      handleRef.current = null
    }
  })

  // 缩放以后：等新的宽度排好再横向滚过去，不然会被原来的宽度挡住
  useLayoutEffect(() => {
    const viewport = scrollRef.current
    if (scrollRequest !== null && viewport !== null) viewport.scrollLeft = scrollRequest.left
  }, [scrollRef, scrollRequest])
}

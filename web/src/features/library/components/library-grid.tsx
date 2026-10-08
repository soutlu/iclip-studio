/** 瀑布流：TanStack Virtual 的多列（lanes）虚拟列表，只渲染视口附近的卡片；列数随容器宽度变。成片与参考视频共用，卡片长什么样由调用方给。 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react'
import { columnCountFor, columnGapFor } from '../library-layout'

/** 同一列里上下两张卡的间距。 */
const ROW_GAP = 20

/** 首帧还没量到容器时按这个视口估，jsdom 里也靠它渲染出卡片。 */
const INITIAL_RECT = { height: 900, width: 1200 }

type LibraryGridProps<T> = {
  items: readonly T[]
  keyOf: (item: T) => string
  /** 按列宽估的整张卡高度；估准了布局就不跳，估不准由挂上后的实测纠正。 */
  estimateHeight: (item: T, columnWidth: number) => number
  renderItem: (item: T, columnWidth: number) => ReactNode
  /** 页面的滚动容器；虚拟列表跟着它的滚动位置算哪些卡在视口里。 */
  getScrollElement: () => HTMLElement | null
}

export function LibraryGrid<T>({
  items,
  keyOf,
  estimateHeight,
  renderItem,
  getScrollElement,
}: LibraryGridProps<T>) {
  const [{ width, offsetTop }, containerRef] = useContainerBox(getScrollElement)
  const lanes = columnCountFor(width)
  const gap = columnGapFor(width)
  const columnWidth = width > 0 ? (width - gap * (lanes - 1)) / lanes : 0

  // eslint-disable-next-line react-hooks/incompatible-library -- 虚拟列表的方法随滚动变化，编译器跳过这个组件正是需要的
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => {
      const item = items[index]
      return item === undefined ? 0 : estimateHeight(item, columnWidth)
    },
    gap: ROW_GAP,
    getItemKey: (index) => {
      const item = items[index]
      return item === undefined ? index : keyOf(item)
    },
    getScrollElement,
    initialRect: INITIAL_RECT,
    lanes,
    overscan: 6,
    scrollMargin: offsetTop,
  })

  // 列宽一变，按新列宽重估全部卡片的高度并重新分列。
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [virtualizer, lanes, columnWidth])

  return (
    <div
      className="relative w-full"
      ref={containerRef}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const item = items[row.index]
        if (item === undefined) return null
        return (
          <div
            className="absolute top-0"
            data-index={row.index}
            key={row.key}
            ref={virtualizer.measureElement}
            style={{
              left: row.lane * (columnWidth + gap),
              transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
              width: columnWidth,
            }}
          >
            {renderItem(item, columnWidth)}
          </div>
        )
      })}
    </div>
  )
}

/** 容器宽度与它在滚动容器里的纵向偏移，连同要挂到容器上的 ref；宽度变了（筛选条换行、侧栏收起）两者一起重量。 */
function useContainerBox(getScrollElement: () => HTMLElement | null) {
  const [box, setBox] = useState({ offsetTop: 0, width: 0 })

  const containerRef = useCallback(
    (container: HTMLDivElement | null) => {
      if (container === null) return
      const measure = () => {
        const scroller = getScrollElement()
        const top = container.getBoundingClientRect().top
        const offsetTop =
          scroller === null ? 0 : top - scroller.getBoundingClientRect().top + scroller.scrollTop
        const width = container.clientWidth
        setBox((old) =>
          old.width === width && old.offsetTop === offsetTop ? old : { offsetTop, width },
        )
      }
      // 挂上时同步量一次：ResizeObserver 首次回调引起的重渲染赶不上首帧，按宽 0 排出的高度会让页脚误判到底。
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(container)
      return () => observer.disconnect()
    },
    [getScrollElement],
  )

  return [box, containerRef] as const
}

/** 几种常见画幅轮着占位，和真卡同一个节奏。 */
const SKELETONS = [
  { id: 'a', ratio: '9 / 16' },
  { id: 'b', ratio: '3 / 4' },
  { id: 'c', ratio: '9 / 16' },
  { id: 'd', ratio: '16 / 9' },
  { id: 'e', ratio: '9 / 16' },
  { id: 'f', ratio: '4 / 5' },
  { id: 'g', ratio: '9 / 16' },
  { id: 'h', ratio: '3 / 4' },
] as const

/** 读取中的占位：CSS 多列排几张灰卡，读屏只读到 label。 */
export function LibraryGridSkeleton({ label }: { label: string }) {
  return (
    <div className="library-skeleton-grid" role="status">
      <span className="sr-only">{label}</span>
      {SKELETONS.map(({ id, ratio }) => (
        <div
          aria-hidden="true"
          className="mb-5 flex break-inside-avoid flex-col gap-2 motion-safe:animate-pulse"
          key={id}
        >
          <div className="rounded-md bg-surface-container-low" style={{ aspectRatio: ratio }} />
          <div className="h-3 w-4/5 rounded-xs bg-surface-container-low" />
          <div className="h-3 w-1/2 rounded-xs bg-surface-container-low" />
        </div>
      ))}
    </div>
  )
}

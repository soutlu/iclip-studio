import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useLayoutEffect, useState, type ReactNode } from 'react'
import { columnCountFor, columnGapFor } from '../library-layout'

const ROW_GAP = 20

const INITIAL_RECT = { height: 900, width: 1200 }

type LibraryGridProps<T> = {
  items: readonly T[]
  keyOf: (item: T) => string
  estimateHeight: (item: T, columnWidth: number) => number
  renderItem: (item: T, columnWidth: number) => ReactNode
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
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(container)
      return () => observer.disconnect()
    },
    [getScrollElement],
  )

  return [box, containerRef] as const
}

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

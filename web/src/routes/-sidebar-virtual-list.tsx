import { useDroppable } from '@dnd-kit/core'
import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { useCallback, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'

/** 一个命名区段；给了 `dropId` 时整个区段是这个 id 的拖放落点。 */
export type SidebarSection = {
  key: string
  label: string
  dropId?: string
}

export type SidebarVirtualRow = {
  key: string
  section: SidebarSection
  /** 连续的同组行包进一个以 `label` 命名的 group。 */
  group?: { key: string; label: string }
  height: number
  focusable?: boolean
  retain?: boolean
  sticky?: boolean
  /** `retain(true)` 让这一行滚出视口也保持挂载，直到 `retain(false)`。 */
  render: (retain: (active: boolean) => void) => ReactNode
}

type SectionBounds = { section: SidebarSection; first: number; last: number }
const INITIAL_RECT = { width: 248, height: 900 }

export function SidebarVirtualList({
  rows,
  getScrollElement,
  canDrop,
}: {
  rows: readonly SidebarVirtualRow[]
  getScrollElement: () => HTMLElement | null
  canDrop: boolean
}) {
  const [scrollMargin, setScrollMargin] = useState(0)
  const [focused, setFocused] = useState<string | null>(null)
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  const retain = useCallback((key: string, active: boolean) => {
    setHeld((previous) => {
      if (previous.has(key) === active) return previous
      const next = new Set(previous)
      if (active) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const retained = new Set<number>()
  const sections = new Map<string, SectionBounds>()
  const focusable: number[] = []
  rows.forEach((row, index) => {
    const bounds = sections.get(row.section.key)
    sections.set(row.section.key, {
      section: row.section,
      first: bounds?.first ?? index,
      last: index,
    })
    if (row.sticky || row.retain || held.has(row.key)) retained.add(index)
    if (row.focusable) focusable.push(index)
  })
  const focusedIndex = rows.findIndex((row) => row.key === focused)
  if (focusedIndex < 0) {
    const first = focusable[0]
    const last = focusable.at(-1)
    if (first !== undefined) retained.add(first)
    if (last !== undefined) retained.add(last)
  }
  if (focusedIndex >= 0) {
    retained.add(focusedIndex)
    const before = focusable.findLast((index) => index < focusedIndex)
    const after = focusable.find((index) => index > focusedIndex)
    if (before !== undefined) retained.add(before)
    if (after !== undefined) retained.add(after)
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- 虚拟窗口随滚动变化，不让编译器缓存其方法结果。
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => rows[index]?.height ?? 36,
    measureElement: (element, entry) =>
      entry?.borderBoxSize[0]?.blockSize ||
      element.getBoundingClientRect().height ||
      rows[Number(element.getAttribute('data-index'))]?.height ||
      36,
    initialRect: INITIAL_RECT,
    scrollMargin,
    gap: 1,
    overscan: 6,
    rangeExtractor: (range) =>
      [...new Set([...defaultRangeExtractor(range), ...retained])].sort((a, b) => a - b),
    // 自动分页在视口上方插入行时保留位置，末尾追加时不跟随滚动。
    anchorTo: 'end',
    followOnAppend: false,
  })
  const visible = virtualizer.getVirtualItems()
  const measurements = virtualizer.measurementsCache

  const measureRoot = useCallback(
    (root: HTMLDivElement | null) => {
      const scroller = getScrollElement()
      if (root === null || scroller === null) return
      const measure = () =>
        setScrollMargin(
          root.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop,
        )
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(root)
      return () => observer.disconnect()
    },
    [getScrollElement],
  )

  const renderRow = (item: VirtualItem, origin: number) => {
    const row = rows[item.index]
    if (row === undefined) return null
    return (
      <VirtualRow
        key={row.key}
        row={row}
        item={item}
        origin={origin}
        measure={virtualizer.measureElement}
        retain={retain}
      />
    )
  }

  return (
    <div
      className="relative shrink-0"
      ref={measureRoot}
      style={{ height: virtualizer.getTotalSize() }}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>('[data-sidebar-row-key]')
        if (row !== null && event.currentTarget.contains(row))
          setFocused(row.dataset['sidebarRowKey'] ?? null)
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setFocused(null)
      }}
    >
      {[...sections.values()].map(({ section, first: firstIndex, last: lastIndex }) => {
        const first = measurements[firstIndex]
        const last = measurements[lastIndex]
        if (first === undefined || last === undefined) return null
        const items = visible.filter((item) => rows[item.index]?.section.key === section.key)
        const groups: { group: SidebarVirtualRow['group']; items: VirtualItem[] }[] = []
        for (const item of items) {
          const group = rows[item.index]?.group
          const previous = groups.at(-1)
          if (previous !== undefined && previous.group?.key === group?.key)
            previous.items.push(item)
          else groups.push({ group, items: [item] })
        }
        return (
          <VirtualSection
            key={section.key}
            section={section}
            top={first.start - scrollMargin}
            height={last.end - first.start + 1}
            canDrop={canDrop}
          >
            {groups.flatMap(({ group, items: groupItems }) => {
              const children = groupItems.map((item) => renderRow(item, first.start))
              return group === undefined ? (
                children
              ) : (
                <div key={group.key} role="group" aria-label={group.label}>
                  {children}
                </div>
              )
            })}
          </VirtualSection>
        )
      })}
    </div>
  )
}

function VirtualRow({
  row,
  item,
  origin,
  measure,
  retain,
}: {
  row: SidebarVirtualRow
  item: VirtualItem
  origin: number
  measure: (element: HTMLDivElement | null) => void
  retain: (key: string, active: boolean) => void
}) {
  const onInteraction = useCallback((active: boolean) => retain(row.key, active), [retain, row.key])
  return (
    <div
      className={row.sticky ? 'layer-local-1 sticky top-0' : 'absolute inset-x-0'}
      data-index={item.index}
      data-sidebar-row-key={row.key}
      ref={measure}
      style={row.sticky ? undefined : { top: item.start - origin }}
    >
      {row.render(onInteraction)}
    </div>
  )
}

function VirtualSection({
  section,
  top,
  height,
  canDrop,
  children,
}: {
  section: SidebarSection
  top: number
  height: number
  canDrop: boolean
  children: ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: section.dropId ?? section.key,
    disabled: section.dropId === undefined || !canDrop,
  })
  return (
    <section
      aria-label={section.label}
      className={cn('absolute inset-x-0 rounded-sm', isOver && 'bg-surface-container-high')}
      ref={setNodeRef}
      style={{ top, height }}
    >
      {children}
    </section>
  )
}

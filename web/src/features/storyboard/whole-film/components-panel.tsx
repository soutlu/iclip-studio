import { useRef, useState, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { DRAG_THRESHOLD, releasePointer, useClickAfterDrag } from '../editing/timeline-drag'
import {
  ALL_CATEGORIES,
  CATEGORY_ICON,
  matchesFilter,
  PLACEMENT_LABEL,
  SHOW_ALL,
  sortedItems,
  thumbnailOf,
  type CatalogItem,
  type ComponentCatalog,
  type ComponentFilter,
} from './component-catalog'
import type { WholeFilmDraft } from './editing/draft'
import { endCard } from './editing/timeline'

type ComponentsPanelProps = {
  catalog: ComponentCatalog
  draft: WholeFilmDraft
  filter: ComponentFilter
  onFilter: (filter: ComponentFilter) => void
  /** 点卡片：按组件自己的位置放进成片 */
  onUse: (item: CatalogItem) => void
  /** 拖到成片区某处松手 */
  onDrop: (item: CatalogItem, clientX: number, clientY: number) => void
}

/** 这个组件在成片里正用作什么（片头、片尾、字幕样式）；包装与转场可以放多个，不标 */
const usesOf = (item: CatalogItem, draft: WholeFilmDraft): string[] => [
  ...(endCard(draft, 'intro')?.component === item.name ? ['片头'] : []),
  ...(endCard(draft, 'outro')?.component === item.name ? ['片尾'] : []),
  ...(draft.captions.component === item.name ? ['字幕'] : []),
]

/** 组件栏：分类同 Studio，点卡片放进成片，或拖到成片区的轨上 */
export function ComponentsPanel({
  catalog,
  draft,
  filter,
  onFilter,
  onUse,
  onDrop,
}: ComponentsPanelProps) {
  const items = sortedItems(catalog)
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  const categories = catalog.categories.filter((item) => counts.has(item.id))
  const shown = items.filter((item) => matchesFilter(item, filter))
  return (
    <div className="wf-components">
      <ChipGroup
        aria-label="组件分类"
        className="wf-chips"
        onValueChange={(value) => {
          if (value !== '') onFilter({ kind: 'category', id: value })
        }}
        type="single"
        value={filter.kind === 'category' ? filter.id : ''}
      >
        <FilterChip className="wf-chip" value={ALL_CATEGORIES}>
          全部<span>{items.length}</span>
        </FilterChip>
        {categories.map((item) => (
          <FilterChip className="wf-chip" key={item.id} value={item.id}>
            {item.label}
            <span>{counts.get(item.id)}</span>
          </FilterChip>
        ))}
      </ChipGroup>
      {filter.kind === 'placement' ? (
        <p className="wf-component-filter">
          <span>
            只看{PLACEMENT_LABEL[filter.placement]}组件 · {shown.length} 个
          </span>
          <button className="ui-state ui-focus" onClick={() => onFilter(SHOW_ALL)} type="button">
            看全部
          </button>
        </p>
      ) : null}
      <ul aria-label="组件" className="wf-component-list">
        {shown.map((item) => (
          <li key={item.name}>
            <ComponentCard
              item={item}
              onDrop={(clientX, clientY) => onDrop(item, clientX, clientY)}
              onUse={() => onUse(item)}
              uses={usesOf(item, draft)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

type CardProps = {
  item: CatalogItem
  uses: string[]
  onUse: () => void
  onDrop: (clientX: number, clientY: number) => void
}

type Press = { pointerId: number; originX: number; originY: number; moved: boolean }

function ComponentCard({ item, uses, onUse, onDrop }: CardProps) {
  const pressRef = useRef<Press | null>(null)
  const [lifting, setLifting] = useState(false)
  const clicks = useClickAfterDrag()
  const thumbnail = thumbnailOf(item)

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    clicks.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    pressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    }
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId || current.moved) return
    const distance = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
    if (distance <= DRAG_THRESHOLD) return
    current.moved = true
    setLifting(true)
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    pressRef.current = null
    setLifting(false)
    if (!current.moved) return
    clicks.swallow()
    onDrop(event.clientX, event.clientY)
  }

  return (
    <button
      aria-label={`${item.title}，${PLACEMENT_LABEL[item.placement]}：${item.description}`}
      aria-pressed={uses.length > 0}
      className={cn('wf-component ui-state ui-focus', lifting && 'is-lifting')}
      onClick={() => {
        if (!clicks.take()) onUse()
      }}
      onPointerCancel={() => {
        pressRef.current = null
        setLifting(false)
      }}
      onPointerDown={press}
      onPointerMove={move}
      onPointerUp={release}
      type="button"
    >
      <span className="wf-component-thumb">
        {thumbnail === undefined ? (
          <Icon decorative name={CATEGORY_ICON[item.category] ?? 'grid'} size="md" />
        ) : (
          <img alt="" draggable={false} loading="lazy" src={thumbnail} />
        )}
      </span>
      <span className="wf-component-text">
        <span className="wf-component-name">
          <b>{item.title}</b>
          <span className="wf-component-place">
            {uses.length > 0 ? `${uses.join('、')}在用` : PLACEMENT_LABEL[item.placement]}
          </span>
        </span>
        <span className="wf-component-desc">{item.description}</span>
      </span>
    </button>
  )
}

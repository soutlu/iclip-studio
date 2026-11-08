import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { DRAG_THRESHOLD, releasePointer, useClickAfterDrag } from '../editing/timeline-drag'
import {
  CATEGORY_ICON,
  defaultLaneLabel,
  thumbnailOf,
  type CatalogItem,
  type ComponentCatalog,
  type ComponentGroup,
} from './component-catalog'
import { ComponentHoverPreview } from './component-hover-preview'
import { hoverPreviewOf } from './hover-preview'

export const HOVER_PREVIEW_DELAY_MS = 300

type ComponentsPanelProps = {
  catalog: ComponentCatalog
  origin: string
  groups: ComponentGroup[]
  groupsLabel: string
  selected: string | undefined
  onSelect: (id: string) => void
  emptyText: string
  onUse: (item: CatalogItem) => void
  onCarry: (item: CatalogItem, carry: CardCarry | null) => void
  onDrop: (item: CatalogItem, carry: CardCarry) => void
}

export type CardCarry = {
  clientX: number
  clientY: number
  origin: { left: number; top: number; width: number; height: number }
}

export function ComponentsPanel({
  catalog,
  origin,
  groups,
  groupsLabel,
  selected,
  onSelect,
  emptyText,
  onUse,
  onCarry,
  onDrop,
}: ComponentsPanelProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimerRef.current), [])
  const hoverStart = (name: string) => {
    clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setHovered(name), HOVER_PREVIEW_DELAY_MS)
  }
  const hoverEnd = () => {
    clearTimeout(hoverTimerRef.current)
    setHovered(null)
  }

  const group = groups.find((item) => item.id === selected) ?? groups[0]
  if (group === undefined) return <p className="wf-components-empty">{emptyText}</p>
  const hoveredItem = group.items.find((item) => item.name === hovered)
  const hoverPreview =
    hoveredItem === undefined ? undefined : hoverPreviewOf(hoveredItem, catalog, origin)
  return (
    <div className="wf-components">
      <ChipGroup
        aria-label={groupsLabel}
        className="wf-chips"
        onValueChange={(value) => {
          if (value !== '') onSelect(value)
        }}
        type="single"
        value={group.id}
      >
        {groups.map((item) => (
          <FilterChip className="wf-chip" key={item.id} value={item.id}>
            {item.label}
            <span>{item.items.length}</span>
          </FilterChip>
        ))}
      </ChipGroup>
      <ul aria-label="组件" className="wf-component-grid">
        {group.items.map((item) => (
          <li key={item.name}>
            <ComponentCard
              catalog={catalog}
              item={item}
              onCarry={(carry) => onCarry(item, carry)}
              onDrop={(carry) => onDrop(item, carry)}
              onHoverEnd={hoverEnd}
              onHoverStart={() => hoverStart(item.name)}
              onUse={() => onUse(item)}
              preview={
                item.name === hovered && hoverPreview?.kind === 'ready'
                  ? hoverPreview.html
                  : undefined
              }
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ComponentThumb({
  catalog,
  item,
  className,
  iconSize = 'md',
}: {
  catalog: ComponentCatalog
  item: CatalogItem
  className?: string
  iconSize?: 'xs' | 'md'
}) {
  const thumbnail = thumbnailOf(catalog, item)
  return (
    <span className={cn('wf-component-thumb', className)}>
      {thumbnail === undefined ? (
        <Icon decorative name={CATEGORY_ICON[item.category] ?? 'grid'} size={iconSize} />
      ) : (
        <img alt="" draggable={false} loading="lazy" src={thumbnail} />
      )}
    </span>
  )
}

type CardProps = {
  catalog: ComponentCatalog
  item: CatalogItem
  preview: string | undefined
  onUse: () => void
  onCarry: (carry: CardCarry | null) => void
  onDrop: (carry: CardCarry) => void
  onHoverStart: () => void
  onHoverEnd: () => void
}

type Press = {
  pointerId: number
  originX: number
  originY: number
  origin: CardCarry['origin']
  moved: boolean
}

function ComponentCard({
  catalog,
  item,
  preview,
  onUse,
  onCarry,
  onDrop,
  onHoverStart,
  onHoverEnd,
}: CardProps) {
  const pressRef = useRef<Press | null>(null)
  const [lifting, setLifting] = useState(false)
  const [tip, setTip] = useState(false)
  const clicks = useClickAfterDrag()

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    clicks.reset()
    event.currentTarget.setPointerCapture(event.pointerId)
    const box = event.currentTarget.getBoundingClientRect()
    pressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      origin: { left: box.left, top: box.top, width: box.width, height: box.height },
      moved: false,
    }
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      const distance = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
      if (distance <= DRAG_THRESHOLD) return
      current.moved = true
      setLifting(true)
      onHoverEnd()
    }
    onCarry({ clientX: event.clientX, clientY: event.clientY, origin: current.origin })
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    pressRef.current = null
    setLifting(false)
    if (!current.moved) return
    clicks.swallow()
    onDrop({ clientX: event.clientX, clientY: event.clientY, origin: current.origin })
  }
  const cancel = () => {
    if (pressRef.current?.moved === true) {
      clicks.swallow()
      onCarry(null)
    }
    pressRef.current = null
    setLifting(false)
  }
  useEscapeAheadOfDialog(lifting, cancel)

  return (
    <TooltipRoot onOpenChange={setTip} open={tip && !lifting}>
      <TooltipTrigger asChild>
        <button
          aria-label={`${item.title}，${defaultLaneLabel(item)}：${item.description}`}
          className={cn('wf-component ui-focus', lifting && 'is-lifting')}
          onClick={() => {
            if (!clicks.take()) onUse()
          }}
          onPointerCancel={cancel}
          onPointerDown={press}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') onHoverStart()
          }}
          onPointerLeave={onHoverEnd}
          onPointerMove={move}
          onPointerUp={release}
          type="button"
        >
          <span className="wf-component-frame">
            <ComponentThumb catalog={catalog} item={item} />
            {preview === undefined ? null : <ComponentHoverPreview srcdoc={preview} />}
          </span>
          <span className="wf-component-name">{item.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{item.description}</TooltipContent>
    </TooltipRoot>
  )
}

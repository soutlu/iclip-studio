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

/** 鼠标在卡片上停这么久才开始加载悬停预览，划过去的不加载 */
export const HOVER_PREVIEW_DELAY_MS = 300

type ComponentsPanelProps = {
  /** 组件目录与站点地址：悬停预览按它们生成合成页 */
  catalog: ComponentCatalog
  origin: string
  /** 这一栏的小标题（品牌或分类）和各自的卡片 */
  groups: ComponentGroup[]
  /** 小标题这一排叫什么，如「品牌」「分类」 */
  groupsLabel: string
  /** 选中的小标题；不在 groups 里时取第一个 */
  selected: string | undefined
  onSelect: (id: string) => void
  /** 这一栏没有卡片时的说明 */
  emptyText: string
  /** 点卡片：按组件的默认去处放进成片 */
  onUse: (item: CatalogItem) => void
  /** 拿着卡片移动；null 是拖动中途作废 */
  onCarry: (item: CatalogItem, carry: CardCarry | null) => void
  /** 拿着卡片在某处松手 */
  onDrop: (item: CatalogItem, carry: CardCarry) => void
}

/** 拖着的卡片：指针位置，以及拿起时卡片的位置与大小（没放下时缩影退回这里） */
export type CardCarry = {
  clientX: number
  clientY: number
  origin: { left: number; top: number; width: number; height: number }
}

/**
 * 品牌栏、通用栏：一排小标题加卡片网格；点卡片放进成片，或拖到时间线的轨上。
 * 鼠标停在卡片上时在卡片里播放组件动画，同一时间只播一张。
 */
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
  // 正在播悬停预览的卡片（组件名）
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

/** 组件的预览图；目录里没有缩略图的用分类图标 */
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
  /** 悬停预览的合成页；不在播时为 undefined */
  preview: string | undefined
  onUse: () => void
  onCarry: (carry: CardCarry | null) => void
  onDrop: (carry: CardCarry) => void
  /** 鼠标进到卡片上 */
  onHoverStart: () => void
  /** 鼠标离开、或拿起卡片开始拖：立即停掉悬停预览 */
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
      // 按下后指针被卡片捕获，拖走时不会先收到离开，这里停掉预览
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
    // 拖着卡片时收起说明，免得它挡在侧栏上跟着不走
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

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { thumbnailUrl } from './component-catalog'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { hoverPreviewOf } from './hover-preview'
import { ItemHoverPreview } from './item-hover-preview'
import {
  categoryLabel,
  filterItems,
  ITEM_KIND_LABEL,
  itemChips,
  type ItemFilter,
  type ItemKind,
} from './items'

/** 照参照的工作台：指针停够这么久才在卡片里播预览，划过时不播。 */
export const HOVER_PREVIEW_DELAY_MS = 300

export type CarryPoint = { clientX: number; clientY: number }

type ItemsTabProps = {
  /** 列哪一种条目。 */
  kind: ItemKind
  catalog: ComponentCatalog
  /** 搜索词和选中的分类，由外面记着：页签切走时这里会卸掉，切回来还要在。 */
  filter: ItemFilter
  onFilterChange: (filter: ItemFilter) => void
  /** 页面的源，悬停预览按它找组件库的文件。 */
  origin: string
  /** 点「加到播放头」。 */
  onAdd: (item: CatalogItem) => void
  /** 拖着卡片移动；null 是拖动取消了。 */
  onCarry: (item: CatalogItem, point: CarryPoint | null) => void
  /** 拖着卡片松手。 */
  onDrop: (item: CatalogItem, point: CarryPoint) => void
}

export function ItemsTab({
  kind,
  catalog,
  filter,
  onFilterChange,
  origin,
  onAdd,
  onCarry,
  onDrop,
}: ItemsTabProps) {
  const label = ITEM_KIND_LABEL[kind]
  const chips = itemChips(catalog, kind)
  const chip = chips.find((candidate) => candidate.value === filter.chip) ?? chips[0]
  const items = chip === undefined ? [] : filterItems(catalog, chip, filter.query)

  // 预览只在停着的那一张卡上跑
  const [previewed, setPreviewed] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimerRef.current), [])
  const hoverStart = (name: string) => {
    clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(() => setPreviewed(name), HOVER_PREVIEW_DELAY_MS)
  }
  const hoverEnd = () => {
    clearTimeout(hoverTimerRef.current)
    setPreviewed(null)
  }

  return (
    <div className="wf-items">
      <Input
        aria-label={`搜索${label}`}
        leadingIcon="search"
        onChange={(event) => onFilterChange({ ...filter, query: event.currentTarget.value })}
        placeholder="搜索名称或分类"
        type="search"
        value={filter.query}
        wrapperClassName="wf-item-search"
      />
      <ChipGroup
        aria-label={`${label}分类`}
        className="wf-chips"
        onValueChange={(value) => {
          if (value !== '') onFilterChange({ ...filter, chip: value })
        }}
        type="single"
        value={chip?.value ?? ''}
      >
        {chips.map((item) => (
          <FilterChip className="wf-chip" key={item.value} value={item.value}>
            {item.label}
          </FilterChip>
        ))}
      </ChipGroup>
      {items.length === 0 ? (
        <p className="wf-items-empty" role="status">
          暂无符合条件的{label}，请更换关键词或分类
        </p>
      ) : (
        <ul aria-label={label} className="wf-item-grid">
          {items.map((item) => (
            <li key={item.name}>
              <ItemCard
                catalog={catalog}
                item={item}
                onAdd={() => onAdd(item)}
                onCarry={(point) => onCarry(item, point)}
                onDrop={(point) => onDrop(item, point)}
                onHoverEnd={hoverEnd}
                onHoverStart={() => hoverStart(item.name)}
                preview={
                  item.name === previewed ? hoverPreviewOf(item, catalog, origin) : undefined
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type CardProps = {
  catalog: ComponentCatalog
  item: CatalogItem
  preview: string | undefined
  onAdd: () => void
  onCarry: (point: CarryPoint | null) => void
  onDrop: (point: CarryPoint) => void
  onHoverStart: () => void
  onHoverEnd: () => void
}

type Press = { pointerId: number; originX: number; originY: number; moved: boolean }

const durationText = (seconds: number) => `${seconds}s`

function ItemCard({
  catalog,
  item,
  preview,
  onAdd,
  onCarry,
  onDrop,
  onHoverStart,
  onHoverEnd,
}: CardProps) {
  const pressRef = useRef<Press | null>(null)
  const [lifting, setLifting] = useState(false)
  const thumbnail = thumbnailUrl(catalog, item.name)

  const press = (event: PointerEvent<HTMLDivElement>) => {
    // 按在「加到播放头」上不起拖：抓住指针以后按钮收不到点击
    if (event.button !== 0 || (event.target as Element).closest('button') !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      const distance = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
      if (distance <= DRAG_THRESHOLD) return
      current.moved = true
      setLifting(true)
      onHoverEnd()
    }
    onCarry({ clientX: event.clientX, clientY: event.clientY })
  }
  const release = (event: PointerEvent<HTMLDivElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    pressRef.current = null
    setLifting(false)
    if (current.moved) onDrop({ clientX: event.clientX, clientY: event.clientY })
  }
  const cancel = () => {
    if (pressRef.current?.moved === true) onCarry(null)
    pressRef.current = null
    setLifting(false)
  }
  useEscapeAheadOfDialog(lifting, cancel)

  return (
    <div
      aria-label={
        item.duration === null ? item.title : `${item.title}，${String(item.duration)} 秒`
      }
      className={cn('wf-item', lifting && 'is-lifting')}
      onPointerCancel={cancel}
      onPointerDown={press}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') onHoverStart()
      }}
      onPointerLeave={onHoverEnd}
      onPointerMove={move}
      onPointerUp={release}
      role="group"
    >
      <span className="wf-item-frame">
        <span className="wf-item-thumb">
          {thumbnail === null ? (
            <Icon decorative name="grid" size="md" />
          ) : (
            <img alt="" draggable={false} loading="lazy" src={thumbnail} />
          )}
        </span>
        {preview === undefined ? null : <ItemHoverPreview srcdoc={preview} />}
        {item.duration === null ? null : (
          <span aria-hidden="true" className="wf-item-duration">
            {durationText(item.duration)}
          </span>
        )}
        {/* 和别处悬停才出的操作一样：指针停在卡片上、焦点在按钮上或触屏时显示 */}
        <button className="wf-item-add ui-focus" onClick={onAdd} type="button">
          <Icon decorative name="add" size="xs" />
          加到播放头
        </button>
      </span>
      <span className="wf-item-name">{item.title}</span>
      <span className="wf-item-meta">{categoryLabel(catalog, item)}</span>
    </div>
  )
}

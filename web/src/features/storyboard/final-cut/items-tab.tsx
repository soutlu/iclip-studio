import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { IconButton } from '@/shared/ui/button'
import { Input } from '@/shared/ui/field'
import { DRAG_THRESHOLD, releasePointer, useClickAfterDrag } from '../editing/timeline-drag'
import { thumbnailUrl } from './component-catalog'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { useEditorEscape } from './editor-keys'
import { EmptyNote } from './empty-note'
import { hoverPreviewOf } from './hover-preview'
import { ItemHoverPreview } from './item-hover-preview'
import { previewRuntimeSrc } from './preview-document'
import {
  filterItems,
  ITEM_KIND_LABEL,
  itemBrands,
  itemChips,
  type ItemFilter,
  type ItemKind,
} from './items'
import { SelectChip } from './select-chip'

/** 照参照的工作台：指针停够这么久才在卡片里播预览，划过时不播。 */
export const HOVER_PREVIEW_DELAY_MS = 300

export type CarryPoint = { clientX: number; clientY: number }

/** 两种条目页签的图标，和侧栏导航上的一样。 */
const KIND_ICON: Record<ItemKind, IconName> = {
  component: 'final-cut-overlays',
  block: 'final-cut-scenes',
}

type ItemsTabProps = {
  /** 列哪一种条目。 */
  kind: ItemKind
  catalog: ComponentCatalog
  /** 搜索词和选中的分类，由外面记着：页签切走时这里会卸掉，切回来还要在。 */
  filter: ItemFilter
  onFilterChange: (filter: ItemFilter) => void
  /** 页面的源，悬停预览按它找组件库的文件。 */
  origin: string
  /** 点卡片或卡片上的「+」、焦点在卡片上按 Enter：加到播放头。 */
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
  const brands = itemBrands(catalog, kind)
  // 记着的品牌目录里已经没有了时当作没选
  const brand = filter.brand !== null && brands.includes(filter.brand) ? filter.brand : null
  const items = chip === undefined ? [] : filterItems(catalog, chip, filter.query, brand)
  const runtimeSrc = previewRuntimeSrc(catalog, origin)

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
      <div className="wf-tab-head">
        <Input
          aria-label={`搜索${label}`}
          leadingIcon="final-cut-search"
          onChange={(event) => onFilterChange({ ...filter, query: event.currentTarget.value })}
          placeholder="搜索"
          type="search"
          value={filter.query}
          wrapperClassName="wf-field wf-search"
        />
        <div className="wf-item-filters">
          <ChipGroup
            aria-label={`${label}分类`}
            className="wf-filters"
            onValueChange={(value) => {
              if (value !== '') onFilterChange({ ...filter, chip: value })
            }}
            type="single"
            value={chip?.value ?? ''}
          >
            {chips.map((item) => (
              <FilterChip className="wf-filter" key={item.value} value={item.value}>
                {item.label}
              </FilterChip>
            ))}
          </ChipGroup>
          {brands.length === 0 ? null : (
            <SelectChip
              className="wf-item-brand"
              columns={2}
              noun="品牌"
              onChange={(picked) => onFilterChange({ ...filter, brand: picked ?? null })}
              options={brands.map((each) => ({ id: each, label: each }))}
              value={brand ?? undefined}
            />
          )}
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyNote icon={KIND_ICON[kind]}>暂无符合条件的{label}，请更换关键词或分类</EmptyNote>
      ) : (
        <ul aria-label={label} className="wf-tab-list wf-item-grid">
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
                runtimeSrc={runtimeSrc}
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
  runtimeSrc: string
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
  runtimeSrc,
  onAdd,
  onCarry,
  onDrop,
  onHoverStart,
  onHoverEnd,
}: CardProps) {
  const pressRef = useRef<Press | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [lifting, setLifting] = useState(false)
  const thumbnail = thumbnailUrl(catalog, item.name)
  const name = item.duration === null ? item.title : `${item.title}，${String(item.duration)} 秒`

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    clickAfterDrag.reset()
    pressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
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
    onCarry({ clientX: event.clientX, clientY: event.clientY })
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    pressRef.current = null
    setLifting(false)
    if (!current.moved) return
    // 松手后浏览器还会补一次点击，不能当成点了卡片再加一个
    clickAfterDrag.swallow()
    onDrop({ clientX: event.clientX, clientY: event.clientY })
  }
  const cancel = () => {
    if (pressRef.current?.moved === true) {
      clickAfterDrag.swallow()
      onCarry(null)
    }
    pressRef.current = null
    setLifting(false)
  }
  useEditorEscape(lifting, cancel)

  return (
    <div
      aria-label={name}
      className={cn('wf-item wf-reveal-host', lifting && 'is-lifting')}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') onHoverStart()
      }}
      onPointerLeave={onHoverEnd}
      role="group"
    >
      {/* 整张卡是一个按钮：点、按 Enter 加到播放头，按住拖到时间线；「+」叠在它上面 */}
      <button
        aria-keyshortcuts="Enter"
        aria-label={name}
        className="wf-item-select"
        onClick={() => {
          if (!clickAfterDrag.take()) onAdd()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onAdd()
        }}
        onPointerCancel={cancel}
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={release}
        type="button"
      />
      {/* 封面上不压字：时长写在下面名字的右边 */}
      <span className="wf-item-thumb">
        {thumbnail === null ? (
          <Icon decorative name="grid" size="md" />
        ) : (
          <img alt="" draggable={false} loading="lazy" src={thumbnail} />
        )}
        {preview === undefined ? null : (
          <ItemHoverPreview runtimeSrc={runtimeSrc} srcdoc={preview} />
        )}
        {/* 整张卡已能用 Enter 加入，「+」不再占一个 Tab 停靠点 */}
        <IconButton
          className="wf-item-add wf-reveal"
          label="加到播放头"
          name="final-cut-add"
          onClick={onAdd}
          size="xs"
          tabIndex={-1}
        />
      </span>
      <span className="wf-item-meta">
        <span className="wf-item-name">{item.title}</span>
        {item.duration === null ? null : (
          <span aria-hidden="true" className="wf-item-duration">
            {durationText(item.duration)}
          </span>
        )}
      </span>
    </div>
  )
}

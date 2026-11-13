import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/field'
import { DRAG_THRESHOLD, releasePointer } from '../editing/timeline-drag'
import { thumbnailUrl } from './component-catalog'
import { ComponentHoverPreview } from './component-hover-preview'
import { categoryLabel, componentChips, filterComponents } from './components'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { hoverPreviewOf } from './hover-preview'

/** 照参照的工作台：指针停够这么久才在卡片里播预览，划过时不播。 */
export const HOVER_PREVIEW_DELAY_MS = 300

export type CarryPoint = { clientX: number; clientY: number }

type ComponentsTabProps = {
  catalog: ComponentCatalog
  /** 页面的源，悬停预览按它找组件库的文件。 */
  origin: string
  /** 点「加到播放头」。 */
  onAdd: (item: CatalogItem) => void
  /** 拖着卡片移动；null 是拖动取消了。 */
  onCarry: (item: CatalogItem, point: CarryPoint | null) => void
  /** 拖着卡片松手。 */
  onDrop: (item: CatalogItem, point: CarryPoint) => void
}

export function ComponentsTab({ catalog, origin, onAdd, onCarry, onDrop }: ComponentsTabProps) {
  const chips = componentChips(catalog)
  const [chipValue, setChipValue] = useState('all')
  const [query, setQuery] = useState('')
  const chip = chips.find((candidate) => candidate.value === chipValue) ?? chips[0]
  const items = chip === undefined ? [] : filterComponents(catalog, chip, query)

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
    <div className="wf-components">
      <Input
        aria-label="搜索组件"
        leadingIcon="search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索名字、分类或标签"
        type="search"
        value={query}
        wrapperClassName="wf-component-search"
      />
      <ChipGroup
        aria-label="组件分类"
        className="wf-chips"
        onValueChange={(value) => {
          if (value !== '') setChipValue(value)
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
        <p className="wf-components-empty" role="status">
          暂无符合条件的组件，请换个关键词或分类
        </p>
      ) : (
        <ul aria-label="组件" className="wf-component-grid">
          {items.map((item) => (
            <li key={item.name}>
              <ComponentCard
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

function ComponentCard({
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
      className={cn('wf-component', lifting && 'is-lifting')}
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
      <span className="wf-component-frame">
        <span className="wf-component-thumb">
          {thumbnail === null ? (
            <Icon decorative name="grid" size="md" />
          ) : (
            <img alt="" draggable={false} loading="lazy" src={thumbnail} />
          )}
        </span>
        {preview === undefined ? null : <ComponentHoverPreview srcdoc={preview} />}
        {item.duration === null ? null : (
          <span aria-hidden="true" className="wf-component-duration">
            {durationText(item.duration)}
          </span>
        )}
        {/* 和别处悬停才出的操作一样：指针停在卡片上、焦点在按钮上或触屏时显示 */}
        <button className="wf-component-add ui-focus" onClick={onAdd} type="button">
          <Icon decorative name="add" size="xs" />
          加到播放头
        </button>
      </span>
      <span className="wf-component-name">{item.title}</span>
      <span className="wf-component-meta">{categoryLabel(catalog, item)}</span>
    </div>
  )
}

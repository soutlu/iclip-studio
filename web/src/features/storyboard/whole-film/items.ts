import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import type { FilmClip } from './composition/film'
import { rowBusy, rowsOf, type RowTarget } from './placement'

export type ItemKind = CatalogItem['kind']

/** 左侧栏里条目页签的先后。 */
export const ITEM_KINDS: readonly ItemKind[] = ['component', 'block']

/** 两种条目在界面上的叫法。 */
export const ITEM_KIND_LABEL: Record<ItemKind, string> = { component: '组件', block: '块' }

/** 条目页签的一个分类：「全部」「品牌」，或者组件库目录里的一类。 */
export type ItemChip = {
  value: string
  label: string
  includes: (item: CatalogItem) => boolean
}

/** 条目页签上的搜索词和选中的分类（`ItemChip.value`）。 */
export type ItemFilter = { query: string; chip: string }

export const NO_FILTER: ItemFilter = { query: '', chip: 'all' }

// 组装脚本把这一类的条目标成字幕；字幕在后面的步骤里另做，条目页签不列
const CAPTIONS = 'captions'

/**
 * `kind` 这种条目的页签上的分类，按显示的先后：全部、品牌、目录里除字幕以外的各类。
 * 「全部」总在；别的分类在这种条目里一个都没有时不列。
 */
export const itemChips = (catalog: ComponentCatalog, kind: ItemKind): ItemChip[] => {
  const listed = (item: CatalogItem) => item.kind === kind && item.category !== CAPTIONS
  const chips: ItemChip[] = [
    { value: 'all', label: '全部', includes: listed },
    { value: 'brand', label: '品牌', includes: (item) => listed(item) && item.brand !== undefined },
    ...catalog.categories.map((category) => ({
      value: `category:${category.id}`,
      label: category.label,
      includes: (item: CatalogItem) => listed(item) && item.category === category.id,
    })),
  ]
  return chips.filter((chip) => chip.value === 'all' || catalog.items.some(chip.includes))
}

export const categoryLabel = (catalog: ComponentCatalog, item: CatalogItem): string =>
  catalog.categories.find((category) => category.id === item.category)?.label ?? ''

/** 分类里名字、说明或分类名含有 `query`（不分大小写，去掉两头空白）的条目，按目录里的先后。 */
export const filterItems = (
  catalog: ComponentCatalog,
  chip: ItemChip,
  query: string,
): CatalogItem[] => {
  const keyword = query.trim().toLowerCase()
  return catalog.items.filter(
    (item) =>
      chip.includes(item) &&
      [item.title, item.description, categoryLabel(catalog, item)].some((text) =>
        text.toLowerCase().includes(keyword),
      ),
  )
}

// 和参照的工作台一样：条目没写时长时取 10 秒和成片现有总长里大的那个
const DEFAULT_ITEM_MS = 10_000

/** 条目放进成片时的时长（毫秒）；`clips` 是成片里现有的片段。 */
export const itemDurationMs = (item: CatalogItem, clips: readonly FilmClip[]): number =>
  item.duration === null
    ? Math.max(DEFAULT_ITEM_MS, ...clips.map((clip) => clip.start + clip.duration))
    : Math.round(item.duration * 1000)

/**
 * 点「加到播放头」时组件或块的片段放在哪：从 `startMs` 起、长 `durationMs`。
 * 照参照的工作台：`block` 类的条目放画面区第一行，`component` 类的放画面区最下面新开的一行；
 * 第一行在这段时间已经有片段时，在它下面紧挨着新开一行。
 */
export const playheadSpot = (
  clips: readonly FilmClip[],
  item: CatalogItem,
  startMs: number,
  durationMs: number,
): { row: RowTarget; start: number } => {
  const visual = rowsOf(clips).filter((row) => row.zone === 'visual')
  const [top] = visual
  if (item.kind === 'component' || top === undefined)
    return { row: { zone: 'visual', insertAt: visual.length }, start: startMs }
  return {
    row: rowBusy(top, startMs, durationMs)
      ? { zone: 'visual', insertAt: 1 }
      : { zone: 'visual', track: top.track },
    start: startMs,
  }
}

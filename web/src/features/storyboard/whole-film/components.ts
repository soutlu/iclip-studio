import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import type { FilmBlock } from './composition/film'
import { rowBusy, rowsOf, type RowTarget } from './placement'

/** 组件栏的一个分类：「全部」「品牌」，或者组件库目录里的一类。 */
export type ComponentChip = {
  value: string
  label: string
  includes: (item: CatalogItem) => boolean
}

// 组装脚本把这一类的条目标成字幕；字幕在后面的步骤里另做，组件栏不列
const CAPTIONS = 'captions'

const listed = (item: CatalogItem) => item.category !== CAPTIONS

/** 组件栏上的分类，按显示的先后：全部、品牌、目录里除字幕以外的各类。 */
export const componentChips = (catalog: ComponentCatalog): ComponentChip[] => [
  { value: 'all', label: '全部', includes: listed },
  { value: 'brand', label: '品牌', includes: (item) => listed(item) && item.brand !== undefined },
  ...catalog.categories
    .filter((category) => category.id !== CAPTIONS)
    .map((category) => ({
      value: `category:${category.id}`,
      label: category.label,
      includes: (item: CatalogItem) => item.category === category.id,
    })),
]

export const categoryLabel = (catalog: ComponentCatalog, item: CatalogItem): string =>
  catalog.categories.find((category) => category.id === item.category)?.label ?? ''

/** 分类里名字、说明或分类名含有 `query`（不分大小写，去掉两头空白）的条目，按目录里的先后。 */
export const filterComponents = (
  catalog: ComponentCatalog,
  chip: ComponentChip,
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
const DEFAULT_COMPONENT_MS = 10_000

/** 条目放进成片时的时长（毫秒）；`blocks` 是成片里现有的块。 */
export const componentDurationMs = (item: CatalogItem, blocks: readonly FilmBlock[]): number =>
  item.duration === null
    ? Math.max(DEFAULT_COMPONENT_MS, ...blocks.map((block) => block.start + block.duration))
    : Math.round(item.duration * 1000)

/**
 * 点「加到播放头」时组件块放在哪：从 `startMs` 起、长 `durationMs`。
 * 照参照的工作台：`block` 类的条目放画面区第一行，`component` 类的放画面区最下面新开的一行；
 * 第一行在这段时间已经有块时，在它下面紧挨着新开一行。
 */
export const playheadSpot = (
  blocks: readonly FilmBlock[],
  item: CatalogItem,
  startMs: number,
  durationMs: number,
): { row: RowTarget; start: number } => {
  const visual = rowsOf(blocks).filter((row) => row.zone === 'visual')
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

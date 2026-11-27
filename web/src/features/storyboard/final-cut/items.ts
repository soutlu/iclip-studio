import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { itemNamed, type FilmClip, type HostClip } from './composition/film'
import { rowBusy, rowsOf, type RowTarget } from './placement'

export type ItemKind = CatalogItem['kind']

/** 侧栏里条目页签的先后。 */
export const ITEM_KINDS: readonly ItemKind[] = ['component', 'block']

/** 两种条目在界面上的叫法。 */
export const ITEM_KIND_LABEL: Record<ItemKind, string> = { component: '元素', block: '模板' }

/** 宿主片段的条目在组件库目录里是哪种；目录里查不到时是 undefined。 */
export const hostKindOf = (clip: HostClip, catalog: ComponentCatalog): ItemKind | undefined =>
  itemNamed(catalog, clip.item)?.kind

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

// 条目未指定默认时长时，取 10 秒与当前工程总时长中的较大值
const DEFAULT_ITEM_MS = 10_000

/** 计算条目加入轨道时的默认时长（毫秒）；`clips` 为当前工程已有片段。 */
export const itemDurationMs = (item: CatalogItem, clips: readonly FilmClip[]): number =>
  item.duration === null
    ? Math.max(DEFAULT_ITEM_MS, ...clips.map((clip) => clip.start + clip.duration))
    : Math.round(item.duration * 1000)

/**
 * 计算组件或区块条目加入播放头时的目标轨道行与起始时间（`startMs` 起、时长 `durationMs`）：
 * `block` 条目优先置于画面区首行（该时段被占用时在其下方紧邻新建一行）；`component` 条目置于画面区底部新建一行。
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

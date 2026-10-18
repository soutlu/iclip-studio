/**
 * 编辑器用到的组件目录：分类、点卡片时的默认去处与放进成片时的默认时长。
 * 目录本身（`catalog/catalog.json`，约 270 KB）打开编辑器时才加载，缩略图只取地址。
 */

import { queryOptions, useQuery } from '@tanstack/react-query'
import type { IconName } from '@/shared/icons'
import type {
  CatalogItem,
  CatalogVariable,
  ComponentCatalog,
  VariableValue,
} from './composition/catalog'
import type { ComponentVariables } from './editing/draft'

export type { CatalogItem, CatalogVariable, ComponentCatalog, VariableValue }

const THUMBNAILS = import.meta.glob<string>('./catalog/thumbnails/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
})

/** 组件的缩略图地址；目录里没有缩略图的组件为 undefined */
export const thumbnailOf = (item: CatalogItem): string | undefined =>
  item.thumbnail === null ? undefined : THUMBNAILS[`./catalog/thumbnails/${item.thumbnail}`]

const catalogQuery = queryOptions({
  queryKey: ['whole-film', 'component-catalog'],
  queryFn: async () => (await import('./catalog/catalog.json')).default as ComponentCatalog,
  staleTime: Infinity,
  gcTime: Infinity,
})

export const useComponentCatalog = () => useQuery(catalogQuery)

/** 点卡片时组件去哪：字幕样式换掉整片的字幕样式，block 插进成片轨，其余放到包装轨 */
export const defaultLaneLabel = (item: CatalogItem): string =>
  item.placement === 'caption' ? '字幕样式' : item.kind === 'block' ? '成片轨' : '包装轨'

export const CATEGORY_ICON: Record<string, IconName> = {
  captions: 'captions',
  vfx: 'sparkles',
  transitions: 'swap-panes',
  effects: 'blend',
  'text-effects': 'type',
  social: 'message',
  scenes: 'film',
}

/** 没有固定时长的组件至少放这么长，同 HyperFrames */
const MIN_UNTIMED_MS = 10_000

/** 组件放进成片的时长：组件自己的时长；没有时同 HyperFrames，取 10 秒与整片时长里长的那个 */
export const durationMsOf = (item: CatalogItem, filmMs: number): number =>
  item.duration === null ? Math.max(MIN_UNTIMED_MS, filmMs) : Math.round(item.duration * 1000)

/** 可填项现在的值：草稿里填过的，没填过取组件的默认值 */
export const variableValue = (
  variable: CatalogVariable,
  values: ComponentVariables,
): VariableValue => values[variable.id] ?? variable.default

/** 组件栏的排序：分类按 Studio 的顺序，同一分类里保持目录的顺序 */
export const sortedItems = (catalog: ComponentCatalog): CatalogItem[] => {
  const rank = (id: string) => catalog.categories.findIndex((category) => category.id === id)
  return catalog.items.toSorted((a, b) => rank(a.category) - rank(b.category))
}

export const ALL_CATEGORIES = 'all'

/** 组件栏按 Studio 的分类筛：分类 id，或 {@link ALL_CATEGORIES} */
export const matchesCategory = (item: CatalogItem, category: string) =>
  category === ALL_CATEGORIES || item.category === category

export const itemOf = (catalog: ComponentCatalog, name: string): CatalogItem | undefined =>
  catalog.items.find((item) => item.name === name)

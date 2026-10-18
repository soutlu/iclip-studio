/**
 * 编辑器用到的组件目录：分类、放置位置、默认时长与转场的接法。
 * 目录本身（`catalog/catalog.json`，约 270 KB）打开编辑器时才加载，缩略图只取地址。
 */

import { queryOptions, useQuery } from '@tanstack/react-query'
import type { IconName } from '@/shared/icons'
import type {
  CatalogItem,
  CatalogVariable,
  ComponentCatalog,
  Placement,
  VariableValue,
} from './composition/catalog'
import type { TransitionSpec } from './editing/context'
import { DEFAULT_END_CARD_MS, type ComponentVariables } from './editing/draft'

export type { CatalogItem, CatalogVariable, ComponentCatalog, Placement, VariableValue }

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

export const PLACEMENT_LABEL: Record<Placement, string> = {
  intro: '片头',
  outro: '片尾',
  transition: '两段之间',
  caption: '字幕样式',
  overlay: '包装轨',
}

export const CATEGORY_ICON: Record<string, IconName> = {
  captions: 'captions',
  vfx: 'sparkles',
  transitions: 'swap-panes',
  effects: 'blend',
  'text-effects': 'type',
  social: 'message',
  scenes: 'film',
}

/** 没有固定时长的包装组件放进成片时的时长 */
export const DEFAULT_OVERLAY_MS = 3_000

/**
 * 组件放进成片的时长：片头片尾一律先放 2 秒（之后拖边缘改）；转场与包装取组件原定的时长，
 * 没有固定时长的包装 3 秒。
 */
export const durationMsOf = (item: CatalogItem): number =>
  item.placement === 'intro' || item.placement === 'outro'
    ? DEFAULT_END_CARD_MS
    : item.duration === null
      ? DEFAULT_OVERLAY_MS
      : Math.round(item.duration * 1000)

/** 目录里各转场的接法（按组件名），编辑时按它检查转场放不放得下 */
export const transitionSpecs = (catalog: ComponentCatalog): Record<string, TransitionSpec> =>
  Object.fromEntries(
    catalog.items.flatMap((item) =>
      item.placement === 'transition' && item.transition !== undefined && item.duration !== null
        ? [[item.name, { cutAt: item.transition.cutAt, durationMs: durationMsOf(item) }]]
        : [],
    ),
  )

/** 可填项现在的值：草稿里填过的，没填过取组件的默认值 */
export const variableValue = (
  variable: CatalogVariable,
  values: ComponentVariables,
): VariableValue => values[variable.id] ?? variable.default

/** 组件栏的排序照设计稿：分类按 Studio 的顺序，同一分类里字幕、片头片尾、转场、包装依次排 */
const PLACEMENT_RANK: Record<Placement, number> = {
  caption: 0,
  intro: 1,
  outro: 1,
  transition: 2,
  overlay: 3,
}

export const sortedItems = (catalog: ComponentCatalog): CatalogItem[] => {
  const rank = (id: string) => catalog.categories.findIndex((category) => category.id === id)
  return catalog.items.toSorted(
    (a, b) =>
      rank(a.category) - rank(b.category) ||
      PLACEMENT_RANK[a.placement] - PLACEMENT_RANK[b.placement],
  )
}

export const ALL_CATEGORIES = 'all'

/** 组件栏筛哪些：按 Studio 的分类，或只看片头 / 片尾（画面轨两端的「+ 片头」「+ 片尾」） */
export type ComponentFilter =
  { kind: 'category'; id: string } | { kind: 'placement'; placement: 'intro' | 'outro' }

export const SHOW_ALL: ComponentFilter = { kind: 'category', id: ALL_CATEGORIES }

export const matchesFilter = (item: CatalogItem, filter: ComponentFilter) =>
  filter.kind === 'placement'
    ? item.placement === filter.placement
    : filter.id === ALL_CATEGORIES || item.category === filter.id

export const itemOf = (catalog: ComponentCatalog, name: string): CatalogItem | undefined =>
  catalog.items.find((item) => item.name === name)

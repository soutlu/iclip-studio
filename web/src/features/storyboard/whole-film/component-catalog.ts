/**
 * 编辑器用到的组件目录：分类、放置位置、默认时长、品牌默认值与转场的接法。
 * 目录本身（`catalog/catalog.json`，约 270 KB）打开编辑器时才加载，缩略图只取地址。
 */

import { queryOptions, useQuery } from '@tanstack/react-query'
import type { IconName } from '@/shared/icons'
import type { BrandProfile } from '@/shared/api/brand-templates'
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

const THUMBNAILS = import.meta.glob<string>('./catalog/thumbnails/*.webp', {
  eager: true,
  query: '?url',
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

/** 品牌模板里这一项的值；品牌没设标语时为 undefined（组件用自己的默认值） */
const brandValue = (variable: CatalogVariable, brand: BrandProfile): string | undefined =>
  variable.brand === 'name'
    ? brand.brand
    : variable.brand === 'slogan'
      ? (brand.slogan ?? undefined)
      : undefined

/**
 * 组件对得上品牌模板的可填项（品牌名、标语）取这个品牌的值。只写这几项，其余可填项不写进草稿，
 * 合成时取组件自己的默认值。
 */
export const brandVariables = (
  item: CatalogItem,
  brand: BrandProfile | undefined,
): ComponentVariables => {
  if (brand === undefined) return {}
  return Object.fromEntries(
    item.variables.flatMap((variable) => {
      const value = brandValue(variable, brand)
      return value === undefined ? [] : [[variable.id, value]]
    }),
  )
}

/**
 * 换一个品牌填品牌项：对得上品牌模板的可填项换成这个品牌的值，品牌没设标语时去掉那一项
 * （回到组件自己的默认值）；其余已填的项不动。
 */
export const withBrand = (
  item: CatalogItem,
  values: ComponentVariables,
  brand: BrandProfile,
): ComponentVariables => {
  const next = { ...values }
  for (const variable of item.variables) {
    if (variable.brand === undefined) continue
    const value = brandValue(variable, brand)
    if (value === undefined) delete next[variable.id]
    else next[variable.id] = value
  }
  return next
}

/** 这个组件现在填的是哪个品牌：品牌名那一项与哪个品牌对得上；对不上（改过或没有品牌名项）为 undefined */
export const brandOf = (
  item: CatalogItem,
  values: ComponentVariables,
  brands: readonly BrandProfile[],
): BrandProfile | undefined => {
  const nameField = item.variables.find((variable) => variable.brand === 'name')
  if (nameField === undefined) return undefined
  const name = variableValue(nameField, values)
  return brands.find((brand) => brand.brand === name)
}

/** 片头片尾换组件时要带过去的品牌项：可填项 id → 品牌名或标语 */
export const brandFieldsOf = (item: CatalogItem): Record<string, 'name' | 'slogan'> =>
  Object.fromEntries(
    item.variables.flatMap((variable) =>
      variable.brand === undefined ? [] : [[variable.id, variable.brand]],
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

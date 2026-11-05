import { queryOptions, useQuery } from '@tanstack/react-query'
import type { IconName } from '@/shared/icons'
import COLOR_PRESETS from './color-presets.json'
import type {
  CatalogItem,
  CatalogVariable,
  ComponentCatalog,
  VariableValue,
} from './composition/catalog'
import type { ComponentVariables } from './editing/draft'

export type { CatalogItem, CatalogVariable, ComponentCatalog, VariableValue }

export const thumbnailOf = (catalog: ComponentCatalog, item: CatalogItem): string | undefined =>
  item.thumbnail === null
    ? undefined
    : `/hyperframes/${catalog.version}/thumbnails/${item.thumbnail}`

const catalogQuery = queryOptions({
  queryKey: ['whole-film', 'component-catalog'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/hyperframes/catalog.json', { signal })
    if (!response.ok) throw new Error(`组件库目录读取失败（${response.status}）`)
    return (await response.json()) as ComponentCatalog
  },
  staleTime: Infinity,
  gcTime: Infinity,
})

export const useComponentCatalog = () => useQuery(catalogQuery)

export const defaultLaneLabel = (item: CatalogItem): string =>
  item.kind === 'block' ? '画面轨' : '特效轨'

export const CATEGORY_ICON: Record<string, IconName> = {
  captions: 'captions',
  vfx: 'sparkles',
  transitions: 'swap-panes',
  effects: 'blend',
  'text-effects': 'type',
  social: 'message',
  scenes: 'film',
}

export const durationMsOf = (item: CatalogItem): number => {
  if (item.duration === null) throw new Error(`组件目录里「${item.name}」没有时长`)
  return Math.round(item.duration * 1000)
}

export const variableValue = (
  variable: CatalogVariable,
  values: ComponentVariables,
): VariableValue => values[variable.id] ?? variable.default

export type FontOption = { value: string; label: string }

export const fontOptions = (catalog: ComponentCatalog): FontOption[] => [
  { value: '', label: '默认' },
  ...Object.entries(catalog.fonts).flatMap(([family, font]) =>
    font.brand === undefined ? [] : [{ value: family, label: font.brand }],
  ),
]

export const fontLabel = (options: readonly FontOption[], value: string): string =>
  options.find((option) => option.value === value)?.label ?? value

export const fontVariableOf = (item: CatalogItem): CatalogVariable | undefined =>
  item.variables.find((variable) => variable.type === 'font')

export type ComponentGroup = { id: string; label: string; items: CatalogItem[] }

const listedItems = (catalog: ComponentCatalog): CatalogItem[] =>
  catalog.items.filter((item) => item.placement !== 'caption')

export const captionStyles = (catalog: ComponentCatalog): CatalogItem[] =>
  catalog.items.filter((item) => item.placement === 'caption')

export const brandGroups = (catalog: ComponentCatalog): ComponentGroup[] => {
  const groups = new Map<string, ComponentGroup>()
  for (const item of listedItems(catalog)) {
    if (item.brand === undefined) continue
    const group = groups.get(item.brand) ?? { id: item.brand, label: item.brand, items: [] }
    group.items.push(item)
    groups.set(item.brand, group)
  }
  return [...groups.values()]
}

export const categoryGroups = (catalog: ComponentCatalog): ComponentGroup[] =>
  catalog.categories.flatMap((category) => {
    const items = listedItems(catalog).filter(
      (item) => item.brand === undefined && item.category === category.id,
    )
    return items.length === 0 ? [] : [{ id: category.id, label: category.label, items }]
  })

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const swatchColors = (defaultColor: string, current: string): string[] => {
  const colors = [defaultColor, ...COLOR_PRESETS].filter(
    (color, index, all) => all.findIndex((other) => sameColor(other, color)) === index,
  )
  return colors.some((color) => sameColor(color, current))
    ? colors
    : [colors[0] ?? current, current, ...colors.slice(1)]
}

export const isLightColor = (color: string): boolean => {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (match?.[1] === undefined) return false
  const value = Number.parseInt(match[1], 16)
  const luma = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)
  return luma / 255 > 0.6
}

export const itemOf = (catalog: ComponentCatalog, name: string): CatalogItem | undefined =>
  catalog.items.find((item) => item.name === name)

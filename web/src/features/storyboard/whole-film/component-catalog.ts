/**
 * 编辑器用到的组件目录：分类、点卡片时的默认去处与组件自己的时长。
 * 目录本身是部署侧组件库里的 `/hyperframes/catalog.json`，打开编辑器时才读；组件、运行时与封面
 * 在 `/hyperframes/<version>/` 下。
 */

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

/** 组件的缩略图地址；目录里没有缩略图的组件为 undefined */
export const thumbnailOf = (catalog: ComponentCatalog, item: CatalogItem): string | undefined =>
  item.thumbnail === null
    ? undefined
    : `/hyperframes/${catalog.version}/thumbnails/${item.thumbnail}`

const catalogQuery = queryOptions({
  queryKey: ['whole-film', 'component-catalog'],
  queryFn: async ({ signal }) => {
    const response = await fetch('/hyperframes/catalog.json', { signal })
    if (!response.ok) throw new Error(`组件库目录读取失败（${response.status}）`)
    // 组装工具写出的目录，形状即 ComponentCatalog（JSON 推不出字面量联合）
    return (await response.json()) as ComponentCatalog
  },
  staleTime: Infinity,
  gcTime: Infinity,
})

export const useComponentCatalog = () => useQuery(catalogQuery)

/** 点卡片时组件去哪：block 插进画面轨，其余放到特效轨 */
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

/**
 * 组件自己的动画时长（毫秒），放进成片的默认时长，也是组件段与特效块最长能放的时长。
 * 字幕样式没有时长，不能这样取；能放的组件没有时长是目录写错了，直接报错。
 */
export const durationMsOf = (item: CatalogItem): number => {
  if (item.duration === null) throw new Error(`组件目录里「${item.name}」没有时长`)
  return Math.round(item.duration * 1000)
}

/** 可填项现在的值：草稿里填过的，没填过取组件的默认值 */
export const variableValue = (
  variable: CatalogVariable,
  values: ComponentVariables,
): VariableValue => values[variable.id] ?? variable.default

/** 字体项的一个选项：取值是字体名，空字符串是组件自带的字体 */
export type FontOption = { value: string; label: string }

/** 字体项的选项：「默认」（组件自带的字体）加上目录里每个带品牌的字体，选项文字是品牌缩写 */
export const fontOptions = (catalog: ComponentCatalog): FontOption[] => [
  { value: '', label: '默认' },
  ...Object.entries(catalog.fonts).flatMap(([family, font]) =>
    font.brand === undefined ? [] : [{ value: family, label: font.brand }],
  ),
]

/** 字体项现在的值在选项里的文字；不在选项里（目录里不再是品牌字体）时直接显示字体名 */
export const fontLabel = (options: readonly FontOption[], value: string): string =>
  options.find((option) => option.value === value)?.label ?? value

/** 组件的字体项（组装工具给读字体变量的组件加上的那一项）；没有时为 undefined */
export const fontVariableOf = (item: CatalogItem): CatalogVariable | undefined =>
  item.variables.find((variable) => variable.type === 'font')

/** 侧栏的一个小标题（品牌或分类）和它下面的卡片 */
export type ComponentGroup = { id: string; label: string; items: CatalogItem[] }

/** 侧栏列出的组件：字幕样式是字幕轨的属性，只在字幕轨标题上换，不进品牌栏和通用栏 */
const listedItems = (catalog: ComponentCatalog): CatalogItem[] =>
  catalog.items.filter((item) => item.placement !== 'caption')

/** 字幕轨标题菜单里的字幕样式，保持目录的顺序 */
export const captionStyles = (catalog: ComponentCatalog): CatalogItem[] =>
  catalog.items.filter((item) => item.placement === 'caption')

/** 品牌栏：有品牌的组件按品牌分组，品牌按在目录里第一次出现的顺序，组内保持目录的顺序 */
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

/** 通用栏：没有品牌的组件按分类分组，分类按 Studio 的顺序，没有组件的分类不列 */
export const categoryGroups = (catalog: ComponentCatalog): ComponentGroup[] =>
  catalog.categories.flatMap((category) => {
    const items = listedItems(catalog).filter(
      (item) => item.brand === undefined && item.category === category.id,
    )
    return items.length === 0 ? [] : [{ id: category.id, label: category.label, items }]
  })

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** 颜色项的一排色块：组件默认色在最前，其后是中性色与常用色；现在用的不在其中时排在默认色后面 */
export const swatchColors = (defaultColor: string, current: string): string[] => {
  const colors = [defaultColor, ...COLOR_PRESETS].filter(
    (color, index, all) => all.findIndex((other) => sameColor(other, color)) === index,
  )
  return colors.some((color) => sameColor(color, current))
    ? colors
    : [colors[0] ?? current, current, ...colors.slice(1)]
}

/** 六位 hex 的浅色（色块上的勾改用深色）；认不出的颜色当深色 */
export const isLightColor = (color: string): boolean => {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (match?.[1] === undefined) return false
  const value = Number.parseInt(match[1], 16)
  const luma = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)
  return luma / 255 > 0.6
}

export const itemOf = (catalog: ComponentCatalog, name: string): CatalogItem | undefined =>
  catalog.items.find((item) => item.name === name)

import { describe, expect, it } from 'vitest'
import catalogJson from './catalog/catalog.json'
import {
  defaultLaneLabel,
  durationMsOf,
  itemOf,
  sortedItems,
  thumbnailOf,
  type CatalogItem,
  type ComponentCatalog,
} from './component-catalog'

const catalog = catalogJson as ComponentCatalog
const item = (name: string): CatalogItem => {
  const found = itemOf(catalog, name)
  if (found === undefined) throw new Error(`目录里没有 ${name}`)
  return found
}

describe('组件目录', () => {
  it('placement 只认字幕样式，其余组件不分片头、片尾、转场；目录里没有转场的接法', () => {
    const captions = catalog.items.filter((entry) => entry.placement === 'caption')
    expect(captions.map((entry) => entry.name).sort()).toEqual([
      'caption-highlight',
      'caption-texture',
      'default-caption',
    ])
    expect(
      catalog.items.filter((entry) => entry.placement !== 'caption' && entry.placement !== null),
    ).toEqual([])
    expect(catalog.items.some((entry) => 'transition' in entry)).toBe(false)
  })

  it.each([
    ['有固定时长的取自己的时长，不看整片多长', 'yt-logo-intro', 30_000, 6_000],
    ['有固定时长的转场类组件同样取自己的时长', 'grid-pixelate-wipe', 0, 1_200],
    ['没有固定时长、整片不到 10 秒：10 秒', 'logo-brand-close', 3_000, 10_000],
    ['没有固定时长、整片超过 10 秒：整片多长就多长', 'count-up', 15_000, 15_000],
  ])('放进成片的时长：%s', (_, name, filmMs, ms) => {
    expect(durationMsOf(item(name), filmMs)).toBe(ms)
  })

  it('点卡片的默认去处：字幕样式、block 进成片轨、其余进包装轨', () => {
    expect(defaultLaneLabel(item('caption-highlight'))).toBe('字幕样式')
    expect(defaultLaneLabel(item('logo-outro'))).toBe('成片轨')
    expect(defaultLaneLabel(item('hw-arrow'))).toBe('包装轨')
  })

  it('组件栏按 Studio 的分类排，同一分类里保持目录的顺序；缩略图按文件名取地址', () => {
    const sorted = sortedItems(catalog)
    expect(sorted).toHaveLength(catalog.items.length)
    const rank = (entry: CatalogItem) =>
      catalog.categories.findIndex((category) => category.id === entry.category)
    expect(sorted.map(rank)).toEqual(sorted.map(rank).toSorted((a, b) => a - b))
    const scenes = (items: CatalogItem[]) =>
      items.filter((entry) => entry.category === 'scenes').map((entry) => entry.name)
    expect(scenes(sorted)).toEqual(scenes(catalog.items))
    expect(thumbnailOf(item('caption-highlight'))).toMatch(/caption-highlight\.svg/)
    expect(thumbnailOf({ ...item('default-caption'), thumbnail: null })).toBeUndefined()
  })
})

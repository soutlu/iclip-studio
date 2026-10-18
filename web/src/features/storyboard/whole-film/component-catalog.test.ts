import { describe, expect, it } from 'vitest'
import catalogJson from './catalog/catalog.json'
import {
  durationMsOf,
  itemOf,
  sortedItems,
  thumbnailOf,
  transitionSpecs,
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
  it('转场的接法取目录里的切点位置与原定时长，只收转场', () => {
    const specs = transitionSpecs(catalog)
    expect(specs['fade-through']).toEqual({ cutAt: 0.5, durationMs: 900 })
    expect(specs['editorial-flash-overlay']).toEqual({ cutAt: 0.59, durationMs: 4_000 })
    expect(Object.keys(specs).sort()).toEqual(
      catalog.items
        .filter((entry) => entry.placement === 'transition')
        .map((entry) => entry.name)
        .sort(),
    )
  })

  it.each([
    ['片头先放 2 秒，不论组件多长', 'yt-logo-intro', 2_000],
    ['没有固定时长的片尾也是 2 秒', 'logo-brand-close', 2_000],
    ['包装取组件原定的时长', 'hw-arrow', 4_000],
    ['没有固定时长的包装 3 秒', 'count-up', 3_000],
    ['转场取原定时长', 'fade-through', 900],
  ])('放进成片的时长：%s', (_, name, ms) => {
    expect(durationMsOf(item(name))).toBe(ms)
  })

  it('组件栏按 Studio 的分类排，同一分类里字幕、片头片尾、转场、包装依次排；缩略图按文件名取地址', () => {
    const sorted = sortedItems(catalog)
    expect(sorted).toHaveLength(catalog.items.length)
    const rank = (entry: CatalogItem) =>
      catalog.categories.findIndex((category) => category.id === entry.category)
    expect(sorted.map(rank)).toEqual(sorted.map(rank).toSorted((a, b) => a - b))
    const scenes = sorted.filter((entry) => entry.category === 'scenes').map((e) => e.placement)
    expect(scenes.indexOf('overlay')).toBeGreaterThan(scenes.lastIndexOf('outro'))
    expect(thumbnailOf(item('caption-highlight'))).toMatch(/caption-highlight\.svg/)
    expect(thumbnailOf({ ...item('default-caption'), thumbnail: null })).toBeUndefined()
  })
})

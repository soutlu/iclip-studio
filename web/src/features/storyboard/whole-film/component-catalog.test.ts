import { describe, expect, it } from 'vitest'
import catalogJson from './catalog/catalog.json'
import {
  brandOf,
  brandVariables,
  durationMsOf,
  itemOf,
  sortedItems,
  thumbnailOf,
  transitionSpecs,
  withBrand,
  type CatalogItem,
  type ComponentCatalog,
} from './component-catalog'

const catalog = catalogJson as ComponentCatalog
const item = (name: string): CatalogItem => {
  const found = itemOf(catalog, name)
  if (found === undefined) throw new Error(`目录里没有 ${name}`)
  return found
}

const SHIBU = { brand: '拾步', slogan: '每一步，都暖一点', accentColor: '#b8662f' }
const PLAIN = { brand: '通用', slogan: null, accentColor: null }

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

  it('品牌项：品牌名、标语取品牌模板；品牌没设标语时不写，用组件自己的默认值', () => {
    const outro = item('logo-brand-close')
    expect(brandVariables(outro, SHIBU)).toEqual({
      wordmark: '拾步',
      tagline: '每一步，都暖一点',
    })
    expect(brandVariables(outro, PLAIN)).toEqual({ wordmark: '通用' })
    expect(brandVariables(outro, undefined)).toEqual({})
    expect(brandVariables(item('hw-arrow'), SHIBU)).toEqual({})
  })

  it('换品牌只改品牌项：没有标语的品牌去掉标语，其余已填的项不动', () => {
    const outro = item('logo-brand-close')
    const filled = { wordmark: '拾步', tagline: '每一步，都暖一点', url: 'shibu.cn' }
    expect(withBrand(outro, filled, PLAIN)).toEqual({ wordmark: '通用', url: 'shibu.cn' })
  })

  it('现在填的是哪个品牌：按品牌名那一项认；改过名或没有品牌名项时认不出', () => {
    const outro = item('logo-brand-close')
    const brands = [SHIBU, PLAIN]
    expect(brandOf(outro, { wordmark: '通用' }, brands)).toBe(PLAIN)
    expect(brandOf(outro, { wordmark: '改过的名字' }, brands)).toBeUndefined()
    expect(brandOf(item('hw-arrow'), {}, brands)).toBeUndefined()
  })

  it('组件栏按 Studio 的分类排，同一分类里字幕、片头片尾、转场、包装依次排；缩略图按文件名取地址', () => {
    const sorted = sortedItems(catalog)
    expect(sorted).toHaveLength(catalog.items.length)
    const rank = (entry: CatalogItem) =>
      catalog.categories.findIndex((category) => category.id === entry.category)
    expect(sorted.map(rank)).toEqual(sorted.map(rank).toSorted((a, b) => a - b))
    const scenes = sorted.filter((entry) => entry.category === 'scenes').map((e) => e.placement)
    expect(scenes.indexOf('overlay')).toBeGreaterThan(scenes.lastIndexOf('outro'))
    expect(thumbnailOf(item('caption-highlight'))).toMatch(/caption-highlight\.webp/)
    expect(thumbnailOf({ ...item('default-caption'), thumbnail: null })).toBeUndefined()
  })
})

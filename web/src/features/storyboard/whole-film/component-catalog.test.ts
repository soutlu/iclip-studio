import { describe, expect, it } from 'vitest'
import { withBrandFixtures } from '@/testing/whole-film'
import catalogJson from './catalog/catalog.json'
import {
  brandGroups,
  categoryGroups,
  defaultLaneLabel,
  durationMsOf,
  itemOf,
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

  it('点卡片的默认去处：字幕样式、block 进成片轨、其余进特效轨', () => {
    expect(defaultLaneLabel(item('caption-highlight'))).toBe('字幕样式')
    expect(defaultLaneLabel(item('logo-outro'))).toBe('成片轨')
    expect(defaultLaneLabel(item('hw-arrow'))).toBe('特效轨')
  })

  it('缩略图按文件名取地址，没有缩略图的为 undefined', () => {
    expect(thumbnailOf(item('caption-highlight'))).toMatch(/caption-highlight\.svg/)
    expect(thumbnailOf({ ...item('default-caption'), thumbnail: null })).toBeUndefined()
  })
})

describe('侧栏分组', () => {
  const names = (items: CatalogItem[]) => items.map((entry) => entry.name)

  it('真实目录没有品牌组件：品牌栏没有小标题，通用栏收下全部组件', () => {
    expect(brandGroups(catalog)).toEqual([])
    const groups = categoryGroups(catalog)
    expect(groups.flatMap((group) => group.items)).toHaveLength(catalog.items.length)
  })

  it('品牌栏按品牌分组，品牌按目录里第一次出现的顺序，组内保持目录的顺序', () => {
    const groups = brandGroups(withBrandFixtures(catalog))
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.title)])).toEqual([
      ['拾步', ['拾步 片头', '拾步 片尾']],
      ['暖屿', ['暖屿 片头', '暖屿 片尾']],
    ])
  })

  it('通用栏只收没有品牌的组件，分类按 Studio 的顺序，没有组件的分类不列', () => {
    const branded = withBrandFixtures(catalog)
    const groups = categoryGroups({
      ...branded,
      items: branded.items.filter((entry) => entry.category !== 'transitions'),
    })
    expect(groups.map((group) => group.id)).toEqual(
      catalog.categories.map((category) => category.id).filter((id) => id !== 'transitions'),
    )
    const all = groups.flatMap((group) => group.items)
    expect(all.some((entry) => entry.brand !== undefined)).toBe(false)
    const scenes = groups.find((group) => group.id === 'scenes')
    expect(scenes?.label).toBe('场景')
    expect(names(scenes?.items ?? [])).toEqual(
      names(catalog.items.filter((entry) => entry.category === 'scenes')),
    )
  })
})

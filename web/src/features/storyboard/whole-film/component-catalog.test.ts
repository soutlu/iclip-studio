import { describe, expect, it } from 'vitest'
import { withBrandFixtures } from '@/testing/whole-film'
import catalogJson from './catalog/catalog.json'
import {
  brandGroups,
  captionStyles,
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
    ['yt-logo-intro', 6_000],
    ['grid-pixelate-wipe', 1_200],
    ['headline-slam', 3_500],
    ['logo-brand-close', 4_000],
    ['cursor-annotate', 2_950],
  ])('组件自己的时长：%s %i 毫秒', (name, ms) => {
    expect(durationMsOf(item(name))).toBe(ms)
  })

  it('能放的组件都有正数时长，字幕样式没有；没有时长的不能取', () => {
    const placeable = catalog.items.filter((entry) => entry.placement !== 'caption')
    const untimed = placeable.filter(
      (entry) =>
        entry.duration === null || !(entry.duration > 0) || !Number.isFinite(entry.duration),
    )
    expect(untimed.map((entry) => entry.name)).toEqual([])
    expect(captionStyles(catalog).map((entry) => entry.duration)).toEqual([null, null, null])
    expect(() => durationMsOf(item('default-caption'))).toThrow(
      '组件目录里「default-caption」没有时长',
    )
  })

  it('touch-indicator 单独放置时不显示任何内容：不收进目录，列在排除名单里', () => {
    expect(itemOf(catalog, 'touch-indicator')).toBeUndefined()
    expect(catalog.excluded.find((entry) => entry.name === 'touch-indicator')).toMatchObject({
      reason: '单独放置时画面上不显示任何内容',
    })
  })

  it('点卡片的默认去处：block 进画面轨、其余进特效轨', () => {
    expect(defaultLaneLabel(item('logo-outro'))).toBe('画面轨')
    expect(defaultLaneLabel(item('hw-arrow'))).toBe('特效轨')
  })

  it('缩略图按文件名取地址，没有缩略图的为 undefined', () => {
    expect(thumbnailOf(item('caption-highlight'))).toMatch(/caption-highlight\.svg/)
    expect(thumbnailOf({ ...item('default-caption'), thumbnail: null })).toBeUndefined()
  })
})

describe('侧栏分组', () => {
  const names = (items: CatalogItem[]) => items.map((entry) => entry.name)

  it('真实目录没有品牌组件：品牌栏没有小标题，通用栏收下字幕样式以外的全部组件', () => {
    expect(brandGroups(catalog)).toEqual([])
    const groups = categoryGroups(catalog)
    expect(groups.flatMap((group) => group.items)).toHaveLength(catalog.items.length - 3)
    expect(groups.map((group) => group.id)).not.toContain('captions')
    expect(groups[0]?.label).toBe('视觉特效')
  })

  it('字幕样式不进品牌栏和通用栏，只列在字幕样式菜单里，保持目录的顺序', () => {
    const branded = withBrandFixtures(catalog)
    const brandedCaption = { ...item('caption-texture'), name: 'brand-caption', brand: '拾步' }
    const withCaption = { ...branded, items: [...branded.items, brandedCaption] }
    const listed = [...brandGroups(withCaption), ...categoryGroups(withCaption)].flatMap(
      (group) => group.items,
    )
    expect(listed.some((entry) => entry.placement === 'caption')).toBe(false)
    expect(names(captionStyles(catalog))).toEqual([
      'default-caption',
      'caption-highlight',
      'caption-texture',
    ])
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
    // 字幕分类只有字幕样式，也不列
    expect(groups.map((group) => group.id)).toEqual(
      catalog.categories
        .map((category) => category.id)
        .filter((id) => id !== 'transitions' && id !== 'captions'),
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

import { describe, expect, it } from 'vitest'
import { fixtureCatalog as catalog, fixtureItem as item } from '@/testing/whole-film'
import {
  brandGroups,
  captionStyles,
  categoryGroups,
  defaultLaneLabel,
  durationMsOf,
  thumbnailOf,
  type CatalogItem,
  type ComponentCatalog,
} from './component-catalog'

/** 补上两个品牌的示例卡：品牌按出现顺序 B、A，A 的卡排在 B 的两张之间 */
const withBrands = (base: ComponentCatalog): ComponentCatalog => {
  const card = (name: string, title: string, brand: string): CatalogItem => ({
    ...item('fixture-brand-card'),
    name,
    title,
    brand,
  })
  return {
    ...base,
    items: [
      ...base.items.filter((entry) => entry.brand === undefined),
      card('b-intro', 'B 片头', 'B'),
      card('a-intro', 'A 片头', 'A'),
      card('b-outro', 'B 片尾', 'B'),
    ],
  }
}

describe('组件目录', () => {
  it('组件自己的时长换成毫秒；字幕样式没有时长，不能取', () => {
    expect(durationMsOf(item('fixture-scene'))).toBe(6_000)
    expect(durationMsOf({ ...item('fixture-overlay'), duration: 1.25 })).toBe(1_250)
    expect(() => durationMsOf(item('default-caption'))).toThrow(
      '组件目录里「default-caption」没有时长',
    )
  })

  it('点卡片的默认去处：block 进画面轨、其余进特效轨', () => {
    expect(defaultLaneLabel(item('fixture-scene'))).toBe('画面轨')
    expect(defaultLaneLabel(item('fixture-overlay'))).toBe('特效轨')
  })

  it('缩略图在这一版组件库的 thumbnails/ 下，没有缩略图的为 undefined', () => {
    expect(thumbnailOf(catalog, item('fixture-scene'))).toBe(
      '/hyperframes/test-fixtures/thumbnails/fixture-scene.svg',
    )
    expect(thumbnailOf(catalog, { ...item('fixture-scene'), thumbnail: null })).toBeUndefined()
  })
})

describe('侧栏分组', () => {
  const names = (items: CatalogItem[]) => items.map((entry) => entry.name)

  it('没有品牌组件时品牌栏没有小标题', () => {
    const plain = { ...catalog, items: catalog.items.filter((entry) => entry.brand === undefined) }
    expect(brandGroups(plain)).toEqual([])
  })

  it('字幕样式不进品牌栏和通用栏，只列在字幕样式菜单里，保持目录的顺序', () => {
    const brandedCaption = { ...item('default-caption'), name: 'brand-caption', brand: 'A' }
    const second = { ...item('default-caption'), name: 'second-caption' }
    const withCaptions = {
      ...withBrands(catalog),
      items: [...withBrands(catalog).items, second, brandedCaption],
    }
    const listed = [...brandGroups(withCaptions), ...categoryGroups(withCaptions)].flatMap(
      (group) => group.items,
    )
    expect(listed.some((entry) => entry.placement === 'caption')).toBe(false)
    expect(names(captionStyles(withCaptions))).toEqual([
      'default-caption',
      'second-caption',
      'brand-caption',
    ])
  })

  it('品牌栏按品牌分组，品牌按目录里第一次出现的顺序，组内保持目录的顺序', () => {
    expect(brandGroups(catalog).map((group) => [group.label, names(group.items)])).toEqual([
      ['示例品牌', ['fixture-brand-card']],
    ])
    const groups = brandGroups(withBrands(catalog))
    expect(groups.map((group) => [group.label, group.items.map((entry) => entry.title)])).toEqual([
      ['B', ['B 片头', 'B 片尾']],
      ['A', ['A 片头']],
    ])
  })

  it('通用栏只收没有品牌的组件，分类按目录的顺序，没有组件的分类不列', () => {
    const groups = categoryGroups(catalog)
    // 字幕分类只有字幕样式，也不列
    expect(groups.map((group) => group.id)).toEqual(['effects', 'text-effects', 'scenes'])
    expect(groups.map((group) => group.label)).toEqual(['效果', '文字效果', '场景'])
    expect(groups.flatMap((group) => names(group.items))).toEqual([
      'fixture-overlay',
      'fixture-fields',
      'fixture-scene',
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { audio, fixtureCatalog, host, video } from '@/testing/whole-film'
import type { CatalogItem } from './composition/catalog'
import {
  filterItems,
  itemChips,
  itemDurationMs,
  playheadSpot,
  type ItemChip,
  type ItemKind,
} from './items'

const chip = (kind: ItemKind, label: string): ItemChip => {
  const found = itemChips(fixtureCatalog, kind).find((candidate) => candidate.label === label)
  if (found === undefined) throw new Error(`没有分类「${label}」`)
  return found
}
const labels = (chips: ItemChip[]) => chips.map((candidate) => candidate.label)
const titles = (items: CatalogItem[]) => items.map((item) => item.title)
const item = (name: string): CatalogItem => {
  const found = fixtureCatalog.items.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`测试组件库里没有 ${name}`)
  return found
}

describe('组件、块页签的分类和搜索', () => {
  it('分类一排：全部、品牌，再是目录里除字幕以外的各类，只列这种条目里有的', () => {
    expect(labels(itemChips(fixtureCatalog, 'component'))).toEqual(['全部', '效果', '文字效果'])
    expect(labels(itemChips(fixtureCatalog, 'block'))).toEqual(['全部', '品牌', '场景'])
  })

  it('一类里两种条目都有：每个页签的这一类和「品牌」只列自己这种', () => {
    const catalog = {
      ...fixtureCatalog,
      items: fixtureCatalog.items.map((entry) =>
        entry.name === 'fixture-overlay'
          ? { ...entry, category: 'scenes', brand: '示例品牌' }
          : entry,
      ),
    }
    const listed = (kind: ItemKind, label: string) => {
      const found = itemChips(catalog, kind).find((candidate) => candidate.label === label)
      return found === undefined ? [] : titles(filterItems(catalog, found, ''))
    }
    expect(listed('component', '场景')).toEqual(['测试叠加'])
    expect(listed('component', '品牌')).toEqual(['测试叠加'])
    expect(listed('block', '场景')).toEqual(['测试画面', '示例品牌 片尾'])
    expect(listed('block', '品牌')).toEqual(['示例品牌 片尾'])
  })

  it('这种条目一个都没有：只有「全部」，里面是空的', () => {
    const catalog = {
      ...fixtureCatalog,
      items: fixtureCatalog.items.filter((entry) => entry.kind === 'component'),
    }
    const chips = itemChips(catalog, 'block')
    expect(labels(chips)).toEqual(['全部'])
    expect(filterItems(catalog, chips[0] as ItemChip, '')).toEqual([])
  })

  it('「全部」是这种条目里字幕以外的全部，按目录里的先后', () => {
    expect(titles(filterItems(fixtureCatalog, chip('component', '全部'), ''))).toEqual([
      '测试叠加',
      '测试可填项',
    ])
    expect(titles(filterItems(fixtureCatalog, chip('block', '全部'), ''))).toEqual([
      '测试画面',
      '示例品牌 片尾',
    ])
  })

  it('「品牌」是带品牌的条目；目录里的一类是这一类里这种条目', () => {
    expect(titles(filterItems(fixtureCatalog, chip('block', '品牌'), ''))).toEqual([
      '示例品牌 片尾',
    ])
    expect(titles(filterItems(fixtureCatalog, chip('block', '场景'), ''))).toEqual([
      '测试画面',
      '示例品牌 片尾',
    ])
    expect(titles(filterItems(fixtureCatalog, chip('component', '效果'), ''))).toEqual(['测试叠加'])
  })

  it('搜索匹配名字、说明和分类名，去掉两头空白；只在选中的分类里找', () => {
    const all = chip('component', '全部')
    expect(titles(filterItems(fixtureCatalog, all, '叠加'))).toEqual(['测试叠加'])
    expect(titles(filterItems(fixtureCatalog, all, '圆环'))).toEqual(['测试叠加'])
    expect(titles(filterItems(fixtureCatalog, all, ' 文字效果 '))).toEqual(['测试可填项'])
    expect(titles(filterItems(fixtureCatalog, all, '画面'))).toEqual(['测试叠加'])
    expect(titles(filterItems(fixtureCatalog, chip('block', '全部'), '画面'))).toEqual(['测试画面'])
    expect(filterItems(fixtureCatalog, chip('component', '文字效果'), '画面')).toEqual([])
    expect(filterItems(fixtureCatalog, all, '没有这个')).toEqual([])
  })

  it('搜索西文不分大小写', () => {
    const catalog = {
      ...fixtureCatalog,
      items: fixtureCatalog.items.map((entry) =>
        entry.name === 'fixture-scene' ? { ...entry, title: 'Glow Title' } : entry,
      ),
    }
    const [all] = itemChips(catalog, 'block')
    expect(titles(filterItems(catalog, all as ItemChip, 'glow'))).toEqual(['Glow Title'])
  })

  it('字幕搜不出来', () => {
    expect(filterItems(fixtureCatalog, chip('component', '全部'), '字幕')).toEqual([])
  })
})

describe('条目放进成片的时长', () => {
  it('条目写了时长就用它；没写时取 10 秒和成片现有总长里大的那个', () => {
    expect(itemDurationMs(item('fixture-scene'), [])).toBe(6000)
    const timeless = { ...item('fixture-scene'), duration: null }
    expect(itemDurationMs(timeless, [video({ duration: 4000 })])).toBe(10_000)
    expect(itemDurationMs(timeless, [audio({ start: 9000, duration: 3500 })])).toBe(12_500)
  })
})

describe('点「加到播放头」时放在哪', () => {
  const scene = item('fixture-scene')
  const overlay = item('fixture-overlay')

  it('还没有片段：都放在画面区新开的第一行，从播放头开始', () => {
    expect(playheadSpot([], scene, 1500, 6000)).toEqual({
      row: { zone: 'visual', insertAt: 0 },
      start: 1500,
    })
    expect(playheadSpot([], overlay, 1500, 4000)).toEqual({
      row: { zone: 'visual', insertAt: 0 },
      start: 1500,
    })
  })

  it('只有声音区的片段：都放在画面区新开的一行（在声音区上面）', () => {
    const music = [audio({ duration: 8000 })]
    expect(playheadSpot(music, scene, 0, 6000)).toEqual({
      row: { zone: 'visual', insertAt: 0 },
      start: 0,
    })
    expect(playheadSpot(music, overlay, 0, 4000)).toEqual({
      row: { zone: 'visual', insertAt: 0 },
      start: 0,
    })
  })

  it('block 类：第一行在这段时间空着就放进第一行（行号按它自己的）', () => {
    const clips = [
      video({ track: 2, start: 0, duration: 1000 }),
      video({ id: 'clip-2', track: 2, start: 8000, duration: 1000 }),
      video({ id: 'clip-3', track: 3, start: 1000, duration: 6000 }),
    ]
    expect(playheadSpot(clips, scene, 1000, 6000)).toEqual({
      row: { zone: 'visual', track: 2 },
      start: 1000,
    })
  })

  it('block 类：第一行在这段时间有片段，就在它下面紧挨着新开一行', () => {
    const clips = [
      video({ start: 0, duration: 1000 }),
      video({ id: 'clip-2', start: 6500, duration: 1000 }),
      video({ id: 'clip-3', track: 1, duration: 9000 }),
    ]
    expect(playheadSpot(clips, scene, 999, 6000)).toEqual({
      row: { zone: 'visual', insertAt: 1 },
      start: 999,
    })
    expect(playheadSpot(clips, scene, 1000, 6000)).toEqual({
      row: { zone: 'visual', insertAt: 1 },
      start: 1000,
    })
  })

  it('component 类：放在画面区最下面新开的一行，哪怕别的行空着；声音区的行不算', () => {
    const clips = [
      video({ start: 0, duration: 1000 }),
      host({ track: 1, start: 0, duration: 1000 }),
      audio(),
    ]
    expect(playheadSpot(clips, overlay, 5000, 4000)).toEqual({
      row: { zone: 'visual', insertAt: 2 },
      start: 5000,
    })
  })
})

import { describe, expect, it } from 'vitest'
import { audio, fixtureCatalog, host, video } from '@/testing/whole-film'
import type { CatalogItem } from './composition/catalog'
import { filterItems, itemChips, itemDurationMs, playheadSpot, type ItemChip } from './items'

const chips = itemChips(fixtureCatalog)
const chip = (label: string): ItemChip => {
  const found = chips.find((candidate) => candidate.label === label)
  if (found === undefined) throw new Error(`没有分类「${label}」`)
  return found
}
const titles = (items: CatalogItem[]) => items.map((item) => item.title)
const item = (name: string): CatalogItem => {
  const found = fixtureCatalog.items.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`测试组件库里没有 ${name}`)
  return found
}

describe('组件栏的分类和搜索', () => {
  it('分类一排：全部、品牌，再是目录里除字幕以外的各类', () => {
    expect(chips.map((candidate) => candidate.label)).toEqual([
      '全部',
      '品牌',
      '视觉特效',
      '转场',
      '效果',
      '文字效果',
      '社交',
      '场景',
    ])
  })

  it('「全部」是字幕以外的全部条目，按目录里的先后', () => {
    expect(titles(filterItems(fixtureCatalog, chip('全部'), ''))).toEqual([
      '测试画面',
      '测试叠加',
      '测试可填项',
      '示例品牌 片尾',
    ])
  })

  it('「品牌」是带品牌的条目；目录里的一类是这一类的条目；没有条目的类是空的', () => {
    expect(titles(filterItems(fixtureCatalog, chip('品牌'), ''))).toEqual(['示例品牌 片尾'])
    expect(titles(filterItems(fixtureCatalog, chip('场景'), ''))).toEqual([
      '测试画面',
      '示例品牌 片尾',
    ])
    expect(filterItems(fixtureCatalog, chip('转场'), '')).toEqual([])
  })

  it('搜索匹配名字、说明和分类名，去掉两头空白；只在选中的分类里找', () => {
    expect(titles(filterItems(fixtureCatalog, chip('全部'), '叠加'))).toEqual(['测试叠加'])
    expect(titles(filterItems(fixtureCatalog, chip('全部'), '圆环'))).toEqual(['测试叠加'])
    expect(titles(filterItems(fixtureCatalog, chip('全部'), ' 文字效果 '))).toEqual(['测试可填项'])
    expect(titles(filterItems(fixtureCatalog, chip('全部'), '画面'))).toEqual([
      '测试画面',
      '测试叠加',
    ])
    expect(titles(filterItems(fixtureCatalog, chip('效果'), '画面'))).toEqual(['测试叠加'])
    expect(filterItems(fixtureCatalog, chip('全部'), '没有这个')).toEqual([])
  })

  it('搜索西文不分大小写', () => {
    const catalog = {
      ...fixtureCatalog,
      items: fixtureCatalog.items.map((entry) =>
        entry.name === 'fixture-scene' ? { ...entry, title: 'Glow Title' } : entry,
      ),
    }
    expect(titles(filterItems(catalog, itemChips(catalog)[0] as ItemChip, 'glow'))).toEqual([
      'Glow Title',
    ])
  })

  it('字幕搜不出来', () => {
    expect(filterItems(fixtureCatalog, chip('全部'), '字幕')).toEqual([])
  })
})

describe('组件放进成片的时长', () => {
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

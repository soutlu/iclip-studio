import { describe, expect, it } from 'vitest'
import { aroundPlayhead, boxBetween, marqueeMode, marqueeSelection, movingWith } from './selection'

describe('框选', () => {
  // 两行：第一行 a、b，第二行 c；每个块 40 像素高
  const blocks = [
    { id: 'a', box: { left: 0, top: 0, width: 100, height: 40 } },
    { id: 'b', box: { left: 120, top: 0, width: 100, height: 40 } },
    { id: 'c', box: { left: 60, top: 50, width: 100, height: 40 } },
  ]
  const none = new Set<string>()

  it('框往哪个方向拖都一样', () => {
    expect(boxBetween({ x: 150, y: 70 }, { x: 90, y: 20 })).toEqual({
      left: 90,
      top: 20,
      width: 60,
      height: 50,
    })
  })

  it('和框相交的块都选中，可以跨行；只碰到边不算', () => {
    const marquee = boxBetween({ x: 90, y: 20 }, { x: 130, y: 60 })
    expect([...marqueeSelection(blocks, marquee, none, 'replace')]).toEqual(['a', 'b', 'c'])
    // 框的右边正好是 b 的左边、下边正好是 c 的上边
    const touching = boxBetween({ x: 90, y: 10 }, { x: 120, y: 50 })
    expect([...marqueeSelection(blocks, touching, none, 'replace')]).toEqual(['a'])
  })

  it('换：只留框住的；加：原有的加上框住的；去：原有的去掉框住的', () => {
    const marquee = boxBetween({ x: 130, y: 10 }, { x: 140, y: 60 })
    const base = new Set(['a', 'b'])
    expect([...marqueeSelection(blocks, marquee, base, 'replace')]).toEqual(['b', 'c'])
    expect([...marqueeSelection(blocks, marquee, base, 'add')].sort()).toEqual(['a', 'b', 'c'])
    expect([...marqueeSelection(blocks, marquee, base, 'subtract')]).toEqual(['a'])
  })

  it('按下时带 ⌘ 或 Ctrl、或者按着 Shift 是加；按着 Alt 是去，压过加', () => {
    const plain = { shiftKey: false, altKey: false }
    expect(marqueeMode(false, plain)).toBe('replace')
    expect(marqueeMode(true, plain)).toBe('add')
    expect(marqueeMode(false, { shiftKey: true, altKey: false })).toBe('add')
    expect(marqueeMode(false, { shiftKey: false, altKey: true })).toBe('subtract')
    expect(marqueeMode(true, { shiftKey: true, altKey: true })).toBe('subtract')
  })
})

describe('选中播放头左边、右边的块', () => {
  // 播放头在 2 秒：before 在它前面结束、at-start 从它开始、at-end 在它结束、across 跨着它、after 在它后面
  const blocks = [
    { id: 'before', start: 0, duration: 1_000 },
    { id: 'at-end', start: 500, duration: 1_500 },
    { id: 'across', start: 1_000, duration: 2_000 },
    { id: 'at-start', start: 2_000, duration: 1_000 },
    { id: 'after', start: 4_000, duration: 1_000 },
  ]

  it('左边是起点早于播放头的：正好从播放头开始的不算', () => {
    expect(aroundPlayhead(blocks, 2_000, 'left')).toEqual(['before', 'at-end', 'across'])
  })

  it('右边是结尾晚于播放头的：正好在播放头结束的不算', () => {
    expect(aroundPlayhead(blocks, 2_000, 'right')).toEqual(['across', 'at-start', 'after'])
  })
})

describe('拖一个块时谁跟着一起动', () => {
  it('抓的块在不止一个的选中里：整个选中一起动', () => {
    expect([...movingWith(new Set(['a', 'b']), 'b')]).toEqual(['a', 'b'])
  })

  it('抓的块不在选中里，或者只选中了它：只动它自己', () => {
    expect([...movingWith(new Set(['a', 'b']), 'c')]).toEqual(['c'])
    expect([...movingWith(new Set(['a']), 'a')]).toEqual(['a'])
    expect([...movingWith(new Set(), 'a')]).toEqual(['a'])
  })
})

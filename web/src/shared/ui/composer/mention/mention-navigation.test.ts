import { describe, expect, it } from 'vitest'
import { linearNavigation, optionAfterArrow, type OptionBox } from './mention-navigation'

describe('optionAfterArrow', () => {
  // 两行：第一行 4 格，第二行 2 格；每格 40×90、间距 4。
  const box = (column: number, row: number): OptionBox => ({
    height: 90,
    left: column * 44,
    top: row * 94,
    width: 40,
  })
  const boxes = [box(0, 0), box(1, 0), box(2, 0), box(3, 0), box(0, 1), box(1, 1)]

  it('← → 按顺序走，跨行接着走，到头停住不绕回', () => {
    expect(optionAfterArrow(0, 'ArrowRight', boxes)).toBe(1)
    expect(optionAfterArrow(3, 'ArrowRight', boxes)).toBe(4)
    expect(optionAfterArrow(5, 'ArrowRight', boxes)).toBe(5)
    expect(optionAfterArrow(4, 'ArrowLeft', boxes)).toBe(3)
    expect(optionAfterArrow(0, 'ArrowLeft', boxes)).toBe(0)
  })

  it('↑ ↓ 换到相邻行里水平中心最近的格子', () => {
    expect(optionAfterArrow(1, 'ArrowDown', boxes)).toBe(5)
    expect(optionAfterArrow(3, 'ArrowDown', boxes)).toBe(5)
    expect(optionAfterArrow(4, 'ArrowUp', boxes)).toBe(0)
    expect(optionAfterArrow(5, 'ArrowUp', boxes)).toBe(1)
  })

  it('没有上一行 / 下一行时不动', () => {
    expect(optionAfterArrow(2, 'ArrowUp', boxes)).toBe(2)
    expect(optionAfterArrow(4, 'ArrowDown', boxes)).toBe(4)
    expect(optionAfterArrow(1, 'ArrowDown', [box(0, 0), box(1, 0)])).toBe(1)
  })

  it('同一行里上下错开几像素的格子（末格「+」的内边距不同）仍算同一行', () => {
    const add = { height: 64, left: 2 * 44, top: 4, width: 36 }
    const row = [box(0, 0), box(1, 0), add]
    expect(optionAfterArrow(1, 'ArrowDown', row)).toBe(1)
    expect(optionAfterArrow(2, 'ArrowUp', row)).toBe(2)
    expect(optionAfterArrow(0, 'ArrowDown', [...row, box(1, 1)])).toBe(3)
  })
})

describe('linearNavigation', () => {
  const rows = [0, 1, 2].map((row) => ({ height: 32, left: 0, top: row * 32, width: 200 }))

  it('只拦 ↑ ↓，← → 留给光标', () => {
    expect(linearNavigation.arrows).toEqual(['ArrowUp', 'ArrowDown'])
  })

  it('↑ ↓ 按顺序走，到头停住不绕回', () => {
    expect(linearNavigation.next(0, 'ArrowDown', rows)).toBe(1)
    expect(linearNavigation.next(2, 'ArrowDown', rows)).toBe(2)
    expect(linearNavigation.next(1, 'ArrowUp', rows)).toBe(0)
    expect(linearNavigation.next(0, 'ArrowUp', rows)).toBe(0)
  })

  it('列表被筛空时停在 0', () => {
    expect(linearNavigation.next(0, 'ArrowDown', [])).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  opensFrameMention,
  optionAfterArrow,
  textAfterMention,
  type OptionBox,
} from './frame-mention'

describe('opensFrameMention', () => {
  const typed = { composing: false, editable: true, text: '@' }

  it('可编辑时键入一个 @ 就打开，前面是中文、空格还是行首都一样', () => {
    expect(opensFrameMention(typed)).toBe(true)
  })

  it.each([
    ['只读', { ...typed, editable: false }],
    ['输入法组合中', { ...typed, composing: true }],
    ['全角＠', { ...typed, text: '＠' }],
    ['一次进来多个字符', { ...typed, text: '@@' }],
    ['其它字符', { ...typed, text: 'a' }],
  ])('%s不打开', (_, input) => {
    expect(opensFrameMention(input)).toBe(false)
  })
})

describe('textAfterMention', () => {
  it.each([
    ['段中', '与双肩包 @ 并排', 5, 3, '与双肩包 @Image3 并排', 12],
    ['紧跟中文', '双肩包@', 3, 2, '双肩包@Image2', 10],
    ['段首', '@开场', 0, 1, '@Image1开场', 7],
    ['第二行', '第一行\n尾@', 5, 12, '第一行\n尾@Image12', 13],
  ])('%s：那个 @ 换成引用，其余原样，光标落在引用之后', (_, text, at, frame, next, cursor) => {
    expect(textAfterMention(text, at, frame)).toEqual({ text: next, cursor })
  })

  it('只换 at 处的那个 @，已有的引用与别的 @ 不动', () => {
    expect(textAfterMention('@Image1 看 @ 与 @', 10, 2)).toEqual({
      text: '@Image1 看 @Image2 与 @',
      cursor: 17,
    })
  })

  it('at 处不是 @ 时不改正文', () => {
    expect(textAfterMention('双肩包 @', 1, 2)).toBeUndefined()
    expect(textAfterMention('', 0, 1)).toBeUndefined()
  })
})

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

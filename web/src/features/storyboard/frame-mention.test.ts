import { describe, expect, it } from 'vitest'
import { textAfterMention } from './frame-mention'

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

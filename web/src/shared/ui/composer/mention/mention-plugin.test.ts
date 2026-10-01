import { describe, expect, it } from 'vitest'
import { opensMention } from './mention-plugin'

describe('opensMention', () => {
  const typed = { composing: false, editable: true, text: '@' }

  it('可编辑时键入一个 @ 就打开，前面是中文、空格还是行首都一样', () => {
    expect(opensMention(typed)).toBe(true)
  })

  it.each([
    ['只读', { ...typed, editable: false }],
    ['输入法组合中', { ...typed, composing: true }],
    ['全角＠', { ...typed, text: '＠' }],
    ['一次进来多个字符', { ...typed, text: '@@' }],
    ['其它字符', { ...typed, text: 'a' }],
  ])('%s不打开', (_, input) => {
    expect(opensMention(input)).toBe(false)
  })
})

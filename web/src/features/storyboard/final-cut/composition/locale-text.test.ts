import { describe, expect, it } from 'vitest'
import { localeBindingsOf, localizedHostValues, pinnedByDefault } from './locale-text'

describe('localizedHostValues', () => {
  const defaults = new Map<string, unknown>([
    ['txt_t1_title', '早秋亚麻'],
    ['txt_t1_sub', '松弛感'],
    ['txt_t2_text', '新品上市'],
  ])

  it('随语言的字段换成值表里的字，值表里没有的用根变量的默认值；固定的字段、别的可填项不动', () => {
    const localized = localizedHostValues(
      [
        {
          id: 't1',
          values: { title: '早秋亚麻', sub: '松弛感', brand: 'AUTUMN LINEN', size: 96 },
          bindings: { title: 'txt_t1_title', sub: 'txt_t1_sub' },
        },
      ],
      { txt_t1_title: 'Autumn Linen', cap_a1: 'Hello' },
      defaults,
    )
    expect(localized).toEqual(
      new Map([['t1', { title: 'Autumn Linen', sub: '松弛感', brand: 'AUTUMN LINEN', size: 96 }]]),
    )
  })

  it('宿主上没填的字段（用条目的默认值）也写上这种语言的字', () => {
    const localized = localizedHostValues(
      [{ id: 't2', values: {}, bindings: { text: 'txt_t2_text' } }],
      { txt_t2_text: 'New in' },
      defaults,
    )
    expect(localized.get('t2')).toEqual({ text: 'New in' })
  })

  it('没有随语言字段的宿主（含字幕宿主）不在答复里；值表里的值不是字符串、根上也没声明时照旧', () => {
    const localized = localizedHostValues(
      [
        { id: 'captions', values: {}, bindings: {} },
        { id: 'plain', values: { text: '固定的字' }, bindings: {} },
        { id: 't3', values: { text: '原来的' }, bindings: { text: 'txt_t3_text' } },
      ],
      { txt_t3_text: 42 },
      defaults,
    )
    expect(localized).toEqual(new Map([['t3', { text: '原来的' }]]))
  })
})

describe('localeBindingsOf', () => {
  it('读字段到根变量的对应；没写、不是 JSON 对象、值不是字符串时都当作没有', () => {
    expect(localeBindingsOf('{"title":"txt_t1_title"}')).toEqual({ title: 'txt_t1_title' })
    for (const json of [undefined, '', '[]', 'null', '{"title":1}', '{oops'])
      expect(localeBindingsOf(json)).toEqual({})
  })
})

describe('pinnedByDefault', () => {
  it('全是西文且有字母的默认固定，有中文的、只有数字符号的默认随语言', () => {
    for (const text of ['AUTUMN LINEN', 'NEW IN · AW26', 'iClip Studio', ' Brand — 2026 '])
      expect(pinnedByDefault(text)).toBe(true)
    for (const text of ['松弛感早秋亚麻系列', '¥ 299 · 透气垂顺', '100% 法国亚麻', '2026', ''])
      expect(pinnedByDefault(text)).toBe(false)
  })
})

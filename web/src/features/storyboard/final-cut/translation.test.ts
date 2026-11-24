import { describe, expect, it } from 'vitest'
import { caption, fixtureCatalog, host, video } from '@/testing/final-cut'
import {
  pendingTranslations,
  TRANSLATION_LIMITS,
  translateBlocked,
  translationBatches,
  translationsToWrite,
  type TranslationEntry,
} from './translation'

const LIMITS = { entries: 3, text: 10, total: 12 }

/** 两句字幕、一个贴片（文字随语言）、一个贴片（文字固定）。 */
const clips = [
  video(),
  host({ id: 'zh', values: { text: '新品上市' } }),
  host({ id: 'latin', values: { text: 'NEW IN' } }),
  caption({ id: 'cap-a1', variable: 'cap_a1', text: '第一句' }),
  caption({ id: 'cap-b2', variable: 'cap_b2', text: '第二句' }),
]
const bindings = new Map([['zh', { text: 'txt_zh_text' }]])

describe('收集要翻的文字', () => {
  it('收字幕和随语言的字段里值表还没有的，固定的字段不收；`total` 连已翻的一起算', () => {
    expect(
      pendingTranslations({ clips, bindings, values: { cap_a1: 'Line one' } }, fixtureCatalog),
    ).toEqual({
      entries: [
        { id: 'txt_zh_text', text: '新品上市' },
        { id: 'cap_b2', text: '第二句' },
      ],
      tooLong: 0,
      total: 3,
    })
  })

  it('随语言的字段没填时收条目的默认值；值表里写成空字符串的算翻过', () => {
    const plain = [host({ id: 'zh' })]
    expect(
      pendingTranslations({ clips: plain, bindings, values: {} }, fixtureCatalog).entries,
    ).toEqual([{ id: 'txt_zh_text', text: '示例文字' }])
    expect(
      pendingTranslations({ clips: plain, bindings, values: { txt_zh_text: '' } }, fixtureCatalog),
    ).toEqual({ entries: [], tooLong: 0, total: 1 })
  })

  it('原文是空白、字幕没有变量的不算；没有字幕、没有随语言的字段时什么都没有', () => {
    const blank = [
      caption({ id: 'cap-a1', variable: 'cap_a1', text: '  \n' }),
      caption({ id: 'cap-x', variable: '', text: '没有变量' }),
    ]
    expect(pendingTranslations({ clips: blank, bindings, values: {} }, fixtureCatalog)).toEqual({
      entries: [],
      tooLong: 0,
      total: 0,
    })
    expect(
      pendingTranslations(
        { clips: [video(), host({ id: 'latin' })], bindings: new Map(), values: {} },
        fixtureCatalog,
      ),
    ).toEqual({ entries: [], tooLong: 0, total: 0 })
  })

  it('超过单条上限的不收，单独计数', () => {
    const long = [
      caption({ id: 'cap-a1', variable: 'cap_a1', text: '十个字十个字十个字十' }),
      caption({ id: 'cap-b2', variable: 'cap_b2', text: '十一个字十一个字十一个' }),
    ]
    expect(
      pendingTranslations({ clips: long, bindings, values: {} }, fixtureCatalog, LIMITS),
    ).toEqual({
      entries: [{ id: 'cap_a1', text: '十个字十个字十个字十' }],
      tooLong: 1,
      total: 2,
    })
  })

  it('单条上限读的是合同里的', () => {
    expect(TRANSLATION_LIMITS).toEqual({ entries: 200, text: 500, total: 4000 })
  })
})

const entry = (id: string, length: number): TranslationEntry => ({ id, text: '字'.repeat(length) })
const ids = (batches: TranslationEntry[][]) => batches.map((batch) => batch.map((each) => each.id))

describe('分批', () => {
  it('条数到上限就换一批', () => {
    const entries = ['a', 'b', 'c', 'd'].map((id) => entry(id, 1))
    expect(ids(translationBatches(entries, LIMITS))).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('合计字数正好到上限还在这一批，多一个字就换一批', () => {
    expect(ids(translationBatches([entry('a', 6), entry('b', 6)], LIMITS))).toEqual([['a', 'b']])
    expect(ids(translationBatches([entry('a', 6), entry('b', 7)], LIMITS))).toEqual([['a'], ['b']])
  })

  it('没有要翻的时一批都没有', () => {
    expect(translationBatches([], LIMITS)).toEqual([])
  })
})

describe('写回', () => {
  const sent = [entry('a', 2), entry('b', 2), entry('c', 2)]
  const translated = sent.map(({ id }) => ({ id, text: `[EN] ${id}` }))

  it('写入那一刻还没翻、原文没变的都写', () => {
    expect(translationsToWrite(sent, translated, sent)).toEqual(
      new Map([
        ['a', '[EN] a'],
        ['b', '[EN] b'],
        ['c', '[EN] c'],
      ]),
    )
  })

  it('翻译期间填了、删掉了、改了原文的跳过', () => {
    // a 已经填了（不再待翻），b 删掉了，c 的原文改了
    const now = [{ id: 'c', text: '改过' }]
    expect(translationsToWrite(sent, translated, now)).toEqual(new Map())
    expect(translationsToWrite(sent, translated, [sent[1] as TranslationEntry])).toEqual(
      new Map([['b', '[EN] b']]),
    )
  })

  it('答复里没发过的不写', () => {
    expect(translationsToWrite(sent, [{ id: 'z', text: 'x' }], [entry('z', 2)])).toEqual(new Map())
  })
})

describe('「翻译」为什么不能点', () => {
  it('有要翻的时能点；翻译中不能点', () => {
    expect(translateBlocked({ entries: [1], tooLong: 0, total: 1 }, 'en', false)).toBe(undefined)
    expect(translateBlocked({ entries: [1], tooLong: 0, total: 1 }, 'en', true)).toBeTruthy()
  })

  it('都翻过了、剩下的都超长、什么都没有：各给出非空原因，且携带语言名或条数', () => {
    const enDone = translateBlocked({ entries: [], tooLong: 0, total: 2 }, 'en', false)
    const zhDone = translateBlocked({ entries: [], tooLong: 0, total: 2 }, 'zh', false)
    const tooLong = translateBlocked({ entries: [], tooLong: 2, total: 3 }, 'en', false)
    const empty = translateBlocked({ entries: [], tooLong: 0, total: 0 }, 'en', false)
    expect(enDone).toContain('English ')
    expect(zhDone).toContain('中文')
    expect(tooLong).toContain('2')
    expect(tooLong).toContain('500')
    expect(empty).toBeTruthy()
    expect(new Set([enDone, tooLong, empty]).size).toBe(3)
  })
})

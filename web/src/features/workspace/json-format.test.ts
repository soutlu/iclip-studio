import { describe, expect, it } from 'vitest'
import {
  collapsedBelowRoot,
  defaultCollapsed,
  layoutJson,
  type JsonLine,
  type JsonValue,
} from './json-format'

/** 照视图的画法把行拼回文本：缩进 2 格一层，键名与值都按 JSON 写法。 */
const textOf = (lines: JsonLine[]): string =>
  lines
    .map((line) => {
      const key = line.key === undefined ? '' : `${JSON.stringify(line.key)}: `
      const { body } = line
      const main =
        body.type === 'value'
          ? JSON.stringify(body.value)
          : body.type === 'empty' || body.type === 'folded'
            ? body.brackets
            : body.bracket
      const count = body.type === 'folded' ? ` ${body.count} 项` : ''
      return `${'  '.repeat(line.depth)}${key}${main}${line.comma ? ',' : ''}${count}`
    })
    .join('\n')

const SAMPLE: JsonValue = {
  aspect_ratio: '9:16',
  empty: {},
  none: [],
  shots: [
    { index: 1, ok: true, prompt: { timeline: [{ timestamps: [0, 6] }] }, tag: null },
    { index: 2, ok: false, prompt: { timeline: [] }, tag: 'a"b\nc' },
  ],
}

/** 生成格式化后恰好 n 行的对象：{ items: [{ v: 0 }, …] }，每个元素占 3 行，外面 4 行。 */
const withLines = (n: number): JsonValue => {
  const items = Array.from({ length: Math.floor((n - 4) / 3) }, (_, v) => ({ v }))
  const extra = (n - 4) % 3
  return { items, ...(extra >= 1 ? { a: 1 } : {}), ...(extra >= 2 ? { b: 2 } : {}) }
}

describe('layoutJson', () => {
  it('全部展开时与 JSON.stringify(value, null, 2) 逐行一致：引号、括号、逗号与 2 格缩进都在', () => {
    expect(textOf(layoutJson(SAMPLE, new Set()))).toBe(JSON.stringify(SAMPLE, null, 2))
  })

  it('收起的容器排成一行 {…} / […]，逗号紧跟括号，后面是项数', () => {
    const text = textOf(layoutJson(SAMPLE, new Set(['/shots/0', '/shots/1/prompt'])))

    expect(text).toContain('    {…}, 4 项\n')
    expect(text).toContain('      "prompt": {…}, 1 项\n')
    expect(text).not.toContain('"timestamps"')
  })

  it('空对象与空数组没有可收起的一层，照原样一行', () => {
    const lines = layoutJson(SAMPLE, new Set())
    const empties = lines.filter((line) => line.body.type === 'empty').map((line) => line.key)

    expect(empties).toEqual(['empty', 'none', 'timeline'])
  })

  it('可收起的行带读屏名：对象成员接 .键名，数组元素接 [下标]，根叫「根」', () => {
    const labels = layoutJson(SAMPLE, new Set()).flatMap((line) =>
      line.body.type === 'open' ? [line.body.label] : [],
    )

    expect(labels).toEqual([
      '根',
      'shots',
      'shots[0]',
      'shots[0].prompt',
      'shots[0].prompt.timeline',
      'shots[0].prompt.timeline[0]',
      'shots[0].prompt.timeline[0].timestamps',
      'shots[1]',
      'shots[1].prompt',
    ])
  })

  it('键名里带 / 与 ~ 时各自有独立的路径，不会串到别的容器', () => {
    const value: JsonValue = { 'a/b': { x: 1 }, a: { b: { y: 2 } } }
    const lines = layoutJson(value, new Set(['/a~1b']))

    expect(textOf(lines)).toContain('"a/b": {…}, 1 项')
    expect(textOf(lines)).toContain('"y": 2')
  })
})

describe('defaultCollapsed', () => {
  it('格式化后不超过 200 行就全部展开', () => {
    const value = withLines(200)
    expect(JSON.stringify(value, null, 2).split('\n')).toHaveLength(200)

    expect(defaultCollapsed(value).size).toBe(0)
  })

  it('超过 200 行只展开根与第一层，第二层起都收起', () => {
    const value = withLines(201)
    expect(JSON.stringify(value, null, 2).split('\n')).toHaveLength(201)

    const collapsed = defaultCollapsed(value)

    expect(collapsed.has('')).toBe(false)
    expect(collapsed.has('/items')).toBe(false)
    expect(collapsed.has('/items/0')).toBe(true)
    expect(textOf(layoutJson(value, collapsed)).split('\n')[2]).toBe('    {…}, 1 项')
  })
})

describe('collapsedBelowRoot', () => {
  it('「全部收起」只留根展开，第一层起的非空容器都收起', () => {
    const lines = layoutJson(SAMPLE, collapsedBelowRoot(SAMPLE))

    expect(textOf(lines)).toBe(
      [
        '{',
        '  "aspect_ratio": "9:16",',
        '  "empty": {},',
        '  "none": [],',
        '  "shots": […] 2 项',
        '}',
      ].join('\n'),
    )
  })

  it('根下面没有可收起的层级时为空', () => {
    expect(collapsedBelowRoot({ a: 1, b: [] }).size).toBe(0)
    expect(collapsedBelowRoot('plain').size).toBe(0)
  })
})

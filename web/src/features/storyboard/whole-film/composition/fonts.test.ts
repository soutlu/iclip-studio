import { describe, expect, it } from 'vitest'
import type { CatalogFont, ComponentCatalog } from './catalog'
import { cjkFontFaces } from './fonts'

const files = (slice: string) => ({
  '400': `vendor/npm/noto/files/noto-${slice}-400-normal.woff2`,
  '700': `vendor/npm/noto/files/noto-${slice}-700-normal.woff2`,
})

const catalogOf = (fonts: Record<string, CatalogFont> = {}): ComponentCatalog => ({
  version: 'test',
  runtime: { hyperframes: '', gsap: '' },
  cjk: {
    family: 'Noto Sans SC',
    slices: [
      { range: 'U+0041, U+4e00-4e10, U+ff01', files: files('4') },
      { range: 'U+3001-3002', files: files('5') },
      { range: 'U+0042-0043', files: files('6') },
      { range: 'U+20000-20002', files: files('7') },
      { range: 'U+9f98', files: { '400': 'vendor/npm/noto/files/noto-8-400-normal.woff2' } },
      { range: 'U+2014, U+4e2d', files: files('9') },
      { range: 'U+0000-00ff', files: files('latin') },
    ],
  },
  fonts,
  categories: [],
  items: [],
  excluded: [],
})

const parseRules = (css: string) =>
  [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(([, body = '']) => {
    const value = (name: string) => new RegExp(`${name}:([^;]+)`).exec(body)?.[1]
    return {
      family: value('font-family'),
      weight: value('font-weight'),
      style: value('font-style'),
      display: value('font-display'),
      src: /url\(([^)]+)\)/.exec(body)?.[1]?.replace('vendor/npm/noto/files/noto-', ''),
      range: value('unicode-range'),
    }
  })

const slicesIn = (css: string, family = "'Noto Sans SC'") => [
  ...new Set(
    parseRules(css)
      .filter((rule) => rule.family === family)
      .map((rule) => rule.src?.split('-')[0]),
  ),
]

describe('cjkFontFaces · 中文字体自己的规则', () => {
  it('没有中文的成片也带上画西文基本字符的分片，每个字重一条', () => {
    const rules = parseRules(cjkFontFaces(catalogOf(), '', []))
    expect(rules.map((rule) => [rule.weight, rule.src])).toEqual([
      ['400', 'latin-400-normal.woff2'],
      ['700', 'latin-700-normal.woff2'],
    ])
    expect(rules.every((rule) => rule.family === "'Noto Sans SC'")).toBe(true)
    expect(rules.every((rule) => rule.style === 'normal' && rule.display === 'block')).toBe(true)
    expect(rules[0]?.range).toBe('U+20-7e')
  })

  it('只带文字用到的分片，按分片表的顺序、先 400 再 700', () => {
    const rules = parseRules(cjkFontFaces(catalogOf(), '一、', []))
    expect(rules.map((rule) => [rule.weight, rule.src])).toEqual([
      ['400', '4-400-normal.woff2'],
      ['400', '5-400-normal.woff2'],
      ['400', 'latin-400-normal.woff2'],
      ['700', '4-700-normal.woff2'],
      ['700', '5-700-normal.woff2'],
      ['700', 'latin-700-normal.woff2'],
    ])
    expect(slicesIn(cjkFontFaces(catalogOf(), '一', []))).toEqual(['4', 'latin'])
  })

  it('每条规则的范围只写用到的字，连着的码位并成一段，重复的字只算一次', () => {
    const rangeOf = (text: string, slice: string) =>
      parseRules(cjkFontFaces(catalogOf(), text, [])).find((rule) =>
        rule.src?.startsWith(`${slice}-`),
      )?.range
    expect(rangeOf('一、', '4')).toBe('U+4e00')
    expect(rangeOf('一、', '5')).toBe('U+3001')
    expect(rangeOf('丂一丁一！', '4')).toBe('U+4e00-4e02,U+ff01')
    expect(rangeOf('—中', '9')).toBe('U+2014,U+4e2d')
  })

  it('几个分片都有的字只带声明最靠后的那个：浏览器用的就是它', () => {
    expect(slicesIn(cjkFontFaces(catalogOf(), 'ABC', []))).toEqual(['latin'])
  })

  it('U+20000 以上的字按码位找分片，不按 UTF-16 的两半找', () => {
    expect(slicesIn(cjkFontFaces(catalogOf(), '\u{20001}', []))).toContain('7')
    expect(slicesIn(cjkFontFaces(catalogOf(), '\ud840', []))).not.toContain('7')
  })

  it('分片缺某个字重的文件时只出有文件的那条', () => {
    const rules = parseRules(cjkFontFaces(catalogOf(), '龘', [])).filter((rule) =>
      rule.src?.startsWith('8-'),
    )
    expect(rules.map((rule) => rule.weight)).toEqual(['400'])
  })

  it('分片表不变时同样的文字出同样的规则', () => {
    const catalog = catalogOf()
    expect(cjkFontFaces(catalog, '一、', [])).toBe(cjkFontFaces(catalog, '一、', []))
  })
})

describe('cjkFontFaces · 西文字体族的中文孪生规则', () => {
  const twins = (css: string, family: string) =>
    parseRules(css).filter((rule) => rule.family === `'${family}'`)

  it('Inter 300–900：每种字重各一组，549 以下用 Noto 400、以上用 700', () => {
    const weights = ['300', '400', '500', '600', '700', '800', '900']
    const catalog = catalogOf({
      Inter: { css: 'inter.css', cjk: weights.map((weight) => ({ weight, style: 'normal' })) },
    })
    const rules = twins(cjkFontFaces(catalog, '一、', ['Inter']), 'Inter')

    expect(rules).toHaveLength(weights.length * 2)
    for (const rule of rules) {
      const glyphs = Number(rule.weight) < 550 ? 400 : 700
      expect(rule.src).toMatch(new RegExp(`^[45]-${glyphs}-normal\\.woff2$`))
      expect(rule.style).toBe('normal')
    }
    expect(new Set(rules.map((rule) => rule.weight))).toEqual(new Set(weights))
    const forSlice = (slice: string) => rules.find((rule) => rule.src?.startsWith(`${slice}-`))
    expect(forSlice('4')?.range).toBe('U+4e00')
    expect(forSlice('5')?.range).toBe('U+3001')
  })

  it('孪生规则的范围只留中日韩区块里的字；一片里用到的字都不在区块里就不出', () => {
    const catalog = catalogOf({
      Inter: { css: 'inter.css', cjk: [{ weight: '400', style: 'normal' }] },
    })
    const ranges = (text: string) =>
      twins(cjkFontFaces(catalog, text, ['Inter']), 'Inter').map((rule) => rule.range)
    expect(ranges('—中')).toEqual(['U+4e2d'])
    expect(ranges('—')).toEqual([])
  })

  it('文字没用到的分片不出孪生规则', () => {
    const catalog = catalogOf({
      Inter: { css: 'inter.css', cjk: [{ weight: '400', style: 'normal' }] },
    })
    const srcs = (text: string) =>
      twins(cjkFontFaces(catalog, text, ['Inter']), 'Inter').map((rule) => rule.src)
    expect(srcs('')).toEqual([])
    expect(srcs('一')).toEqual(['4-400-normal.woff2'])
  })

  it('斜体照描述写 italic，字形用正体', () => {
    const catalog = catalogOf({
      Inter: { css: 'inter.css', cjk: [{ weight: '600', style: 'italic' }] },
    })
    const rules = twins(cjkFontFaces(catalog, '一、', ['Inter']), 'Inter')
    expect(rules).toHaveLength(2)
    expect(rules.every((rule) => rule.style === 'italic' && rule.weight === '600')).toBe(true)
    expect(rules.every((rule) => rule.src?.endsWith('-700-normal.woff2'))).toBe(true)
  })

  it('可变字体：字重区间原样照抄，按区间下限取 Noto 400', () => {
    const catalog = catalogOf({
      'Roboto Flex': { css: 'roboto-flex.css', cjk: [{ weight: '100 1000', style: 'normal' }] },
    })
    const rules = twins(cjkFontFaces(catalog, '一、', ['Roboto Flex']), 'Roboto Flex')
    expect(rules).toHaveLength(2)
    expect(rules.every((rule) => rule.weight === '100 1000')).toBe(true)
    expect(rules.every((rule) => rule.src?.endsWith('-400-normal.woff2'))).toBe(true)
  })

  it('只给成片用到的字体族出；目录里没写孪生描述的品牌字体不出', () => {
    const catalog = catalogOf({
      Inter: { css: 'inter.css', cjk: [{ weight: '400', style: 'normal' }] },
      Anton: { css: 'anton.css', cjk: [{ weight: '400', style: 'normal' }] },
      Brand: { css: 'brand.css', brand: 'BR' },
    })
    const css = cjkFontFaces(catalog, '一', ['Brand', 'Inter'])
    expect(new Set(parseRules(css).map((rule) => rule.family))).toEqual(
      new Set(["'Noto Sans SC'", "'Inter'"]),
    )
  })
})

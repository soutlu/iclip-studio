import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FONT_VARIABLE,
  SyncError,
  WEB_ROOT,
  checkCatalogFonts,
  cjkTwinFaces,
  fontFaceDescriptors,
  localFontFaces,
  publishedCatalog,
} from './hyperframes-shared.mjs'

/** 生成的 @font-face 拆成 { family, weight, style, src, range }，便于逐条比对。 */
const parseRules = (css) =>
  [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(([, body]) => {
    const value = (name) => new RegExp(`${name}:([^;]+)`).exec(body)?.[1]
    return {
      family: value('font-family'),
      weight: value('font-weight'),
      style: value('font-style'),
      src: /url\(([^)]+)\)/.exec(body)?.[1],
      range: value('unicode-range'),
    }
  })

// 假的 Noto Sans SC 包：两个中文分片、一个没有中日韩码位的分片、一个拉丁子集。
let notoDir
beforeAll(async () => {
  notoDir = await mkdtemp(join(tmpdir(), 'hf-noto-'))
  await writeFile(join(notoDir, 'metadata.json'), JSON.stringify({ id: 'noto-sans-sc' }))
  await writeFile(
    join(notoDir, 'unicode.json'),
    JSON.stringify({
      '[4]': 'U+0041, U+4e00-4e10, U+ff01',
      '[5]': 'U+3001-3002',
      '[6]': 'U+0042-0043',
      latin: 'U+0000-00ff',
    }),
  )
})
afterAll(() => rm(notoDir, { recursive: true, force: true }))

const NOTO = '../../npm/@fontsource/noto-sans-sc@5.3.1/files/noto-sans-sc'

describe('fontFaceDescriptors', () => {
  it('取每条 @font-face 的字体名、字重与字形；normal/bold 换成数字，区间原样，缺省 400 normal', () => {
    const css = `
      @font-face { font-family: 'Inter'; font-weight: 600; font-style: italic; src: url(a.woff2) }
      @font-face{font-family:"Roboto Flex";font-weight:100 1000;src:url(b.woff2)}
      @font-face { font-family: ClaudeSans; font-weight: bold; src: url(c.woff2) }
      @font-face { font-family: ClaudeSans; src: url(d.woff2) }
      @font-face { src: url(no-family.woff2) }
      .title { font-family: Inter; font-weight: 800 }`
    expect(fontFaceDescriptors(css)).toEqual([
      { family: 'Inter', weight: '600', style: 'italic' },
      { family: 'Roboto Flex', weight: '100 1000', style: 'normal' },
      { family: 'ClaudeSans', weight: '700', style: 'normal' },
      { family: 'ClaudeSans', weight: '400', style: 'normal' },
    ])
  })
})

describe('cjkTwinFaces', () => {
  it('Inter 300–900：每种字重各一组描述完全相同的中文字形，549 以下用 Noto 400、以上用 700', async () => {
    const weights = ['300', '400', '500', '600', '700', '800', '900']
    const descriptors = weights.map((weight) => ({ family: 'Inter', weight, style: 'normal' }))
    const rules = parseRules(await cjkTwinFaces('Inter', descriptors, notoDir))

    // 只有带中日韩码位的分片出字形：[4]、[5] 各一条，[6] 与拉丁子集没有。
    expect(rules).toHaveLength(weights.length * 2)
    expect(new Set(rules.map((rule) => rule.weight))).toEqual(new Set(weights))
    for (const rule of rules) {
      expect(rule.family).toBe("'Inter'")
      expect(rule.style).toBe('normal')
      // 字重是单值，不是区间：区间会和西文字形分到两组，把西文挤掉。
      expect(rule.weight).toMatch(/^\d+$/)
      const notoWeight = Number(rule.weight) < 550 ? 400 : 700
      expect(rule.src).toMatch(new RegExp(`^${NOTO}-[45]-${notoWeight}-normal\\.woff2$`))
    }
    const forSlice = (slice) => rules.find((rule) => rule.src.includes(`-${slice}-`))
    // unicode-range 收窄到中日韩码位，拉丁字母不在内。
    expect(forSlice(4).range).toBe('U+4e00-4e10,U+ff01')
    expect(forSlice(5).range).toBe('U+3001-3002')
  })

  it('同一描述出现多次只出一组；斜体照描述写 italic，字形用正体', async () => {
    const rules = parseRules(
      await cjkTwinFaces(
        'Inter',
        [
          { family: 'Inter', weight: '600', style: 'italic' },
          { family: 'Inter', weight: '600', style: 'italic' },
        ],
        notoDir,
      ),
    )
    expect(rules).toHaveLength(2)
    expect(rules.every((rule) => rule.style === 'italic' && rule.weight === '600')).toBe(true)
    expect(rules.every((rule) => rule.src.endsWith('-700-normal.woff2'))).toBe(true)
  })

  it('可变字体：字重区间原样照抄，按区间下限取 Noto 400', async () => {
    const rules = parseRules(
      await cjkTwinFaces(
        'Roboto Flex',
        [{ family: 'Roboto Flex', weight: '100 1000', style: 'normal' }],
        notoDir,
      ),
    )
    expect(rules).toHaveLength(2)
    expect(rules.every((rule) => rule.weight === '100 1000')).toBe(true)
    expect(rules.every((rule) => rule.src.endsWith('-400-normal.woff2'))).toBe(true)
  })

  it('只在组件里自带 @font-face 的字体（没有 Google Fonts 西文）：按组件写的描述出中文字形', async () => {
    const component = `
      <style>
        @font-face { font-family: 'ClaudeSans'; font-weight: 400; src: url(fonts/claude-400.woff2) }
        @font-face { font-family: 'ClaudeSans'; font-weight: 500; src: url(fonts/claude-500.woff2) }
        @font-face { font-family: 'ClaudeSans'; font-weight: 600; src: url(fonts/claude-600.woff2) }
        @font-face { font-family: 'Other'; font-weight: 900; src: url(fonts/other.woff2) }
      </style>`
    const descriptors = fontFaceDescriptors(component).filter(
      (face) => face.family === 'ClaudeSans',
    )
    const rules = parseRules(await cjkTwinFaces('ClaudeSans', descriptors, notoDir))
    // 只出中文字形：全是 ClaudeSans、全指向 Noto，不带别的字体、不带西文。
    expect(rules.every((rule) => rule.family === "'ClaudeSans'")).toBe(true)
    expect(rules.map((rule) => [rule.weight, rule.src.replace(NOTO, '')])).toEqual([
      ['400', '-4-400-normal.woff2'],
      ['400', '-5-400-normal.woff2'],
      ['500', '-4-400-normal.woff2'],
      ['500', '-5-400-normal.woff2'],
      ['600', '-4-700-normal.woff2'],
      ['600', '-5-700-normal.woff2'],
    ])
  })
})

describe('publishedCatalog', () => {
  const entry = (name, variables = []) => ({ name, src: `compositions/${name}.html`, variables })
  const files = {
    'compositions/title.html': '.t { font-family: var(--font-display, Inter), sans-serif }',
    'compositions/body.html': '.b { font: 400 40px var( --font-body, Inter) }',
    'compositions/mono.html': '.m { font-family: var(--font-mono, monospace) }',
    'compositions/plain.html': '.p { font-family: Inter }',
    'compositions/own.html': '.o { font-family: var(--font-display, Inter) }',
  }
  const source = {
    runtime: {},
    fonts: {
      Inter: { css: 'vendor/fonts/families/inter.css' },
      Brand: {
        css: 'vendor/fonts/families/brand.css',
        brand: 'BR',
        faces: [{ file: 'fonts/brand.ttf', weight: 400, style: 'normal' }],
      },
    },
    categories: [],
    items: [
      entry('title', [{ id: 'text', type: 'string', label: '文字', default: 'A' }]),
      entry('body'),
      entry('mono'),
      entry('plain'),
      entry('own', [{ id: 'font', type: 'font', label: '字体', default: 'Brand' }]),
    ],
    excluded: [],
  }

  it('读了 --font-display 或 --font-body 的条目在最后加上字体项，自己写了的原样；字体去掉 faces', async () => {
    const published = await publishedCatalog(source, 'v1', async (src) => files[src])
    expect(published.version).toBe('v1')
    expect(Object.fromEntries(published.items.map((item) => [item.name, item.variables]))).toEqual({
      title: [source.items[0].variables[0], FONT_VARIABLE],
      body: [FONT_VARIABLE],
      mono: [],
      plain: [],
      own: source.items[4].variables,
    })
    expect(FONT_VARIABLE).toEqual({ id: 'font', type: 'font', label: '字体', default: '' })
    expect(published.fonts).toEqual({
      Inter: { css: 'vendor/fonts/families/inter.css' },
      Brand: { css: 'vendor/fonts/families/brand.css', brand: 'BR' },
    })
  })
})

describe('checkCatalogFonts', () => {
  it.each([
    ['只写 CSS 路径的旧写法', { Inter: 'vendor/fonts/families/inter.css' }],
    ['没有 css', { Inter: { brand: 'BR' } }],
    ['css 不在 vendor/fonts/families/ 下', { Inter: { css: 'vendor/fonts/inter.css' } }],
  ])('%s：报错', (_, fonts) => {
    expect(() => checkCatalogFonts(fonts)).toThrow(SyncError)
  })

  it('{ css, brand?, faces? } 照收', () => {
    expect(() =>
      checkCatalogFonts({
        Inter: { css: 'vendor/fonts/families/inter.css' },
        Brand: { css: 'vendor/fonts/families/brand.css', brand: 'BR', faces: [] },
      }),
    ).not.toThrow()
  })
})

describe('localFontFaces', () => {
  // 一个真实的 woff2（web 依赖里的 MiSans 西文字体），只拷进临时目录，不入库。
  const FONT_FILE = join(WEB_ROOT, 'node_modules/misans/lib/Latin/MiSansLatin-Regular.woff2')
  let work
  let libraryDir
  let outDir
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'hf-local-font-'))
    libraryDir = join(work, 'library')
    outDir = join(work, 'out')
    await mkdir(join(libraryDir, 'fonts/brand'), { recursive: true })
    await writeFile(join(libraryDir, 'fonts/brand/brand.woff2'), await readFile(FONT_FILE))
    await writeFile(join(libraryDir, 'fonts/brand/brand-bold.ttf'), 'ttf')
  })
  afterAll(() => rm(work, { recursive: true, force: true }))

  const faces = [
    { file: 'fonts/brand/brand.woff2', weight: 400, style: 'normal' },
    { file: 'fonts/brand/brand-bold.ttf', weight: 700, style: 'italic' },
  ]

  it('每个字重、字形一条 @font-face（font-display: block），字体文件拷进输出目录的同一路径', async () => {
    const { css, descriptors } = await localFontFaces({
      family: 'Brand Sans',
      faces,
      cssPath: 'vendor/fonts/families/brand-sans.css',
      libraryDir,
      outDir,
    })
    expect(css.split('\n')).toEqual([
      "@font-face{font-family:'Brand Sans';font-style:normal;font-display:block;font-weight:400;" +
        "src:url(../../../fonts/brand/brand.woff2) format('woff2')}",
      "@font-face{font-family:'Brand Sans';font-style:italic;font-display:block;font-weight:700;" +
        "src:url(../../../fonts/brand/brand-bold.ttf) format('truetype')}",
    ])
    expect(descriptors).toEqual([
      { family: 'Brand Sans', weight: '400', style: 'normal' },
      { family: 'Brand Sans', weight: '700', style: 'italic' },
    ])
    expect(await readFile(join(outDir, 'fonts/brand/brand.woff2'))).toEqual(
      await readFile(FONT_FILE),
    )
    expect(await readFile(join(outDir, 'fonts/brand/brand-bold.ttf'), 'utf8')).toBe('ttf')
  })

  it.each([
    ['没有 faces', []],
    ['文件不在 fonts/ 下', [{ file: 'patches/brand.woff2', weight: 400, style: 'normal' }]],
    ['跳出 fonts/', [{ file: 'fonts/../catalog.json', weight: 400, style: 'normal' }]],
    ['文件不存在', [{ file: 'fonts/brand/missing.woff2', weight: 400, style: 'normal' }]],
    ['格式认不出', [{ file: 'fonts/brand/brand.svg', weight: 400, style: 'normal' }]],
  ])('%s：报错', async (_, bad) => {
    await expect(
      localFontFaces({
        family: 'Brand Sans',
        faces: bad,
        cssPath: 'vendor/fonts/families/brand-sans.css',
        libraryDir,
        outDir,
      }),
    ).rejects.toThrow(SyncError)
  })
})

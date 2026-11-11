import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CJK_FONT,
  FONT_VARIABLE,
  SyncError,
  WEB_ROOT,
  checkCatalogFonts,
  cjkSlices,
  componentChars,
  fontFaceDescriptors,
  localFontFaces,
  publishedCatalog,
  twinDescriptors,
  withoutCjkStylesheet,
} from './hyperframes-shared.mjs'

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
  await mkdir(join(notoDir, 'files'))
  for (const file of ['4-400', '4-700', '5-400', 'latin-400', 'latin-700']) {
    await writeFile(join(notoDir, 'files', `noto-sans-sc-${file}-normal.woff2`), '')
  }
})
afterAll(() => rm(notoDir, { recursive: true, force: true }))

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

describe('cjkSlices', () => {
  it('按字体包的子集顺序列出分片：完整的 unicode-range 和每个字重的文件；一个文件都没有的子集不列', async () => {
    const pkg = { name: '@fontsource/noto-sans-sc', version: '5.3.1' }
    const npm = 'vendor/npm/@fontsource/noto-sans-sc@5.3.1/files/noto-sans-sc'
    const { slices, files } = await cjkSlices(notoDir, pkg)
    expect(slices).toEqual([
      {
        range: 'U+0041, U+4e00-4e10, U+ff01',
        files: { 400: `${npm}-4-400-normal.woff2`, 700: `${npm}-4-700-normal.woff2` },
      },
      { range: 'U+3001-3002', files: { 400: `${npm}-5-400-normal.woff2` } },
      {
        range: 'U+0000-00ff',
        files: { 400: `${npm}-latin-400-normal.woff2`, 700: `${npm}-latin-700-normal.woff2` },
      },
    ])
    expect(files).toEqual([
      'files/noto-sans-sc-4-400-normal.woff2',
      'files/noto-sans-sc-4-700-normal.woff2',
      'files/noto-sans-sc-5-400-normal.woff2',
      'files/noto-sans-sc-latin-400-normal.woff2',
      'files/noto-sans-sc-latin-700-normal.woff2',
    ])
  })
})

describe('twinDescriptors', () => {
  it('同一描述出现多次只留一个，顺序照第一次出现；字重区间和斜体原样', () => {
    expect(
      twinDescriptors([
        { family: 'Inter', weight: '600', style: 'italic' },
        { family: 'Inter', weight: '100 1000', style: 'normal' },
        { family: 'Inter', weight: '600', style: 'italic' },
        { family: 'Inter', weight: '600', style: 'normal' },
      ]),
    ).toEqual([
      { weight: '600', style: 'italic' },
      { weight: '100 1000', style: 'normal' },
      { weight: '600', style: 'normal' },
    ])
  })

  it('只在组件里自带 @font-face 的字体（没有 Google Fonts 西文）：按组件写的描述出', () => {
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
    expect(twinDescriptors(descriptors)).toEqual([
      { weight: '400', style: 'normal' },
      { weight: '500', style: 'normal' },
      { weight: '600', style: 'normal' },
    ])
  })
})

describe('withoutCjkStylesheet', () => {
  it('去掉组件文件里链整份中文字体的那一行，别的样式链接留着', () => {
    const html = [
      '<div id="caption">',
      '  <link rel="stylesheet" href="../../vendor/fonts/noto-sans-sc.css" />',
      '  <link rel="stylesheet" href="../../vendor/fonts/883ae2fa2d9f.css" />',
      '  <div class="stage"></div>',
      '</div>',
    ].join('\n')
    expect(withoutCjkStylesheet(html)).toBe(
      [
        '<div id="caption">',
        '  <link rel="stylesheet" href="../../vendor/fonts/883ae2fa2d9f.css" />',
        '  <div class="stage"></div>',
        '</div>',
      ].join('\n'),
    )
  })
})

describe('componentChars', () => {
  it('组件文件里的非 ASCII 字符去重、按码位排序；HTML 注释里的不算', () => {
    const html = `<!-- 说明：这段注释不算 -->
      <p data-var-text="title">示例标题</p>
      <style>.t::after { content: '示例 →' }</style>
      <script>const label = '\u{20001}第 1 例'</script>`
    expect(componentChars(html)).toBe('→例标示第题\u{20001}')
    expect(componentChars('<p>plain ASCII only</p>')).toBe('')
  })
})

describe('publishedCatalog', () => {
  const entry = (name, variables = []) => ({ name, src: `compositions/${name}.html`, variables })
  const slices = [{ range: 'U+4e00-4e10', files: { 400: 'vendor/npm/noto/4-400.woff2' } }]
  const files = {
    [CJK_FONT.faces]: JSON.stringify({
      slices,
      twins: { Inter: [{ weight: '400', style: 'normal' }] },
    }),
    'compositions/title.html':
      '<p>标题</p>.t { font-family: var(--font-display, Inter), sans-serif }',
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
    const published = await publishedCatalog(source, 'v1', async (path) => files[path])
    expect(published.version).toBe('v1')
    expect(Object.fromEntries(published.items.map((item) => [item.name, item.variables]))).toEqual({
      title: [source.items[0].variables[0], FONT_VARIABLE],
      body: [FONT_VARIABLE],
      mono: [],
      plain: [],
      own: source.items[4].variables,
    })
    expect(published.fonts).toEqual({
      Inter: { css: 'vendor/fonts/families/inter.css', cjk: [{ weight: '400', style: 'normal' }] },
      Brand: { css: 'vendor/fonts/families/brand.css', brand: 'BR' },
    })
  })

  it('带上组装时写下的中文分片表和各字体族的孪生描述，每个条目写上组件文件里的非 ASCII 字符', async () => {
    const published = await publishedCatalog(source, 'v1', async (path) => files[path])
    expect(published.cjk).toEqual({ family: 'Noto Sans SC', slices })
    expect(Object.fromEntries(published.items.map((item) => [item.name, item.chars]))).toEqual({
      title: '标题',
      body: '',
      mono: '',
      plain: '',
      own: '',
    })
  })

  it('源目录里还留着的 runtime 原样带过去，不因为多出的键报错', async () => {
    const legacy = {
      ...source,
      runtime: { gsap: 'g.js', cjkFont: 'vendor/fonts/noto-sans-sc.css' },
    }
    const published = await publishedCatalog(legacy, 'v1', async (path) => files[path])
    expect(published.runtime).toEqual(legacy.runtime)
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

  it('每个字重、字形一条 @font-face（font-display: block），不配中文字形；字体文件拷进输出目录的同一路径', async () => {
    const css = await localFontFaces({
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

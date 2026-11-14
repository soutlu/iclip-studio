import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  FONT_TABLE,
  FONT_VARIABLE,
  HF_VERSION,
  RUNTIME,
  SyncError,
  WEB_ROOT,
  checkCatalogFonts,
  checkRelocated,
  cjkSlices,
  componentChars,
  fontFaceDescriptors,
  installVersion,
  localFontFaces,
  publishedCatalog,
  relocate,
  sha256,
  twinDescriptors,
  withAnimationLibrary,
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

describe('withAnimationLibrary', () => {
  const TAG = '<script src="vendor/npm/gsap@3.14.2/dist/gsap.min.js"></script>'

  it('用到动画库却没引用它的组件文件：在第一段脚本前补上引用，缩进跟着那一行', () => {
    const html = [
      '<template>',
      '  <!-- 注释里的不算：<script src="vendor/npm/gsap@3.14.2/dist/gsap.min.js"></script> -->',
      '  <div class="stage"></div>',
      '  <script>',
      '    var tl = gsap.timeline({ paused: true })',
      '  </script>',
      '</template>',
    ].join('\n')
    expect(withAnimationLibrary(html).split('\n')).toEqual([
      '<template>',
      '  <!-- 注释里的不算：<script src="vendor/npm/gsap@3.14.2/dist/gsap.min.js"></script> -->',
      '  <div class="stage"></div>',
      `  ${TAG}`,
      '  <script>',
      '    var tl = gsap.timeline({ paused: true })',
      '  </script>',
      '</template>',
    ])
    expect(withAnimationLibrary('<div></div><script>gsap.set("#a", {})</script>')).toBe(
      `<div></div>${TAG}<script>gsap.set("#a", {})</script>`,
    )
  })

  it('已经引用了动画库、或者根本没用到它的文件原样不动', () => {
    const referenced = `<div></div>\n${TAG}\n<script>gsap.to("#a", {})</script>`
    expect(withAnimationLibrary(referenced)).toBe(referenced)
    const plain = '<div></div>\n<script>document.title = "x"</script>'
    expect(withAnimationLibrary(plain)).toBe(plain)
    const commented = '<div></div>\n<!-- gsap.to() 以前在这里 -->\n<script>void 0</script>'
    expect(withAnimationLibrary(commented)).toBe(commented)
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
  const css = {
    Inter: 'vendor/fonts/families/inter-0123456789ab.css',
    Brand: 'vendor/fonts/families/brand-ba9876543210.css',
  }
  const files = {
    [FONT_TABLE]: JSON.stringify({
      slices,
      twins: { Inter: [{ weight: '400', style: 'normal' }] },
      css,
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

  it('读了 --font-display 或 --font-body 的条目在最后加上字体项，自己写了的原样；字体去掉 faces，样式表路径按字体表写', async () => {
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
      Inter: { css: css.Inter, cjk: [{ weight: '400', style: 'normal' }] },
      Brand: { css: css.Brand, brand: 'BR' },
    })
  })

  it('字体表里缺少某个字体的样式表：报错', async () => {
    const table = JSON.stringify({ slices, twins: {}, css: { Inter: css.Inter } })
    await expect(
      publishedCatalog(source, 'v1', async (path) =>
        path === FONT_TABLE ? table : (files[path] ?? ''),
      ),
    ).rejects.toThrow(SyncError)
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

  it('runtime 写组装结果里运行库与动画库的位置，源目录里写的 runtime 不采用', async () => {
    expect((await publishedCatalog(source, 'v1', async (path) => files[path])).runtime).toEqual(
      RUNTIME,
    )
    const declared = { ...source, runtime: { hyperframes: 'vendor/hyperframes/old.js' } }
    expect((await publishedCatalog(declared, 'v1', async (path) => files[path])).runtime).toEqual(
      RUNTIME,
    )
    // vendor/ 里的运行库路径带引擎版本，换版本就换路径
    expect(RUNTIME.hyperframes).toContain(`/${HF_VERSION}/`)
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

describe('组装目录整理与发布', () => {
  let work
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'hf-relocate-'))
  })
  afterEach(() => rm(work, { recursive: true, force: true }))

  const put = async (root, files) => {
    for (const [path, data] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), data)
    }
  }
  const text = (root, path) => readFile(join(root, path), 'utf8')

  const SCENE = [
    '<img src="assets/icons/a.png">',
    '<div style="background: url(\'assets/bg.jpg\')"></div>',
    '<div style="background: url(assets/bg.jpg)"></div>',
    '<link rel="stylesheet" href="../vendor/fonts/families/brand.css">',
    '<link rel="stylesheet" href="../vendor/fonts/0123456789ab.css">',
    '<script>load("models/m.glb"); lottie({ path: assetUrl("assets/mascot.json") })</script>',
    '<p data-placeholder="assets/shot-1.png,assets/shot-2.png"></p>',
  ].join('\n')
  const BRAND_CSS = "@font-face{font-family:'Brand';src:url(../../../fonts/brand/b.ttf)}"
  const LIBRARY = {
    'compositions/scene.html': SCENE,
    'compositions/components/deep.html': '<img src="../../assets/icons/a.png">',
    'assets/icons/a.png': 'png',
    'assets/bg.jpg': 'jpg',
    'models/m.glb': 'glb',
    'fonts/brand/b.ttf': 'ttf',
    'vendor/fonts/families/brand.css': BRAND_CSS,
    'vendor/fonts/0123456789ab.css': '@font-face{src:url(../npm/x@1.0.0/files/x.woff2)}',
    'vendor/npm/x@1.0.0/files/x.woff2': 'woff2',
    'vendor/npm/x@1.0.0/lib.js': 'var example = "assets/icons/a.png"',
  }

  it('组件自带的目录整体挪到 vendor/files/<目录>-<内容摘要>/，三种写法的地址都改到新位置', async () => {
    const root = join(work, 'root')
    await put(root, LIBRARY)
    const { moved } = await relocate(root)

    const assets = moved.get('assets/icons/a.png').split('/')[2]
    const models = moved.get('models/m.glb').split('/')[2]
    const fonts = moved.get('fonts/brand/b.ttf').split('/')[2]
    expect([assets, models, fonts]).toEqual([
      expect.stringMatching(/^assets-[0-9a-f]{12}$/),
      expect.stringMatching(/^models-[0-9a-f]{12}$/),
      expect.stringMatching(/^fonts-[0-9a-f]{12}$/),
    ])
    expect(await text(root, `vendor/files/${assets}/icons/a.png`)).toBe('png')
    expect(await text(root, `vendor/files/${models}/m.glb`)).toBe('glb')
    for (const dir of ['assets', 'models', 'fonts']) expect(existsSync(join(root, dir))).toBe(false)

    const scene = (await text(root, 'compositions/scene.html')).split('\n')
    expect(scene.slice(0, 3)).toEqual([
      `<img src="vendor/files/${assets}/icons/a.png">`,
      `<div style="background: url('vendor/files/${assets}/bg.jpg')"></div>`,
      `<div style="background: url(vendor/files/${assets}/bg.jpg)"></div>`,
    ])
    expect(scene[5]).toBe(
      `<script>load("vendor/files/${models}/m.glb"); lottie({ path: assetUrl("assets/mascot.json") })</script>`,
    )
    // 指向组件库里不存在的文件（比如留给工程自己的素材）原样不动
    expect(scene[6]).toBe(LIBRARY['compositions/scene.html'].split('\n')[6])
    expect(await text(root, 'compositions/components/deep.html')).toBe(
      `<img src="../../vendor/files/${assets}/icons/a.png">`,
    )
    // 第三方包的文件原样
    expect(await text(root, 'vendor/npm/x@1.0.0/lib.js')).toBe(LIBRARY['vendor/npm/x@1.0.0/lib.js'])
  })

  it('字体样式表按改写后的内容摘要命名，引用它们的地址随之改写', async () => {
    const root = join(work, 'root')
    await put(root, LIBRARY)
    const { moved, renamed } = await relocate(root)

    const fonts = moved.get('fonts/brand/b.ttf').split('/')[2]
    const brandCss = `@font-face{font-family:'Brand';src:url(../../files/${fonts}/brand/b.ttf)}`
    const googleCss = LIBRARY['vendor/fonts/0123456789ab.css']
    const brandPath = `vendor/fonts/families/brand-${sha256(brandCss).slice(0, 12)}.css`
    const googlePath = `vendor/fonts/${sha256(googleCss).slice(0, 12)}.css`
    expect(Object.fromEntries(renamed)).toEqual({
      'vendor/fonts/families/brand.css': brandPath,
      'vendor/fonts/0123456789ab.css': googlePath,
    })
    expect(await text(root, brandPath)).toBe(brandCss)
    expect(await text(root, googlePath)).toBe(googleCss)
    const scene = (await text(root, 'compositions/scene.html')).split('\n')
    expect(scene.slice(3, 5)).toEqual([
      `<link rel="stylesheet" href="../${brandPath}">`,
      `<link rel="stylesheet" href="../${googlePath}">`,
    ])
  })

  it('同样的内容得到同样的路径；内容一变，路径就变', async () => {
    const paths = async (name, files) => {
      const root = join(work, name)
      await put(root, files)
      const { moved, renamed } = await relocate(root)
      return [...moved.values(), ...renamed.values()]
    }
    const first = await paths('a', LIBRARY)
    expect(await paths('b', LIBRARY)).toEqual(first)
    const changed = await paths('c', { ...LIBRARY, 'fonts/brand/b.ttf': 'ttf v2' })
    expect(changed.filter((path) => path.startsWith('vendor/files/assets-'))).toEqual(
      first.filter((path) => path.startsWith('vendor/files/assets-')),
    )
    expect(changed.find((path) => path.startsWith('vendor/files/fonts-'))).not.toBe(
      first.find((path) => path.startsWith('vendor/files/fonts-')),
    )
    expect(changed.find((path) => path.startsWith('vendor/fonts/families/'))).not.toBe(
      first.find((path) => path.startsWith('vendor/fonts/families/')),
    )
  })

  it('查漏：整理后没有遗漏时通过', async () => {
    const root = join(work, 'root')
    await put(root, LIBRARY)
    const { moved } = await relocate(root)
    await expect(checkRelocated(root, moved)).resolves.toBeUndefined()
  })

  it('查漏：仍有地址指向挪走文件的旧位置时报错，写出文件、行号与地址', async () => {
    const root = join(work, 'root')
    await put(root, {
      'compositions/left.html': '<div>\n  <i data-image="assets/icons/a.png"></i>\n</div>',
      'compositions/own/assets/icons/a.png': 'png',
      'compositions/own.html': '<img src="compositions/own/assets/icons/a.png">',
    })
    const moved = new Map([['assets/icons/a.png', 'vendor/files/assets-0123456789ab/icons/a.png']])
    const error = await checkRelocated(root, moved).catch((caught) => caught)
    expect(error).toBeInstanceOf(SyncError)
    expect(error.message).toContain('compositions/left.html:2 → assets/icons/a.png')
    expect(error.message).not.toContain('compositions/own.html')
  })

  it('查漏：vendor/ 里的样式表引用 vendor/ 以外的文件时报错', async () => {
    const root = join(work, 'root')
    await put(root, {
      'vendor/fonts/families/brand.css': '@font-face{src:url(../../../fonts/brand/b.ttf)}',
    })
    await expect(checkRelocated(root, new Map())).rejects.toThrow(
      'vendor/fonts/families/brand.css → ../../../fonts/brand/b.ttf',
    )
  })

  describe('installVersion', () => {
    const OUT_VENDOR = { 'vendor/keep/old.txt': 'old', 'vendor/npm/x/a.js': 'a' }
    const ASSEMBLED = {
      'compositions/a.html': '<p></p>',
      'vendor/npm/x/a.js': 'a',
      'vendor/fonts/n.css': 'n',
    }

    it('vendor/ 只增：新文件并入，已有的文件不删、内容相同的不重写；版本目录里的 vendor 是指向 ../vendor 的软链接', async () => {
      const out = join(work, 'out')
      const root = join(out, '.assemble')
      await put(out, OUT_VENDOR)
      await put(root, ASSEMBLED)
      const before = await stat(join(out, 'vendor/npm/x/a.js'))

      await installVersion(root, out, 'v1')

      expect(existsSync(root)).toBe(false)
      expect(await readlink(join(out, 'v1/vendor'))).toBe('../vendor')
      expect(await text(out, 'v1/vendor/fonts/n.css')).toBe('n')
      expect(await text(out, 'vendor/fonts/n.css')).toBe('n')
      expect(await text(out, 'v1/compositions/a.html')).toBe('<p></p>')
      expect(await text(out, 'vendor/keep/old.txt')).toBe('old')
      const after = await stat(join(out, 'vendor/npm/x/a.js'))
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    })

    it('vendor/ 已有同一路径、内容不同的文件：报错，输出目录不受改动', async () => {
      const out = join(work, 'out')
      const root = join(out, '.assemble')
      await put(out, { ...OUT_VENDOR, 'vendor/npm/x/a.js': 'a changed' })
      await put(root, ASSEMBLED)

      await expect(installVersion(root, out, 'v1')).rejects.toThrow(
        expect.objectContaining({
          constructor: SyncError,
          message: expect.stringContaining('vendor/npm/x/a.js'),
        }),
      )
      expect(existsSync(join(out, 'v1'))).toBe(false)
      expect(existsSync(join(out, 'vendor/fonts/n.css'))).toBe(false)
      expect(await text(out, 'vendor/npm/x/a.js')).toBe('a changed')
    })
  })
})

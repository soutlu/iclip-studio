import { describe, expect, it } from 'vitest'
import { audio, fixtureCatalog, host, mainFile, video } from '@/testing/final-cut'
import type { CatalogItem, ComponentCatalog } from './catalog'
import {
  audioElement,
  clipOf,
  emptyProject,
  FONT_BLOCK_END,
  FONT_BLOCK_START,
  hostElement,
  itemFonts,
  itemLayout,
  itemNamed,
  videoElement,
  withFontBlock,
  type ElementView,
  type FilmClip,
} from './film'

const CANVAS = { width: 1080, height: 1920 }

const itemOf = (name: string): CatalogItem => {
  const item = itemNamed(fixtureCatalog, name)
  if (item === undefined) throw new Error(name)
  return item
}

/** 像 SDK 的元素快照那样读一个元素：样式单独给（属性名照 CSS 对象的写法），属性里不带 style、class。 */
const viewOf = (element: HTMLElement): ElementView => ({
  id: element.dataset['hfId'] ?? element.id,
  tag: element.tagName.toLowerCase(),
  attributes: Object.fromEntries(
    [...element.attributes]
      .filter((attribute) => !['style', 'class', 'data-hf-id'].includes(attribute.name))
      .map((attribute) => [attribute.name, attribute.value]),
  ),
  inlineStyles: element.style.zIndex === '' ? {} : { zIndex: element.style.zIndex },
  text: element.textContent === '' ? null : element.textContent,
  trackIndex:
    element.dataset['trackIndex'] === undefined ? null : Number(element.dataset['trackIndex']),
})

/** 主文件根下每个带时间的元素读成片段；起止按 `data-start`、`data-duration` 算（SDK 也这样算）。 */
const readBack = (html: string, catalog: ComponentCatalog = fixtureCatalog): FilmClip[] => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const root = page.querySelector('[data-composition-id]')
  return [...(root?.children ?? [])].flatMap((element) => {
    if (!(element instanceof HTMLElement) || element.dataset['start'] === undefined) return []
    const start = Number(element.dataset['start'])
    const timing = { enterAt: start, exitAt: start + Number(element.dataset['duration']) }
    return [clipOf(viewOf(element), timing, catalog)]
  })
}

const headOf = (html: string) => /<head>[\s\S]*<\/head>/.exec(html)?.[0] ?? ''

describe('新建工程的主文件', () => {
  it('根上的属性照空的 final-cut 写，<head> 里带动画库和空的字体块', () => {
    const html = emptyProject(CANVAS, fixtureCatalog)
    expect(html).toContain(
      '<div id="film" data-hf-id="film" data-composition-id="film" data-no-timeline data-start="0"' +
        ' data-duration="0" data-width="1080" data-height="1920">',
    )
    expect(headOf(html)).toContain(
      '<script src="vendor/npm/gsap@3.14.2/dist/gsap.min.js"></script>',
    )
    expect(headOf(html)).toContain(`${FONT_BLOCK_START}\n${FONT_BLOCK_END}`)
    expect(readBack(html)).toEqual([])
  })
})

describe('按标签认片段', () => {
  const titled = host({
    track: 1,
    start: 500,
    duration: 1500,
    playbackStart: 1000,
    values: { text: '新品上市', accent: '#ff0000', size: 2, bold: true },
    z: 2,
    hidden: true,
  })
  const music = audio({
    start: 1000,
    duration: 6000,
    mediaStart: 2500,
    volume: 0.5,
    fadeIn: 1000,
    fadeOut: 500,
    loop: true,
    hidden: true,
  })

  it('编辑器写出的三种片段读回来和原来一样', () => {
    const clips = [video({ z: 1 }), titled, music]
    expect(readBack(mainFile(clips, CANVAS))).toEqual(clips)
  })

  it('增益、速度、淡入淡出和静音写出来再读回，和原来一样；默认值不写', () => {
    const clips = [
      video({ volume: 1.995262, playbackRate: 0.5, fadeIn: 1200, fadeOut: 300, muted: true }),
      audio({ start: 2000, volume: 0.031623, playbackRate: 2.5, loop: true }),
    ]
    expect(readBack(mainFile(clips, CANVAS))).toEqual(clips)
    const sound = videoElement(video())
    for (const name of ['data-playback-rate', 'data-fade-in', 'data-fade-out', 'muted', 'style'])
      expect(sound).not.toContain(` ${name}=`)
    expect(sound).toContain(' data-has-audio="true"')
    const mute = videoElement(video({ muted: true }))
    expect(mute).toContain(' muted="true"')
    expect(mute).not.toContain('data-has-audio')
    expect(audioElement(audio())).not.toMatch(/ (loop|data-hidden|data-playback-rate)/)
  })

  it('素材地址只写在 src 上，没有地址变量', () => {
    const html = mainFile([video(), audio()], CANVAS)
    expect(html).not.toContain('data-var-src')
    expect(html).not.toContain('data-composition-variables')
    expect(html).toContain(` src="${video().src}"`)
  })

  it('手写的带时间元素是「其他」：名称取 data-label，没写时取文字；挪动、换行认得出', () => {
    const html = mainFile(
      [video()],
      CANVAS,
      '<p id="note" data-start="1" data-duration="2.5" data-track-index="3">手写文字</p>\n' +
        '<div data-label="角标" style="z-index: 4" data-start="0.5" data-duration="1"><b>x</b></div>',
    )
    const [, note, badge] = readBack(html)
    expect(note).toEqual({
      kind: 'other',
      id: 'note',
      label: '手写文字',
      start: 1000,
      duration: 2500,
      track: 3,
      hidden: false,
      link: null,
      z: 0,
    })
    expect(badge).toMatchObject({ kind: 'other', label: '角标', track: 0, z: 4 })
  })

  it('目录里查不到的宿主、没写 data-composition-src 的宿主都是「其他」', () => {
    const html = mainFile(
      [],
      CANVAS,
      '<div id="gone" data-composition-id="removed-item" data-composition-src="compositions/x.html"' +
        ' data-start="0" data-duration="1"></div>\n' +
        '<div id="bare" data-composition-id="fixture-fields" data-start="0" data-duration="1"></div>',
    )
    expect(readBack(html).map((clip) => [clip.id, clip.kind])).toEqual([
      ['gone', 'other'],
      ['bare', 'other'],
    ])
  })

  it('没写全的视频和音频取默认值：从头放、原音量、原速、不淡入淡出', () => {
    const html = mainFile(
      [],
      CANVAS,
      '<video id="v" src="https://media.test/v.mp4" data-start="0" data-duration="1"></video>',
    )
    expect(readBack(html)).toEqual([
      {
        kind: 'video',
        id: 'v',
        label: 'video',
        start: 0,
        duration: 1000,
        track: 0,
        hidden: false,
        src: 'https://media.test/v.mp4',
        mediaStart: 0,
        volume: 1,
        playbackRate: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: false,
        z: 0,
        link: null,
        syncOrigin: null,
        audioGroup: null,
        fxCarve: null,
        fxChain: null,
        automation: null,
      },
    ])
  })

  it('链接名和出处：写出去读回来一样；写成空的算没有', () => {
    const pair = [
      video({ id: 'v', muted: true, link: 'lk-1', syncOrigin: 'lk-1' }),
      audio({ id: 'a', link: 'lk-1', syncOrigin: 'lk-1' }),
    ]
    expect(readBack(mainFile(pair, CANVAS))).toEqual(pair)
    const html = mainFile(
      [],
      CANVAS,
      '<audio id="a" src="https://media.test/a.mp3" data-link="" data-sync-origin=""' +
        ' data-start="0" data-duration="1"></audio>',
    )
    expect(readBack(html)).toMatchObject([{ link: null, syncOrigin: null }])
  })

  it('智能调音的声音组、压低设置和效果链在视频、音频片段上原样读写；没写时是 null', () => {
    const fxCarve = '{"enabled":true,"sources":["voice"],"strength":0.25}'
    const fxChain = '{"version":1,"nodes":[{"type":"gain","id":"n1","fromLeveller":true}]}'
    const clips = [
      video({ audioGroup: 'voice', fxCarve, fxChain }),
      audio({ audioGroup: 'music', fxCarve }),
    ]
    expect(readBack(mainFile(clips, CANVAS))).toEqual(clips)
    for (const written of [audioElement(audio()), videoElement(video())])
      expect(written).not.toMatch(/data-audio-group|data-fx-carve|data-fx-chain/)
  })

  it('配音片段：其它语言的写着语言，原文的旁白不写语言、写着音色；读回来一样', () => {
    const dubbed = audio({
      id: 'd',
      dub: { locale: 'en', caption: 'cap-1', trimmed: true, voice: null },
    })
    const narration = audio({
      id: 'n',
      dub: { locale: null, caption: 'cap-2', trimmed: false, voice: 'v-1' },
    })
    expect(readBack(mainFile([dubbed, narration], CANVAS))).toEqual([dubbed, narration])
    expect(audioElement(narration)).not.toContain('data-locale')
    expect(audioElement(narration)).toContain('data-dub-voice="v-1"')
    expect(audioElement(dubbed)).not.toContain('data-dub-voice')
  })
})

describe('组件或块的片段的摆放和字体（宿主元素的行内样式）', () => {
  // 源目录里的测试条目没有字体可填项（组装时才加上），这里补上
  const fontCatalog: ComponentCatalog = {
    ...fixtureCatalog,
    fonts: { 'Playfair Display': { css: 'vendor/fonts/families/playfair-display.css' } },
    items: fixtureCatalog.items.map((item) =>
      item.name === 'fixture-fields'
        ? {
            ...item,
            variables: [
              ...item.variables,
              { id: 'font', type: 'font', label: '字体', default: '' },
            ],
          }
        : item,
    ),
  }
  const fields = (catalog: ComponentCatalog) => itemNamed(catalog, 'fixture-fields') as CatalogItem

  it('固定尺寸和画面不一样大：按原比例缩到放得下、居中', () => {
    expect(itemLayout(itemOf('fixture-scene'), CANVAS)).toEqual({
      left: '50%',
      top: '50%',
      width: '1920px',
      height: '1080px',
      translate: '-50% -50%',
      scale: '0.5625',
    })
    expect(itemLayout(itemOf('fixture-scene'), { width: 1280, height: 540 })['scale']).toBe('0.5')
  })

  it('和画面一样大、或者没写尺寸（铺满）：不写', () => {
    expect(itemLayout(itemOf('fixture-scene'), { width: 1920, height: 1080 })).toEqual({})
    expect(itemLayout(itemOf('fixture-overlay'), CANVAS)).toEqual({})
  })

  it('写进宿主元素的行内样式，和叠放顺序在一起', () => {
    const scene = host({
      id: 'scene-1',
      item: 'fixture-scene',
      src: 'compositions/fixtures/fixture-scene.html',
      z: 3,
    })
    expect(hostElement(scene, itemOf('fixture-scene'), CANVAS, fixtureCatalog)).toContain(
      ' style="z-index: 3; left: 50%; top: 50%; width: 1920px; height: 1080px;' +
        ' translate: -50% -50%; scale: 0.5625"',
    )
  })

  it('字体类可填项取到组件库里的字体：标题和正文的字体变量都换成它，中文字形退到组件库的中文字体', () => {
    const value = "'Playfair Display', 'Noto Sans SC', sans-serif"
    expect(itemFonts(fields(fontCatalog), { font: 'Playfair Display' }, fontCatalog)).toEqual({
      '--font-display': value,
      '--font-body': value,
    })
    const element = hostElement(
      host({ values: { font: 'Playfair Display' } }),
      fields(fontCatalog),
      { width: 1920, height: 1080 },
      fontCatalog,
    )
    expect(element).toContain(
      ` style="--font-display: ${value.replaceAll("'", '&#39;')}; --font-body: ${value.replaceAll("'", '&#39;')}"`,
    )
  })

  it('没填、填的不是组件库里的字体：两个字体变量都去掉，也不写进样式', () => {
    for (const values of [{}, { font: 'Comic Sans' }, { font: "x'}</style><script>alert(1)" }]) {
      expect(itemFonts(fields(fontCatalog), values, fontCatalog)).toEqual({
        '--font-display': null,
        '--font-body': null,
      })
      const element = hostElement(host({ values }), fields(fontCatalog), CANVAS, fontCatalog)
      expect(element).not.toContain('--font')
      expect(element).not.toContain('<script')
    }
  })

  it('条目的字体可填项默认是组件库里的字体：不填也写', () => {
    const brand = host({
      id: 'brand-1',
      item: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
    })
    expect(hostElement(brand, itemOf('fixture-brand-card'), CANVAS, fixtureCatalog)).toContain(
      '--font-display: &#39;Playfair Display&#39;, &#39;Noto Sans SC&#39;, sans-serif',
    )
  })
})

describe('<head> 里的字体块', () => {
  const files = (slice: string) => ({
    '400': `vendor/fonts/noto-${slice}-400.woff2`,
    '700': `vendor/fonts/noto-${slice}-700.woff2`,
  })
  const catalog: ComponentCatalog = {
    ...fixtureCatalog,
    cjk: {
      family: 'Noto Sans SC',
      slices: [
        { range: 'U+4e00-9fff', files: files('cjk') },
        { range: 'U+0020-007E', files: files('latin') },
      ],
    },
    fonts: {
      'Playfair Display': {
        css: 'vendor/fonts/families/playfair-display.css',
        cjk: [{ weight: '400', style: 'normal' }],
      },
    },
    items: fixtureCatalog.items.map((item) =>
      item.name === 'fixture-fields'
        ? {
            ...item,
            chars: '示例',
            variables: [
              ...item.variables,
              { id: 'font', type: 'font', label: '字体', default: '' },
            ],
          }
        : item,
    ),
  }
  const LINK = '<link rel="stylesheet" href="vendor/fonts/families/playfair-display.css">'
  const withFonts = (clips: FilmClip[]) =>
    withFontBlock(emptyProject(CANVAS, catalog), clips, catalog)

  /** `css` 里有没有一条这个字体族的规则，它的范围盖住 `char`。 */
  const covers = (html: string, family: string, char: string) => {
    const code = char.codePointAt(0) ?? 0
    return [...html.matchAll(/@font-face\{([^}]*)\}/g)].some(([, rule = '']) => {
      if (!rule.includes(`font-family:'${family}'`)) return false
      const ranges = /unicode-range:([^;}]+)/.exec(rule)?.[1] ?? ''
      return ranges.split(',').some((part) => {
        const [from = '', to = from] = part.trim().replace(/^U\+/i, '').split('-')
        return parseInt(from, 16) <= code && code <= parseInt(to, 16)
      })
    })
  }

  it('组件值里的文字和条目里出现的字都声明了中文字形，别的字不声明', () => {
    const html = withFonts([host({ values: { text: '新品' } })])
    for (const char of '新品示例') expect(covers(html, 'Noto Sans SC', char)).toBe(true)
    expect(covers(html, 'Noto Sans SC', '上')).toBe(false)
  })

  const caption: FilmClip = {
    kind: 'caption',
    id: 'cap-a1',
    label: '字幕',
    start: 0,
    duration: 2000,
    track: 0,
    hidden: false,
    link: null,
    text: '字幕\n两行',
    variable: 'cap_a1',
    owner: null,
    font: null,
    color: null,
    fontSize: null,
  }

  it('字幕的字按字幕用的中文字体声明了粗体和常规两种字形', () => {
    const html = withFonts([video(), caption])
    for (const char of '字幕两行') expect(covers(html, catalog.cjk.family, char)).toBe(true)
    expect(html).toContain('font-weight:700;src:url(vendor/fonts/noto-cjk-700.woff2)')
    expect(covers(html, catalog.cjk.family, '上')).toBe(false)
    expect(html).not.toContain(LINK)
  })

  it('一句字幕设了组件库里的字体：链上它的字体，并按它出中文孪生规则；组件库里没有的字体不链', () => {
    const html = withFonts([video(), { ...caption, font: 'Playfair Display' }])
    expect(html.split(LINK)).toHaveLength(2)
    expect(covers(html, 'Playfair Display', '字')).toBe(true)
    expect(withFonts([video(), { ...caption, font: 'Comic Sans MS' }])).not.toContain('<link ')
  })

  it('字幕样式设了组件库里的字体：链上它的字体，并按它给字幕的字出中文孪生规则；和单句设的同一个字体只链一次', () => {
    const styled = (clips: FilmClip[]) =>
      withFontBlock(emptyProject(CANVAS, catalog), clips, catalog, '', 'Playfair Display')
    const html = styled([video(), caption])
    expect(html.split(LINK)).toHaveLength(2)
    expect(covers(html, 'Playfair Display', '字')).toBe(true)
    expect(styled([video(), { ...caption, font: 'Playfair Display' }]).split(LINK)).toHaveLength(2)
  })

  it('没有组件或块的片段时只声明西文基本字符', () => {
    const html = withFonts([video({ label: '新品' })])
    expect(covers(html, 'Noto Sans SC', 'A')).toBe(true)
    expect(covers(html, 'Noto Sans SC', '新')).toBe(false)
    expect(html).not.toContain('<link ')
  })

  it('字体类可填项选了组件库里的字体：链上它的字体，并按它出中文孪生规则', () => {
    const html = withFonts([host({ values: { text: '新品', font: 'Playfair Display' } })])
    expect(html.split(LINK)).toHaveLength(2)
    expect(covers(html, 'Playfair Display', '新')).toBe(true)
    expect(withFonts([host({ values: { text: '新品' } })])).not.toContain(LINK)
  })

  it('条目自带的字体族也链上；同一个字体只链一次', () => {
    const brand = host({
      id: 'brand-1',
      item: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      track: 2,
    })
    const html = withFonts([brand, host({ values: { font: 'Playfair Display' } })])
    expect(html.split(LINK)).toHaveLength(2)
  })

  it('只换两行标记之间的内容：手写在 <head> 里的注释、样式、脚本一个字不动，换几次都一样', () => {
    const handHead =
      '<head>\n<meta charset="utf-8">\n<!-- 手写的注释 -->\n<style>.mine{color:red}</style>\n' +
      `<script>window.hand = 1</script>\n${FONT_BLOCK_START}\n<link rel="stylesheet" href="old.css">\n${FONT_BLOCK_END}\n` +
      '<script src="vendor/npm/extra.js"></script>\n</head>'
    const html = `<!doctype html>\n<html>\n${handHead}\n<body><div data-composition-id="x"></div></body>\n</html>\n`
    const once = withFontBlock(html, [host({ values: { font: 'Playfair Display' } })], catalog)
    const outside = (text: string) =>
      text.slice(0, text.indexOf(FONT_BLOCK_START)) +
      text.slice(text.indexOf(FONT_BLOCK_END) + FONT_BLOCK_END.length)
    expect(outside(once)).toBe(outside(html))
    expect(once).not.toContain('old.css')
    expect(once).toContain(LINK)
    expect(withFontBlock(once, [], catalog)).toBe(withFontBlock(html, [], catalog))
  })

  it('<head> 里还没有字体块：加在 </head> 前面，别的不动；没有 <head> 时原样返回', () => {
    const html = '<html><head><title>手写</title></head><body></body></html>'
    const added = withFontBlock(html, [], catalog)
    expect(added.startsWith('<html><head><title>手写</title>')).toBe(true)
    expect(added.endsWith(`${FONT_BLOCK_END}\n</head><body></body></html>`)).toBe(true)
    expect(withFontBlock('<div data-composition-id="x"></div>', [], catalog)).toBe(
      '<div data-composition-id="x"></div>',
    )
  })
})

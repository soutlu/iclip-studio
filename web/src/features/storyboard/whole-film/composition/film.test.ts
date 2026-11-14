import { describe, expect, it } from 'vitest'
import { audio, AUDIO_JOB, fixtureCatalog, host, video } from '@/testing/whole-film'
import type { ComponentCatalog } from './catalog'
import {
  AUDIO_SOURCE_LABEL,
  clipFromAttributes,
  clipKindOfTag,
  filmDurationMs,
  filmVariables,
  SOURCE_LABEL,
  writeClip,
  writeFilm,
  type Film,
  type FilmClip,
} from './film'

const CANVAS = { width: 1080, height: 1920 }
const film = (...clips: FilmClip[]): Film => ({ canvas: CANVAS, clips })

/** 像编辑器那样读回片段：SDK 的元素快照把叠放顺序从样式里单独给。 */
const readBack = (html: string): (FilmClip | undefined)[] => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  return [...page.querySelectorAll<HTMLElement>('#film > *')].map((element) => {
    const kind = clipKindOfTag(element.tagName.toLowerCase())
    if (kind === undefined) return undefined
    const attributes = Object.fromEntries(
      [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    )
    return clipFromAttributes(kind, element.id, attributes, element.style.zIndex || undefined)
  })
}

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

describe('成片文件的写法', () => {
  it('三种片段写出来再按属性读回，和原来一样', () => {
    const clips = [video({ z: 1 }), titled, music]
    expect(readBack(writeFilm(film(...clips), fixtureCatalog))).toEqual(clips)
  })

  it('可选属性取默认值时不写，读回来是默认值', () => {
    const plain = [host(), audio()]
    const written = plain.map(writeClip)
    for (const name of ['data-hidden', 'style', 'data-playback-start', 'data-fade-in', 'loop']) {
      for (const clip of written) expect(clip).not.toContain(` ${name}`)
    }
    expect(readBack(writeFilm(film(...plain), fixtureCatalog))).toEqual(plain)
  })

  it('组件或块的片段的写法：组件名、组件文件、可填项取值都写在片段上', () => {
    expect(writeClip(host({ values: { text: '<标题>' } }))).toBe(
      '<div id="title-1" data-hf-id="title-1" class="clip component" data-label="测试可填项"' +
        ' data-composition-id="fixture-fields"' +
        ' data-composition-src="compositions/fixtures/fixture-fields.html"' +
        ' data-start="0" data-duration="2" data-track-index="0"' +
        ' data-variable-values="{&quot;text&quot;:&quot;&lt;标题&gt;&quot;}"></div>',
    )
  })

  it('音频片段的写法：地址绑按记录编号取名的变量，淡入淡出是秒数，循环写 loop="true"', () => {
    expect(writeClip(audio({ fadeIn: 1500, loop: true }))).toBe(
      '<audio id="music-1" data-hf-id="music-1" class="clip audio" data-label="配乐"' +
        ` src="https://media.test/audio/music.mp3" data-var-src="src-${AUDIO_JOB}"` +
        ' data-start="0" data-duration="2" data-media-start="0" data-track-index="0"' +
        ' data-volume="1" data-fade-in="1.5" loop="true"></audio>',
    )
  })

  it('视频片段、音频片段的增益、速度、淡入淡出和视频片段的静音：写出来再读回，和原来一样', () => {
    const clips = [
      video({ volume: 1.995262, playbackRate: 0.5, fadeIn: 1200, fadeOut: 300, muted: true }),
      audio({ start: 2000, volume: 0.031623, playbackRate: 2.5, loop: true }),
    ]
    const written = writeFilm(film(...clips), fixtureCatalog)
    expect(written).toContain(
      ' data-volume="1.995262" data-playback-rate="0.5" data-fade-in="1.2" data-fade-out="0.3"' +
        ' muted="true" playsinline',
    )
    expect(written).toContain(' data-volume="0.031623" data-playback-rate="2.5" loop="true"')
    expect(readBack(written)).toEqual(clips)
  })

  it('速度是 1、不淡入淡出时不写；视频片段有声音写 data-has-audio，静音时只写 muted，两个不同时出现', () => {
    const [sound, mute] = [video(), video({ muted: true })].map(writeClip)
    for (const name of ['data-playback-rate', 'data-fade-in', 'data-fade-out', 'muted']) {
      expect(sound).not.toContain(` ${name}=`)
    }
    expect(sound).toContain(' data-has-audio="true"')
    expect(mute).toContain(' muted="true"')
    expect(mute).not.toContain('data-has-audio')
    expect(writeClip(audio())).not.toContain('data-playback-rate')
    expect(readBack(writeFilm(film(video()), fixtureCatalog))).toEqual([video()])
  })

  it('成片总长是所有片段里最晚的结尾，三种片段都算', () => {
    expect(filmDurationMs(film(video({ duration: 2000 }), music))).toBe(7000)
    expect(filmDurationMs(film(video(), host({ start: 1000, duration: 3000 })))).toBe(4000)
    expect(filmDurationMs(film())).toBe(0)
  })

  it('固定尺寸的组件放进不一样大的画面：按片段的编号写一条规则，按原比例缩到放得下、居中', () => {
    const scene = host({
      id: 'scene-1',
      component: 'fixture-scene',
      src: 'compositions/fixtures/fixture-scene.html',
    })
    const html = writeFilm(film(scene), fixtureCatalog)
    expect(html).toContain(
      '#film #scene-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.5625}\n',
    )
    const wide = writeFilm({ canvas: { width: 1280, height: 540 }, clips: [scene] }, fixtureCatalog)
    expect(wide).toContain(
      '#film #scene-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.5}\n',
    )
  })

  it('固定尺寸和画面一样大、或者没写尺寸（铺满）的组件：不写规则', () => {
    const scene = host({
      id: 'scene-1',
      component: 'fixture-scene',
      src: 'compositions/fixtures/fixture-scene.html',
    })
    const overlay = host({
      id: 'overlay-1',
      component: 'fixture-overlay',
      src: 'compositions/fixtures/fixture-overlay.html',
    })
    const same = writeFilm(
      { canvas: { width: 1920, height: 1080 }, clips: [scene] },
      fixtureCatalog,
    )
    expect(same).not.toContain('#film #scene-1')
    expect(writeFilm(film(overlay), fixtureCatalog)).not.toContain('#film #overlay-1')
  })

  it('带默认字体的固定尺寸组件：缩放和字体变量写在同一条规则里', () => {
    const brand = host({
      id: 'brand-1',
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
    })
    expect(writeFilm(film(brand), fixtureCatalog)).toContain(
      "#film #brand-1{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.5625;--font-display:'Playfair Display', 'Noto Sans SC', sans-serif;--font-body:'Playfair Display', 'Noto Sans SC', sans-serif}\n",
    )
  })

  it('素材地址变量：视频片段和音频片段一条记录一个，组件或块的片段没有', () => {
    expect(filmVariables(film(video(), video({ id: 'clip-2' }), titled, music))).toEqual([
      { id: `src-${video().jobId}`, type: 'string', label: SOURCE_LABEL, default: video().src },
      { id: `src-${AUDIO_JOB}`, type: 'string', label: AUDIO_SOURCE_LABEL, default: music.src },
    ])
  })
})

describe('成片声明的字体', () => {
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
    const html = writeFilm(film(host({ values: { text: '新品' } })), catalog)
    for (const char of '新品示例') expect(covers(html, 'Noto Sans SC', char)).toBe(true)
    expect(covers(html, 'Noto Sans SC', '上')).toBe(false)
  })

  it('没有组件或块的片段时只声明西文基本字符', () => {
    const html = writeFilm(film(video({ label: '新品' })), catalog)
    expect(covers(html, 'Noto Sans SC', 'A')).toBe(true)
    expect(covers(html, 'Noto Sans SC', '新')).toBe(false)
    expect(html).not.toContain('<link ')
  })

  it('字体类可填项选了组件库里的字体：链上它的字体，并按它出中文孪生规则', () => {
    const chosen = host({ values: { text: '新品', font: 'Playfair Display' } })
    const html = writeFilm(film(chosen), catalog)
    expect(html.split(LINK)).toHaveLength(2)
    expect(covers(html, 'Playfair Display', '新')).toBe(true)
    expect(writeFilm(film(host({ values: { text: '新品' } })), catalog)).not.toContain(LINK)
  })

  it('字体类可填项选了组件库里的字体：按片段的编号写字体变量，中文字形退到组件库的中文字体', () => {
    const chosen = host({ values: { font: 'Playfair Display' } })
    const html = writeFilm({ canvas: { width: 1920, height: 1080 }, clips: [chosen] }, catalog)
    expect(html).toContain(
      "#film #title-1{--font-display:'Playfair Display', 'Noto Sans SC', sans-serif;--font-body:'Playfair Display', 'Noto Sans SC', sans-serif}\n",
    )
  })

  it('字体类可填项没填、默认值是空的，或者填的不是组件库里的字体：不写字体变量', () => {
    const canvas = { width: 1920, height: 1080 }
    for (const values of [{}, { font: 'Comic Sans' }, { font: "x'}</style><script>alert(1)" }]) {
      const html = writeFilm({ canvas, clips: [host({ values })] }, catalog)
      expect(html).not.toContain('#film #title-1')
      expect(html).not.toContain('<script')
    }
  })

  it('条目自带的字体族也链上；同一个字体只链一次', () => {
    const brand = host({
      id: 'brand-1',
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      track: 2,
    })
    const chosen = host({ values: { font: 'Playfair Display' } })
    const html = writeFilm(film(brand, chosen), catalog)
    expect(html.split(LINK)).toHaveLength(2)
  })
})

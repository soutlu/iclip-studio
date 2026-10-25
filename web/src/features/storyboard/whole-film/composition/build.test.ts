import { describe, expect, it } from 'vitest'
import type {
  WholeFilmComponentClip,
  WholeFilmDocument as WholeFilmDraft,
  WholeFilmOverlay,
  WholeFilmVideoClip,
} from '@/shared/api/generated'
import { buildComposition, CompositionError, type CompositionMedia } from './build'
import type { CatalogItem, ComponentCatalog } from './catalog'

const item = (spec: Partial<CatalogItem> & Pick<CatalogItem, 'name'>): CatalogItem => ({
  kind: 'component',
  title: spec.name,
  description: '',
  category: 'scenes',
  placement: null,
  src: `compositions/${spec.name}.html`,
  size: null,
  duration: null,
  variables: [],
  thumbnail: null,
  fonts: [],
  ...spec,
})

const CATALOG: ComponentCatalog = {
  version: '0.8.168',
  runtime: {
    hyperframes: 'vendor/hf/runtime.js',
    gsap: 'vendor/gsap/gsap.min.js',
    cjkFont: 'vendor/fonts/noto-sans-sc.css',
  },
  fonts: {
    Inter: 'vendor/fonts/families/inter.css',
    Anton: 'vendor/fonts/families/anton.css',
    'DM Sans': 'vendor/fonts/families/dm-sans.css',
  },
  categories: [],
  excluded: [{ name: 'showreel', title: '转场合集', reason: '转场合集' }],
  items: [
    item({
      name: 'default-caption',
      placement: 'caption',
      src: 'compositions/iclip/default-caption.html',
      fonts: ['Anton'],
    }),
    item({
      name: 'logo-intro',
      kind: 'block',
      size: { width: 1920, height: 1080 },
      duration: 4,
      variables: [
        { id: 'wordmark', type: 'string', label: '品牌名', default: '品牌名' },
        { id: 'tone', type: 'enum', label: '色调', default: 'warm' },
      ],
    }),
    item({ name: 'end-card' }),
    item({
      name: 'lower-third',
      variables: [{ id: 'title', type: 'string', label: '标题', default: '标题' }],
      fonts: ['Inter'],
    }),
    item({ name: 'stat-card', fonts: ['DM Sans', 'Inter'] }),
    item({
      name: 'scribble',
      kind: 'block',
      category: 'transitions',
      size: { width: 1920, height: 1080 },
      duration: 2,
    }),
  ],
}

const MEDIA: CompositionMedia = {
  videos: {
    'job-a': { url: 'https://oss.example.com/a.mp4?sig=1&x=2' },
    'job-b': { url: 'https://oss.example.com/b.mp4' },
  },
  music: { url: 'https://oss.example.com/music.mp3' },
  subtitles: {
    'job-a': {
      subtitleJobId: 'sub-a',
      sentences: [
        {
          startMs: 0,
          endMs: 1000,
          text: '你好。',
          speaker: null,
          words: [{ startMs: 0, endMs: 1000, text: '你好', punctuation: '。' }],
        },
      ],
    },
  },
}

const vid = (
  id: string,
  start: number,
  duration: number,
  sourceJobId = 'job-a',
  rest: Partial<WholeFilmVideoClip> = {},
): WholeFilmVideoClip => ({
  id,
  type: 'video',
  start,
  duration,
  playbackStart: 0,
  sourceJobId,
  volume: 1,
  ...rest,
})

const comp = (
  id: string,
  start: number,
  duration: number,
  component: string,
  rest: Partial<WholeFilmComponentClip> = {},
): WholeFilmComponentClip => ({
  id,
  type: 'component',
  start,
  duration,
  playbackStart: 0,
  component,
  variables: {},
  ...rest,
})

const ov = (
  id: string,
  component: string,
  start: number,
  duration: number,
  rest: Partial<WholeFilmOverlay> = {},
): WholeFilmOverlay => ({
  id,
  component,
  start,
  duration,
  playbackStart: 0,
  track: 0,
  zIndex: 1,
  variables: {},
  ...rest,
})

const draft = (spec: Partial<WholeFilmDraft> = {}): WholeFilmDraft => ({
  canvas: { width: 720, height: 1280 },
  layer0: [
    vid('a', 0, 3000, 'job-a', { playbackStart: 500, volume: 1.5 }),
    vid('b', 3000, 2000, 'job-b', { volume: 0 }),
  ],
  captions: { component: 'default-caption', edits: [] },
  music: null,
  overlays: [],
  ...spec,
})

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const build = (spec: Partial<WholeFilmDraft> = {}) =>
  buildComposition({ draft: draft(spec), media: MEDIA, catalog: CATALOG })
const variablesOf = (element: Element | null): unknown =>
  JSON.parse(element?.getAttribute('data-variable-values') ?? 'null')

describe('buildComposition', () => {
  it('第 0 层每段画面是一个 video：成片时间、素材入点与音量写成 HyperFrames 属性', () => {
    const { html, durationMs } = build()
    const doc = parse(html)
    const videos = [...doc.querySelectorAll('#stage > video')]
    expect(durationMs).toBe(5000)
    expect(videos.map((video) => video.getAttribute('src'))).toEqual([
      'https://oss.example.com/a.mp4?sig=1&x=2',
      'https://oss.example.com/b.mp4',
    ])
    expect(
      videos.map((video) => ({
        start: video.getAttribute('data-start'),
        duration: video.getAttribute('data-duration'),
        mediaStart: video.getAttribute('data-media-start'),
        track: video.getAttribute('data-track-index'),
        volume: video.getAttribute('data-volume'),
      })),
    ).toEqual([
      { start: '0', duration: '3', mediaStart: '0.5', track: '0', volume: '1.5' },
      { start: '3', duration: '2', mediaStart: '0', track: '0', volume: '0' },
    ])
    const stage = doc.querySelector('#stage')
    expect(stage?.getAttribute('data-composition-id')).toBe('main')
    expect(stage?.getAttribute('data-duration')).toBe('5')
    expect(doc.querySelectorAll('[data-composition-id="main"]')).toHaveLength(1)
  })

  it('组件段在两段视频中间：第 0 层的子合成，与视频段同轨，目录默认值打底、草稿取值覆盖', () => {
    const { html, durationMs } = build({
      layer0: [
        vid('a', 0, 2000),
        comp('c', 2000, 1500, 'logo-intro', { variables: { wordmark: '拾步' } }),
        vid('b', 3500, 1000, 'job-b'),
      ],
    })
    const doc = parse(html)
    expect(durationMs).toBe(4500)
    const order = [...doc.querySelectorAll('#clip-0, #clip-1, #clip-2')].map((node) => node.tagName)
    expect(order).toEqual(['VIDEO', 'DIV', 'VIDEO'])
    const segment = doc.querySelector('#clip-1')
    expect(segment?.getAttribute('data-composition-src')).toBe('compositions/logo-intro.html')
    expect(segment?.getAttribute('data-start')).toBe('2')
    expect(segment?.getAttribute('data-duration')).toBe('1.5')
    expect(segment?.getAttribute('data-track-index')).toBe('0')
    expect(variablesOf(segment)).toEqual({ wordmark: '拾步', tone: 'warm' })
    // 1920×1080 放进 720×1280：按宽缩到 0.375。
    expect(segment?.parentElement?.getAttribute('style')).toContain('scale(0.375)')
    expect(doc.querySelector('#clip-2')?.getAttribute('data-start')).toBe('3.5')
  })

  it('左修剪过的组件段与特效块从组件自己时间里的 playbackStart 起播', () => {
    const doc = parse(
      build({
        layer0: [comp('c', 0, 2000, 'end-card', { playbackStart: 1250 }), vid('a', 2000, 1000)],
        overlays: [ov('o', 'lower-third', 0, 1000, { playbackStart: 400 })],
      }).html,
    )
    expect(doc.querySelector('#clip-0')?.getAttribute('data-playback-start')).toBe('1.25')
    expect(doc.querySelector('#ov-0')?.getAttribute('data-playback-start')).toBe('0.4')
    expect(doc.querySelector('#captions')?.getAttribute('data-playback-start')).toBe('0')
  })

  it('只有组件段、还没定画布：画面是竖屏 1080×1920，照样能合成', () => {
    const { html, durationMs } = buildComposition({
      draft: draft({
        canvas: null,
        layer0: [comp('c1', 0, 2000, 'logo-intro'), comp('c2', 2000, 1000, 'end-card')],
      }),
      media: { videos: {}, music: null, subtitles: {} },
      catalog: CATALOG,
    })
    const doc = parse(html)
    expect(durationMs).toBe(3000)
    const stage = doc.querySelector('#stage')
    expect([stage?.getAttribute('data-width'), stage?.getAttribute('data-height')]).toEqual([
      '1080',
      '1920',
    ])
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(
      'width=1080, height=1920',
    )
    expect(doc.querySelectorAll('#stage > video')).toHaveLength(0)
    // 1920×1080 放进 1080×1920：按宽缩到 0.5625。
    expect(doc.querySelector('#clip-0')?.parentElement?.getAttribute('style')).toContain(
      'scale(0.5625)',
    )
  })

  it('配乐铺满成片：从 0 开始，素材里的起点与音量写进 audio', () => {
    const doc = parse(build({ music: { jobId: 'music-1', offset: 12_345, volume: 0.6 } }).html)
    const audio = doc.querySelector('#stage > audio')
    expect({
      src: audio?.getAttribute('src'),
      start: audio?.getAttribute('data-start'),
      duration: audio?.getAttribute('data-duration'),
      mediaStart: audio?.getAttribute('data-media-start'),
      volume: audio?.getAttribute('data-volume'),
    }).toEqual({
      src: 'https://oss.example.com/music.mp3',
      start: '0',
      duration: '5',
      mediaStart: '12.345',
      volume: '0.6',
    })
  })

  it('特效块是单独一轨的子合成，带各自的起止与可填项；转场类组件也只是普通特效块', () => {
    const doc = parse(
      build({
        overlays: [
          ov('o1', 'lower-third', 500, 1500, { variables: { title: '新品' } }),
          ov('o2', 'lower-third', 3000, 1000),
          ov('o3', 'scribble', 2000, 2000),
        ],
      }).html,
    )
    const hosts = [...doc.querySelectorAll('[id^="ov-"]')]
    expect(
      hosts.map((host) => [
        host.getAttribute('data-composition-id'),
        host.getAttribute('data-start'),
        host.getAttribute('data-duration'),
      ]),
    ).toEqual([
      ['lower-third', '0.5', '1.5'],
      ['lower-third', '3', '1'],
      ['scribble', '2', '2'],
    ])
    expect(new Set(hosts.map((host) => host.getAttribute('data-track-index')))).toEqual(
      new Set(['3']),
    )
    expect(hosts.slice(0, 2).map(variablesOf)).toEqual([{ title: '新品' }, { title: '标题' }])
  })

  it('成片时长是所有轨上内容的最远结束：特效块超出画面轨时成片变长，特效块与音乐都铺到那里', () => {
    const { html, durationMs } = build({
      music: { jobId: 'music-1', offset: 0, volume: 1 },
      overlays: [
        ov('o1', 'lower-third', 4000, 3000, { track: 0 }),
        ov('o2', 'lower-third', 6000, 2500, { track: 1 }),
        ov('o3', 'lower-third', 0, 1000, { track: 0 }),
      ],
    })
    const doc = parse(html)
    expect(durationMs).toBe(8500)
    expect(doc.querySelector('#stage')?.getAttribute('data-duration')).toBe('8.5')
    expect(doc.querySelector('#stage > audio')?.getAttribute('data-duration')).toBe('8.5')
    expect(
      [...doc.querySelectorAll('[id^="ov-"]')].map((host) => [
        host.id,
        host.getAttribute('data-start'),
        host.getAttribute('data-duration'),
      ]),
    ).toEqual([
      ['ov-0', '4', '3'],
      ['ov-1', '6', '2.5'],
      ['ov-2', '0', '1'],
    ])
    // 没有超出画面轨的特效块时，成片就是画面轨的长度
    expect(build({ overlays: [ov('o', 'lower-third', 0, 1000)] }).durationMs).toBe(5000)
  })

  it('字幕组件经 words 变量拿到成片秒数的逐词数据；没有字幕时不放字幕', () => {
    const doc = parse(build().html)
    const captions = doc.querySelector('#captions')
    expect(captions?.getAttribute('data-composition-src')).toBe(
      'compositions/iclip/default-caption.html',
    )
    expect(captions?.getAttribute('data-duration')).toBe('5')
    // a 段从素材 0.5 秒开始：「你好。」中点 0.5 秒，在段内，换算后从 0 开始。
    expect(variablesOf(captions)).toEqual({
      words: [{ text: '你好。', start: 0, end: 0.5, sentence: 0 }],
    })

    const silent = buildComposition({
      draft: draft(),
      media: { ...MEDIA, subtitles: {} },
      catalog: CATALOG,
    })
    expect(parse(silent.html).querySelector('#captions')).toBeNull()
  })

  it('关掉字幕：有字幕也不放字幕宿主，不引字幕组件的字体；打开时与没写开关一样', () => {
    const captions = { component: 'default-caption', edits: [] }
    const hidden = parse(build({ captions: { ...captions, hidden: true } }).html)
    expect(hidden.querySelector('#captions')).toBeNull()
    expect(hidden.querySelector('[data-composition-id="default-caption"]')).toBeNull()
    const links = [...hidden.querySelectorAll('link')].map((node) => node.getAttribute('href'))
    expect(links).toEqual(['vendor/fonts/noto-sans-sc.css'])

    const shown = build({ captions: { ...captions, hidden: false } }).html
    expect(parse(shown).querySelector('#captions')).not.toBeNull()
    expect(shown).toBe(build().html)
  })

  // 按固定尺寸设计的组件 z-index 写在外层盒子上，铺满的写在宿主上。
  /** 宿主或它最近的、行内样式写着 z-index 的外层（缩放盒子、.place）的叠放次序 */
  const zOf = (doc: Document, selector: string) => {
    for (let node = doc.querySelector(selector); node !== null; node = node.parentElement) {
      const z = /z-index:(\d+)/.exec(node.getAttribute('style') ?? '')?.[1]
      if (z !== undefined) return Number(z)
    }
    return Number.NaN
  }

  it('叠放：画面轨（组件段也算）< 整层特效 < 字幕，特效块的 zIndex 再大也不越出这一层', () => {
    const { html } = build({
      layer0: [vid('a', 0, 3000), comp('c', 3000, 2000, 'end-card')],
      overlays: [ov('o1', 'lower-third', 1000, 3000, { zIndex: 999 })],
    })
    const doc = parse(html)
    const css = (rule: string) =>
      Number(new RegExp(`${rule}\\{[^}]*z-index:(\\d+)`).exec(html)?.[1])
    const layer = doc.querySelector('#stage > .overlays')
    expect(layer?.querySelector('#ov-0')).not.toBeNull()
    expect(zOf(doc, '#clip-1')).toBe(css('\\.layer0'))
    expect(css('\\.overlays')).toBeGreaterThan(css('\\.layer0'))
    expect(zOf(doc, '#captions')).toBeGreaterThan(css('\\.overlays'))
    expect(doc.querySelector('#captions')?.closest('.place')?.parentElement?.id).toBe('stage')
    expect(zOf(doc, '#ov-0')).toBe(999)
  })

  it('特效块之间按 zIndex 叠，相同时草稿里后面的在上；不看 track', () => {
    const { html } = build({
      overlays: [
        ov('top-row-low-z', 'lower-third', 0, 2000, { track: 0, zIndex: 1 }),
        ov('low-row-high-z', 'stat-card', 0, 2000, { track: 3, zIndex: 5 }),
        ov('tie-first', 'lower-third', 0, 2000, { track: 1, zIndex: 2 }),
        ov('tie-second', 'stat-card', 0, 2000, { track: 2, zIndex: 2 }),
      ],
    })
    const doc = parse(html)
    expect(['#ov-0', '#ov-1', '#ov-2', '#ov-3'].map((id) => zOf(doc, id))).toEqual([1, 5, 2, 2])
    // 同一 z 时页面上后写的在上：页面按草稿里的先后写，与 track 无关。
    const order = [...doc.querySelectorAll('.overlays [id^="ov-"]')].map((host) => host.id)
    expect(order).toEqual(['ov-0', 'ov-1', 'ov-2', 'ov-3'])
    const swapped = build({
      overlays: [
        ov('a', 'lower-third', 0, 2000, { track: 2, zIndex: 1 }),
        ov('b', 'stat-card', 0, 2000, { track: 0, zIndex: 1 }),
      ],
    })
    const sameTracks = build({
      overlays: [
        ov('a', 'lower-third', 0, 2000, { track: 0, zIndex: 1 }),
        ov('b', 'stat-card', 0, 2000, { track: 0, zIndex: 1 }),
      ],
    })
    expect(swapped.html).toBe(sameTracks.html)
  })

  it('用户文字里的引号、尖括号、& 原样进出属性，不会变成标签', () => {
    const hostile = `"><script>alert('x')</script>&amp; '`
    const { html } = buildComposition({
      draft: draft({
        layer0: [vid('a', 0, 3000)],
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: 'sub-a', sentenceIndex: 0, text: hostile }],
        },
        overlays: [ov('o1', 'lower-third', 0, 1000, { variables: { title: hostile } })],
      }),
      media: MEDIA,
      catalog: CATALOG,
    })
    const doc = parse(html)
    expect(doc.querySelectorAll('script')).toHaveLength(3)
    expect(variablesOf(doc.querySelector('#ov-0'))).toEqual({ title: hostile })
    const captions = variablesOf(doc.querySelector('#captions')) as { words: { text: string }[] }
    const captionText = captions.words.map((word) => word.text).join('')
    expect(captionText).toBe(hostile.replace(/\s/g, ''))
  })

  it('除了调用方给的素材地址，页面里没有任何外部地址；运行时与 GSAP 从组件目录加载', () => {
    const { html } = build({
      music: { jobId: 'music-1', offset: 0, volume: 1 },
      overlays: [ov('o1', 'lower-third', 0, 1000), ov('o2', 'scribble', 2000, 2000)],
    })
    const doc = parse(html)
    const scripts = [...doc.querySelectorAll('script[src]')].map((node) => node.getAttribute('src'))
    expect(scripts).toEqual(['vendor/gsap/gsap.min.js', 'vendor/hf/runtime.js'])
    let rest = html
    for (const url of [
      'https://oss.example.com/a.mp4?sig=1&amp;x=2',
      'https://oss.example.com/b.mp4',
      'https://oss.example.com/music.mp3',
    ]) {
      rest = rest.replaceAll(url, '')
    }
    expect(rest).not.toMatch(/https?:\/\//)
  })

  it('字体：页面默认用 Noto Sans SC，并引用用到的组件的网页字体 CSS，没用到的不引用', () => {
    const doc = parse(
      build({
        overlays: [ov('o1', 'lower-third', 0, 1000), ov('o2', 'stat-card', 1000, 1000)],
      }).html,
    )
    const links = [...doc.querySelectorAll('head link[rel="stylesheet"]')].map((node) =>
      node.getAttribute('href'),
    )
    // 字幕组件 default-caption 也在页面上（有字幕），它的 Anton 一并引用；按字体名排序、去重。
    expect(links).toEqual([
      'vendor/fonts/noto-sans-sc.css',
      'vendor/fonts/families/anton.css',
      'vendor/fonts/families/dm-sans.css',
      'vendor/fonts/families/inter.css',
    ])
    expect(doc.querySelector('style')?.textContent).toMatch(
      /html,body\{[^}]*font-family:'Noto Sans SC',sans-serif/,
    )

    const silent = buildComposition({
      draft: draft(),
      media: { ...MEDIA, subtitles: {} },
      catalog: CATALOG,
    })
    const silentLinks = [...parse(silent.html).querySelectorAll('link')].map((node) =>
      node.getAttribute('href'),
    )
    expect(silentLinks).toEqual(['vendor/fonts/noto-sans-sc.css'])
  })

  it('组件目录给组件列了字体却没有对应的 CSS 时报错', () => {
    const broken: ComponentCatalog = { ...CATALOG, fonts: {} }
    expect(() =>
      buildComposition({
        draft: draft({ overlays: [ov('o', 'lower-third', 0, 500)] }),
        media: { ...MEDIA, subtitles: {} },
        catalog: broken,
      }),
    ).toThrow('组件目录缺少字体「Inter」的 CSS')
  })

  it('页面里的 id 各不相同，与草稿里的 id 无关', () => {
    const { html } = build({
      layer0: [vid('same', 0, 3000), comp('stage', 3000, 1000, 'end-card'), vid('x', 4000, 1000)],
      overlays: [ov('same', 'lower-third', 0, 1000), ov('same', 'lower-third', 2000, 1000)],
    })
    const doc = parse(html)
    const ids = [...doc.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['stage', 'clip-0', 'clip-1', 'clip-2', 'ov-0', 'ov-1', 'captions'])
  })

  it('每一块的最外层写着草稿 id：视频、画面轨组件段的宿主或缩放盒子、特效块与字幕外面的 .place', () => {
    const doc = parse(
      build({
        layer0: [
          vid('v1', 0, 2000),
          comp('c1', 2000, 1000, 'logo-intro'),
          comp('c2', 3000, 1000, 'end-card'),
        ],
        overlays: [ov('o1', 'lower-third', 0, 1000), ov('o"2', 'scribble', 0, 1000)],
      }).html,
    )
    const marked = [...doc.querySelectorAll('[data-hf-id]')].map((node) => ({
      hfId: node.getAttribute('data-hf-id'),
      element: node.matches('video') ? 'video' : node.className,
      host: node.matches('[data-composition-src]')
        ? node.id
        : node.querySelector('[data-composition-src]')?.id,
      inner: node.matches('.place') ? node.firstElementChild?.className : undefined,
    }))
    expect(marked).toEqual([
      { hfId: 'v1', element: 'video', host: undefined, inner: undefined },
      { hfId: 'c1', element: 'fit', host: 'clip-1', inner: undefined },
      { hfId: 'c2', element: 'fill', host: 'clip-2', inner: undefined },
      { hfId: 'o1', element: 'place', host: 'ov-0', inner: 'fill' },
      { hfId: 'o"2', element: 'place', host: 'ov-1', inner: 'fit' },
      { hfId: 'captions', element: 'place', host: 'captions', inner: 'fill' },
    ])
    // 外层里面的缩放盒子与宿主不另写
    for (const inner of ['#clip-1', '#ov-0', '#ov-1', '#captions']) {
      expect(doc.querySelector(inner)?.hasAttribute('data-hf-id')).toBe(false)
    }
    expect(doc.querySelector('#ov-1')?.parentElement?.hasAttribute('data-hf-id')).toBe(false)
    // 特效块、字幕外层上的叠放次序；里面的宿主与缩放盒子不再写
    const place = (hfId: string) => doc.querySelector(`.place[data-hf-id="${hfId}"]`)
    expect(place('o1')?.getAttribute('style')).toBe('z-index:1')
    expect(place('captions')?.getAttribute('style')).toBe('z-index:3')
    expect(doc.querySelector('#ov-0')?.hasAttribute('style')).toBe(false)
    expect(doc.querySelector('#ov-1')?.parentElement?.getAttribute('style')).not.toMatch(/z-index/)
  })

  it('固定尺寸的字幕组件：captions 写在缩放盒子上', () => {
    const catalog = {
      ...CATALOG,
      items: CATALOG.items.map((entry) =>
        entry.name === 'default-caption'
          ? { ...entry, size: { width: 1080, height: 1920 } }
          : entry,
      ),
    }
    const doc = parse(
      buildComposition({
        draft: draft({ captions: { component: 'default-caption', edits: [], x: 0, y: 60 } }),
        media: MEDIA,
        catalog,
      }).html,
    )
    const place = doc.querySelector('[data-hf-id="captions"]')
    expect(place?.className).toBe('place')
    expect(place?.querySelector(':scope > .fit > #captions')).not.toBeNull()
    expect(place?.getAttribute('data-y')).toBe('60')
    expect(place?.getAttribute('style')).toBe('z-index:3')
  })

  it('挪过位置的特效块与字幕：位置写在外层 .place 上，基准是 0', () => {
    const doc = parse(
      build({
        layer0: [vid('v1', 0, 2000), comp('c1', 2000, 1000, 'end-card')],
        captions: { component: 'default-caption', edits: [], x: 0, y: -240 },
        overlays: [
          ov('o1', 'lower-third', 0, 1000, { x: -36, y: 410 }),
          ov('o2', 'scribble', 0, 1000, { x: 120, y: 0 }),
          ov('o3', 'lower-third', 1000, 1000, { x: 0, y: 0 }),
        ],
      }).html,
    )
    const positioned = [...doc.querySelectorAll('[data-hf-edit-base-x]')].map((node) => ({
      hfId: node.getAttribute('data-hf-id'),
      element: node.className,
      x: node.getAttribute('data-x'),
      y: node.getAttribute('data-y'),
      base: [node.getAttribute('data-hf-edit-base-x'), node.getAttribute('data-hf-edit-base-y')],
    }))
    // 铺满的与固定尺寸的都写在外层；没挪过的块与画面轨上的段不写
    expect(positioned).toEqual([
      { hfId: 'o1', element: 'place', x: '-36', y: '410', base: ['0', '0'] },
      { hfId: 'o2', element: 'place', x: '120', y: '0', base: ['0', '0'] },
      { hfId: 'captions', element: 'place', x: '0', y: '-240', base: ['0', '0'] },
    ])
    expect(doc.querySelectorAll('[data-x], [data-y], [data-hf-edit-base-y]')).toHaveLength(3)
  })

  it('缩放、旋转过的特效块与字幕：外层写 rotate、scale，绕记下的转轴，没写时转轴是 (0, 0)', () => {
    const doc = parse(
      build({
        captions: {
          component: 'default-caption',
          edits: [],
          scale: 0.8,
          rotation: 0,
          pivotX: 360,
          pivotY: 1100,
        },
        overlays: [
          ov('o1', 'lower-third', 0, 1000, {
            x: 40,
            y: -20,
            scale: 1.5,
            rotation: 30,
            pivotX: 100,
            pivotY: -12,
          }),
          ov('o2', 'scribble', 0, 1000, { rotation: -90.5, zIndex: 4 }),
          ov('o3', 'lower-third', 0, 1000, { scale: 1, rotation: 0, pivotX: 5, pivotY: 6 }),
        ],
      }).html,
    )
    const styleOf = (hfId: string) =>
      doc.querySelector(`.place[data-hf-id="${hfId}"]`)?.getAttribute('style')
    expect(styleOf('o1')).toBe('z-index:1;rotate:30deg;scale:1.5;transform-origin:100px -12px')
    // 有这几个字段之前存的草稿没写转轴，同 x、y 按 0 读
    expect(styleOf('o2')).toBe('z-index:4;rotate:-90.5deg;scale:1;transform-origin:0px 0px')
    expect(styleOf('captions')).toBe(
      'z-index:3;rotate:0deg;scale:0.8;transform-origin:360px 1100px',
    )
    // 原大、不转时转轴记着也不写
    expect(styleOf('o3')).toBe('z-index:1')
    // 位置照写 data-x/y，宿主本身不变换
    expect(doc.querySelector('.place[data-hf-id="o1"]')?.getAttribute('data-x')).toBe('40')
    expect(doc.querySelector('#ov-0')?.hasAttribute('style')).toBe(false)
  })

  it('原大、不转、没挪过时页面与没写这些字段的草稿一字不差，外层只写叠放次序', () => {
    const layer0 = [vid('v1', 0, 2000), comp('c1', 2000, 1000, 'logo-intro')]
    const unset = build({
      layer0,
      overlays: [ov('o1', 'lower-third', 0, 1000), ov('o2', 'scribble', 0, 1000)],
    }).html
    const identity = { x: 0, y: 0, scale: 1, rotation: 0, pivotX: 0, pivotY: 0 }
    const written = build({
      layer0,
      captions: { component: 'default-caption', edits: [], ...identity },
      overlays: [
        ov('o1', 'lower-third', 0, 1000, identity),
        ov('o2', 'scribble', 0, 1000, identity),
      ],
    }).html
    expect(written).toBe(unset)
    expect(unset).not.toMatch(/data-x|data-y|data-hf-edit-base|rotate:|scale:|transform-origin/)
    const doc = parse(unset)
    expect([...doc.querySelectorAll('.place')].map((node) => node.getAttribute('style'))).toEqual([
      'z-index:1',
      'z-index:1',
      'z-index:3',
    ])
  })

  it('子合成宿主的 data-composition-id 是组件名，同一组件挂多处时各带各的可填项', () => {
    const { html } = build({
      layer0: [
        comp('c1', 0, 2000, 'logo-intro', { variables: { wordmark: '拾步' } }),
        vid('a', 2000, 3000),
        comp('c2', 5000, 2000, 'logo-intro'),
      ],
      overlays: [
        ov('o1', 'lower-third', 2000, 1000, { variables: { title: '第一条' } }),
        ov('o2', 'lower-third', 4000, 1000, { variables: { title: '第二条' } }),
      ],
    })
    const doc = parse(html)
    const hosts = [...doc.querySelectorAll('[data-composition-src]')].map((host) => ({
      id: host.id,
      compositionId: host.getAttribute('data-composition-id'),
      values: variablesOf(host),
    }))
    expect(hosts).toEqual([
      { id: 'clip-0', compositionId: 'logo-intro', values: { wordmark: '拾步', tone: 'warm' } },
      { id: 'clip-2', compositionId: 'logo-intro', values: { wordmark: '品牌名', tone: 'warm' } },
      { id: 'ov-0', compositionId: 'lower-third', values: { title: '第一条' } },
      { id: 'ov-1', compositionId: 'lower-third', values: { title: '第二条' } },
      { id: 'captions', compositionId: 'default-caption', values: expect.any(Object) },
    ])
  })

  it.each<[string, Partial<WholeFilmDraft>, CompositionMedia, string]>([
    ['成片为空', { canvas: null, layer0: [] }, MEDIA, 'invalid-draft'],
    ['特效块的组件不在目录里', { overlays: [ov('o', 'nope', 0, 500)] }, MEDIA, 'unknown-component'],
    ['组件段的组件不在目录里', { layer0: [comp('c', 0, 500, 'nope')] }, MEDIA, 'unknown-component'],
    ['被排除的组件', { overlays: [ov('o', 'showreel', 0, 500)] }, MEDIA, 'unknown-component'],
    ['素材片缺地址', {}, { ...MEDIA, videos: {} }, 'missing-media'],
    [
      '配乐缺地址',
      { music: { jobId: 'm', offset: 0, volume: 1 } },
      { ...MEDIA, music: null },
      'missing-media',
    ],
  ])('%s时抛出 CompositionError（%#）', (_, spec, media, code) => {
    const run = () => buildComposition({ draft: draft(spec), media, catalog: CATALOG })
    expect(run).toThrow(CompositionError)
    try {
      run()
    } catch (error) {
      expect((error as CompositionError).code).toBe(code)
    }
  })

  it('组件目录的 placement 不限制组件放在哪：字幕样式以外的组件在画面轨、特效轨都能合成', () => {
    const doc = parse(
      build({
        layer0: [comp('c', 0, 1000, 'lower-third'), vid('a', 1000, 1000)],
        overlays: [ov('o', 'logo-intro', 0, 1000)],
      }).html,
    )
    expect(doc.querySelector('#clip-0')?.getAttribute('data-composition-id')).toBe('lower-third')
    expect(doc.querySelector('#ov-0')?.getAttribute('data-composition-id')).toBe('logo-intro')
  })
})

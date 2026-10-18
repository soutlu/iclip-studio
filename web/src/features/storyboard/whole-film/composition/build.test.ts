import { describe, expect, it } from 'vitest'
import type { WholeFilmDocument as WholeFilmDraft } from '@/shared/api/generated'
import { buildComposition, CompositionError, type CompositionMedia } from './build'
import type { CatalogItem, ComponentCatalog } from './catalog'

const item = (
  spec: Partial<CatalogItem> & Pick<CatalogItem, 'name' | 'placement'>,
): CatalogItem => ({
  kind: 'component',
  title: spec.name,
  description: '',
  category: 'scenes',
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
      placement: 'intro',
      kind: 'block',
      size: { width: 1920, height: 1080 },
      duration: 4,
      variables: [
        { id: 'wordmark', type: 'string', label: '品牌名', default: '品牌名' },
        { id: 'tone', type: 'enum', label: '色调', default: 'warm' },
      ],
    }),
    item({ name: 'end-card', placement: 'outro' }),
    item({
      name: 'lower-third',
      placement: 'overlay',
      variables: [{ id: 'title', type: 'string', label: '标题', default: '标题' }],
      fonts: ['Inter'],
    }),
    item({ name: 'stat-card', placement: 'overlay', fonts: ['DM Sans', 'Inter'] }),
    item({
      name: 'scribble',
      placement: 'transition',
      kind: 'block',
      size: { width: 1920, height: 1080 },
      duration: 2,
      transition: { kind: 'overlay', cutAt: 0.5 },
    }),
    item({
      name: 'fade-through',
      placement: 'transition',
      duration: 0.9,
      variables: [{ id: 'wash', type: 'enum', label: '中间色', default: 'paper' }],
      transition: {
        kind: 'layers',
        cutAt: 0.5,
        out: { from: { opacity: 1 }, to: { opacity: 0 }, ease: 'power2.inOut' },
        in: { from: { opacity: 0 }, to: { opacity: 1 }, ease: 'power2.out' },
      },
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

const draft = (spec: Partial<WholeFilmDraft> = {}): WholeFilmDraft => ({
  canvas: { width: 720, height: 1280 },
  layer0: [
    {
      id: 'a',
      type: 'video',
      start: 0,
      duration: 3000,
      playbackStart: 500,
      sourceJobId: 'job-a',
      volume: 1.5,
    },
    {
      id: 'b',
      type: 'video',
      start: 3000,
      duration: 2000,
      playbackStart: 0,
      sourceJobId: 'job-b',
      volume: 0,
    },
  ],
  transitions: [],
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
  it('第 0 层每段画面是一个 video：整片时间、素材入点与音量写成 HyperFrames 属性', () => {
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

  it('片头片尾是第 0 层的子合成：目录默认值打底、草稿取值覆盖，按固定尺寸设计的完整放进画面', () => {
    const { html, durationMs } = build({
      layer0: [
        {
          id: 'intro',
          type: 'component',
          role: 'intro',
          start: 0,
          duration: 2000,
          component: 'logo-intro',
          variables: { wordmark: '拾步' },
        },
        {
          id: 'a',
          type: 'video',
          start: 2000,
          duration: 1000,
          playbackStart: 0,
          sourceJobId: 'job-a',
          volume: 1,
        },
        {
          id: 'outro',
          type: 'component',
          role: 'outro',
          start: 3000,
          duration: 1500,
          component: 'end-card',
          variables: {},
        },
      ],
    })
    const doc = parse(html)
    const intro = doc.querySelector('#clip-0')
    expect(durationMs).toBe(4500)
    expect(intro?.getAttribute('data-composition-src')).toBe('compositions/logo-intro.html')
    expect(intro?.getAttribute('data-start')).toBe('0')
    expect(intro?.getAttribute('data-duration')).toBe('2')
    expect(intro?.getAttribute('data-playback-start')).toBe('0')
    expect(intro?.getAttribute('data-track-index')).toBe('0')
    expect(variablesOf(intro)).toEqual({ wordmark: '拾步', tone: 'warm' })
    // 1920×1080 放进 720×1280：按宽缩到 0.375。
    expect(intro?.parentElement?.getAttribute('style')).toContain('scale(0.375)')
    const outro = doc.querySelector('#clip-2')
    expect(outro?.getAttribute('data-start')).toBe('3')
    expect(outro?.parentElement?.id).toBe('stage')
  })

  it('配乐铺满整片：从 0 开始，素材里的起点与音量写进 audio', () => {
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

  it('包装是单独一轨的子合成，带各自的起止与可填项', () => {
    const doc = parse(
      build({
        overlays: [
          {
            id: 'o1',
            component: 'lower-third',
            start: 500,
            duration: 1500,
            variables: { title: '新品' },
          },
          { id: 'o2', component: 'lower-third', start: 3000, duration: 1000, variables: {} },
        ],
      }).html,
    )
    const hosts = [
      ...doc.querySelectorAll('[data-composition-src="compositions/lower-third.html"]'),
    ]
    expect(
      hosts.map((host) => [host.getAttribute('data-start'), host.getAttribute('data-duration')]),
    ).toEqual([
      ['0.5', '1.5'],
      ['3', '1'],
    ])
    expect(new Set(hosts.map((host) => host.getAttribute('data-track-index')))).toEqual(
      new Set(['3']),
    )
    expect(hosts.map(variablesOf)).toEqual([{ title: '新品' }, { title: '标题' }])
  })

  it('字幕组件经 words 变量拿到整片秒数的逐词数据；没有字幕时不放字幕', () => {
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

  it('盖满画面的转场以切点为准放置，按固定尺寸设计的同样完整放进画面', () => {
    const doc = parse(
      build({
        transitions: [
          { id: 't1', afterClipId: 'a', component: 'scribble', duration: 2000, variables: {} },
        ],
      }).html,
    )
    const host = doc.querySelector('#tr-0')
    // 原定 2 秒、一半处盖满：切点 3 秒前 1 秒开始。
    expect(host?.getAttribute('data-start')).toBe('2')
    expect(host?.getAttribute('data-duration')).toBe('2')
    // 1920×1080 放进 720×1280：按宽缩到 0.375，与其他组件一样。
    expect(host?.parentElement?.getAttribute('style')).toContain('scale(0.375)')
  })

  it('叠放：画面 < 特效（转场也算，按草稿里的先后，后加的在上）< 字幕', () => {
    const { html } = build({
      layer0: [
        {
          id: 'a',
          type: 'video',
          start: 0,
          duration: 3000,
          playbackStart: 0,
          sourceJobId: 'job-a',
          volume: 1,
        },
        {
          id: 'outro',
          type: 'component',
          role: 'outro',
          start: 3000,
          duration: 2000,
          component: 'end-card',
          variables: {},
        },
      ],
      transitions: [
        { id: 't1', afterClipId: 'a', component: 'scribble', duration: 2000, variables: {} },
      ],
      // 后加的先开始：叠放跟草稿里的先后走，不跟开始时间走。
      overlays: [
        { id: 'first', component: 'lower-third', start: 3000, duration: 1000, variables: {} },
        { id: 'second', component: 'stat-card', start: 500, duration: 1000, variables: {} },
      ],
    })
    const doc = parse(html)
    // 按固定尺寸设计的组件 z-index 写在外层盒子上，铺满的写在宿主上。
    const z = (selector: string) => {
      const host = doc.querySelector(selector)
      const style = host?.getAttribute('style') ?? host?.parentElement?.getAttribute('style') ?? ''
      return Number(/z-index:(\d+)/.exec(style)?.[1])
    }
    const videoZ = Number(/\.layer0\{[^}]*z-index:(\d+)/.exec(html)?.[1])
    expect(new Set(['#tr-0', '#ov-0', '#ov-1'].map(z)).size).toBe(1)
    expect(z('#clip-1')).toBe(videoZ)
    expect(z('#ov-0')).toBeGreaterThan(videoZ)
    expect(z('#captions')).toBeGreaterThan(z('#ov-0'))
    // 同一层里页面上后写的在上：转场在前，特效按草稿里的先后。
    const order = [...doc.querySelectorAll('#tr-0, #ov-0, #ov-1')].map((host) =>
      host.getAttribute('data-composition-id'),
    )
    expect(order).toEqual(['scribble', 'lower-third', 'stat-card'])
  })

  it('要挂前后两段的转场：前一段在切点前做 out，后一段在切点后做 in，只作用于这一个切点', () => {
    const { html } = build({
      layer0: [
        {
          id: 'a',
          type: 'video',
          start: 0,
          duration: 3000,
          playbackStart: 0,
          sourceJobId: 'job-a',
          volume: 1,
        },
        {
          id: 'b',
          type: 'video',
          start: 3000,
          duration: 2000,
          playbackStart: 0,
          sourceJobId: 'job-b',
          volume: 1,
        },
        {
          id: 'c',
          type: 'video',
          start: 5000,
          duration: 2000,
          playbackStart: 0,
          sourceJobId: 'job-b',
          volume: 1,
        },
      ],
      transitions: [
        {
          id: 't1',
          afterClipId: 'b',
          component: 'fade-through',
          duration: 900,
          variables: { wash: 'ink' },
        },
      ],
    })
    const doc = parse(html)
    const host = doc.querySelector('#tr-0')
    expect(host?.getAttribute('data-start')).toBe('4.55')
    expect(host?.getAttribute('data-duration')).toBe('0.9')
    expect(variablesOf(host)).toEqual({ wash: 'ink' })
    const script = [...doc.querySelectorAll('script:not([src])')]
      .map((node) => node.textContent)
      .join('\n')
    const tweens = JSON.parse(/(\[.*\])\.forEach/.exec(script)?.[1] ?? '[]')
    expect(tweens).toEqual([
      {
        target: 'clip-1',
        from: { opacity: 1 },
        to: { opacity: 0 },
        ease: 'power2.inOut',
        at: 4.55,
        duration: 0.45,
      },
      {
        target: 'clip-2',
        from: { opacity: 0 },
        to: { opacity: 1 },
        ease: 'power2.out',
        at: 5,
        duration: 0.45,
      },
    ])
  })

  it('用户文字里的引号、尖括号、& 原样进出属性，不会变成标签', () => {
    const hostile = `"><script>alert('x')</script>&amp; '`
    const { html } = buildComposition({
      draft: draft({
        layer0: [
          {
            id: 'a',
            type: 'video',
            start: 0,
            duration: 3000,
            playbackStart: 0,
            sourceJobId: 'job-a',
            volume: 1,
          },
        ],
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: 'sub-a', sentenceIndex: 0, text: hostile }],
        },
        overlays: [
          {
            id: 'o1',
            component: 'lower-third',
            start: 0,
            duration: 1000,
            variables: { title: hostile },
          },
        ],
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
      overlays: [{ id: 'o1', component: 'lower-third', start: 0, duration: 1000, variables: {} }],
      transitions: [
        { id: 't1', afterClipId: 'a', component: 'scribble', duration: 2000, variables: {} },
      ],
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
        overlays: [
          { id: 'o1', component: 'lower-third', start: 0, duration: 1000, variables: {} },
          { id: 'o2', component: 'stat-card', start: 1000, duration: 1000, variables: {} },
        ],
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
        draft: draft({
          overlays: [{ id: 'o', component: 'lower-third', start: 0, duration: 500, variables: {} }],
        }),
        media: { ...MEDIA, subtitles: {} },
        catalog: broken,
      }),
    ).toThrow('组件目录缺少字体「Inter」的 CSS')
  })

  it('页面里的 id 各不相同，与草稿里的 id 无关', () => {
    const { html } = build({
      layer0: [
        {
          id: 'same',
          type: 'video',
          start: 0,
          duration: 3000,
          playbackStart: 0,
          sourceJobId: 'job-a',
          volume: 1,
        },
        {
          id: 'stage',
          type: 'video',
          start: 3000,
          duration: 2000,
          playbackStart: 0,
          sourceJobId: 'job-b',
          volume: 1,
        },
      ],
      transitions: [
        {
          id: 'same',
          afterClipId: 'same',
          component: 'fade-through',
          duration: 900,
          variables: {},
        },
      ],
      overlays: [
        { id: 'same', component: 'lower-third', start: 0, duration: 1000, variables: {} },
        { id: 'same', component: 'lower-third', start: 2000, duration: 1000, variables: {} },
      ],
    })
    const doc = parse(html)
    const ids = [...doc.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['stage', 'clip-0', 'clip-1', 'tr-0', 'ov-0', 'ov-1', 'captions'])
  })

  it('子合成宿主的 data-composition-id 是组件名，同一组件挂多处时各带各的可填项', () => {
    const { html } = build({
      layer0: [
        {
          id: 'intro',
          type: 'component',
          role: 'intro',
          start: 0,
          duration: 2000,
          component: 'logo-intro',
          variables: { wordmark: '拾步' },
        },
        {
          id: 'a',
          type: 'video',
          start: 2000,
          duration: 3000,
          playbackStart: 0,
          sourceJobId: 'job-a',
          volume: 1,
        },
        {
          id: 'b',
          type: 'video',
          start: 5000,
          duration: 2000,
          playbackStart: 0,
          sourceJobId: 'job-b',
          volume: 1,
        },
      ],
      transitions: [
        { id: 't', afterClipId: 'a', component: 'fade-through', duration: 900, variables: {} },
      ],
      overlays: [
        {
          id: 'o1',
          component: 'lower-third',
          start: 2000,
          duration: 1000,
          variables: { title: '第一条' },
        },
        {
          id: 'o2',
          component: 'lower-third',
          start: 4000,
          duration: 1000,
          variables: { title: '第二条' },
        },
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
      { id: 'tr-0', compositionId: 'fade-through', values: { wash: 'paper' } },
      { id: 'ov-0', compositionId: 'lower-third', values: { title: '第一条' } },
      { id: 'ov-1', compositionId: 'lower-third', values: { title: '第二条' } },
      { id: 'captions', compositionId: 'default-caption', values: expect.any(Object) },
    ])
  })

  it.each<[string, Partial<WholeFilmDraft>, CompositionMedia, string]>([
    ['成片为空', { canvas: null, layer0: [] }, MEDIA, 'invalid-draft'],
    [
      '组件不在目录里',
      { overlays: [{ id: 'o', component: 'nope', start: 0, duration: 500, variables: {} }] },
      MEDIA,
      'unknown-component',
    ],
    [
      '被排除的组件',
      { overlays: [{ id: 'o', component: 'showreel', start: 0, duration: 500, variables: {} }] },
      MEDIA,
      'unknown-component',
    ],
    [
      '片尾组件当包装',
      { overlays: [{ id: 'o', component: 'end-card', start: 0, duration: 500, variables: {} }] },
      MEDIA,
      'misplaced-component',
    ],
    [
      '转场接在最后一段后面',
      {
        transitions: [
          { id: 't', afterClipId: 'b', component: 'scribble', duration: 2000, variables: {} },
        ],
      },
      MEDIA,
      'invalid-draft',
    ],
    [
      '转场越过后一段的结尾',
      {
        layer0: [
          {
            id: 'a',
            type: 'video',
            start: 0,
            duration: 3000,
            playbackStart: 0,
            sourceJobId: 'job-a',
            volume: 1,
          },
          {
            id: 'b',
            type: 'video',
            start: 3000,
            duration: 500,
            playbackStart: 0,
            sourceJobId: 'job-b',
            volume: 1,
          },
          {
            id: 'c',
            type: 'video',
            start: 3500,
            duration: 2000,
            playbackStart: 0,
            sourceJobId: 'job-b',
            volume: 1,
          },
        ],
        transitions: [
          { id: 't', afterClipId: 'a', component: 'scribble', duration: 2000, variables: {} },
        ],
      },
      MEDIA,
      'invalid-draft',
    ],
    [
      '转场时长不是组件原定时长',
      {
        transitions: [
          { id: 't', afterClipId: 'a', component: 'scribble', duration: 1000, variables: {} },
        ],
      },
      MEDIA,
      'invalid-draft',
    ],
    [
      '转场超出整片开头',
      {
        layer0: [
          {
            id: 'a',
            type: 'video',
            start: 0,
            duration: 500,
            playbackStart: 0,
            sourceJobId: 'job-a',
            volume: 1,
          },
          {
            id: 'b',
            type: 'video',
            start: 500,
            duration: 2000,
            playbackStart: 0,
            sourceJobId: 'job-b',
            volume: 1,
          },
        ],
        transitions: [
          { id: 't', afterClipId: 'a', component: 'scribble', duration: 2000, variables: {} },
        ],
      },
      MEDIA,
      'invalid-draft',
    ],
    ['成片缺地址', {}, { ...MEDIA, videos: {} }, 'missing-media'],
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
})

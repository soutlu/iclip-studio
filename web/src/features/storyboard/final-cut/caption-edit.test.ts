import { describe, expect, it } from 'vitest'
import { audio, caption as captionClip, host, video } from '@/testing/final-cut'
import {
  captionClock,
  captionsFocus,
  captionsFollowing,
  captionSpot,
  captionsInOrder,
  dubsFollowing,
  placeCaptions,
  recognitionTargets,
  recognizedCaptions,
  sentenceCaptions,
  splitOwners,
} from './caption-edit'
import { splitAt } from './clip-edit'
import type { FilmClip, VideoClip } from './composition/film'
import { spanPieces } from './materials'

const caption = (id: string, start: number, duration: number) => ({ id, start, duration })

describe('在播放头处加一句字幕', () => {
  it('没有字幕时从播放头起放 2 秒', () => {
    expect(captionSpot([], 1500)).toEqual({ start: 1500, duration: 2000 })
  })

  it('后面的字幕离得远时照样 2 秒，前面的字幕不碍事', () => {
    expect(captionSpot([caption('a', 0, 1000), caption('b', 5000, 1000)], 1000)).toEqual({
      start: 1000,
      duration: 2000,
    })
  })

  it('碰到后面的字幕时缩短到碰到为止', () => {
    expect(captionSpot([caption('b', 2200, 1000)], 1000)).toEqual({ start: 1000, duration: 1200 })
  })

  it('播放头处已有字幕时不能加，正好在一句的结尾处可以加', () => {
    expect(captionSpot([caption('a', 1000, 2000)], 1000)).toEqual({ refusal: 'taken' })
    expect(captionSpot([caption('a', 1000, 2000)], 2999)).toEqual({ refusal: 'taken' })
    expect(captionSpot([caption('a', 1000, 2000)], 3000)).toEqual({ start: 3000, duration: 2000 })
  })

  it('离下一句不到 0.1 秒时不能加，正好 0.1 秒可以', () => {
    expect(captionSpot([caption('b', 1050, 1000)], 1000)).toEqual({ refusal: 'tight' })
    expect(captionSpot([caption('b', 1100, 1000)], 1000)).toEqual({ start: 1000, duration: 100 })
  })
})

describe('字幕列表里的时间', () => {
  it('分:秒，秒带两位小数', () => {
    expect([0, 1500, 61_005, 600_000].map(captionClock)).toEqual([
      '00:00.00',
      '00:01.50',
      '01:01.01',
      '10:00.00',
    ])
  })
})

describe('字幕的先后', () => {
  it('按开始时间排，一样时按编号', () => {
    const ordered = captionsInOrder([caption('c', 3000, 1), caption('b', 0, 1), caption('a', 0, 1)])
    expect(ordered.map((each) => each.id)).toEqual(['a', 'b', 'c'])
  })
})

/** 一句识别出来的话：在素材里的起止。 */
const said = (startMs: number, endMs: number, text = '一句话') => ({ startMs, endMs, text })

describe('识别出来的句子换算成 final-cut 里的字幕', () => {
  it('取片段用掉的那段素材里开头的句子，从入点算起；开头被裁掉的截到片段开头，结尾不截；不到 0.1 秒、字是空的不要', () => {
    // 片段从 final-cut 的 1 秒起、长 3 秒，用掉素材的 2–5 秒
    const clip = video({ id: 'v1', start: 1_000, mediaStart: 2_000, duration: 3_000 })
    expect(
      sentenceCaptions(
        clip,
        [
          said(1_000, 1_500, '入点之前'),
          said(1_800, 2_600, '跨着入点'),
          said(3_000, 4_000, ' 中间 '),
          said(4_500, 6_000, '跨着出点'),
          said(5_000, 5_500, '出点之后'),
          said(3_000, 3_050, '不到 0.1 秒'),
          said(3_000, 3_500, '  '),
        ],
        [clip],
      ),
    ).toEqual([
      { start: 1_000, duration: 600, text: '跨着入点', owner: 'v1' },
      { start: 2_000, duration: 1_000, text: '中间', owner: 'v1' },
      { start: 3_500, duration: 1_500, text: '跨着出点', owner: 'v1' },
    ])
  })

  it('速度不是 1：素材里的时间除以速度', () => {
    // 2 倍速：final-cut 里 2 秒用掉素材的 1–5 秒
    const clip = video({ id: 'v1', start: 0, mediaStart: 1_000, duration: 2_000, playbackRate: 2 })
    expect(sentenceCaptions(clip, [said(2_000, 3_000), said(4_000, 6_000)], [clip])).toEqual([
      { start: 500, duration: 500, text: '一句话', owner: 'v1' },
      { start: 1_500, duration: 1_000, text: '一句话', owner: 'v1' },
    ])
  })

  it('一句话跨过两个相接的片段：只在前一个片段名下写一条整句，时间是整句的；后一个片段不写这句', () => {
    // 素材 0.5–3.8 秒加进轨道、在 2.3 秒的镜头切口处拆成相接的两个片段：0–1.8 秒、1.8–3.3 秒
    const [first, second] = spanPieces({ startMs: 500, endMs: 3_800 }, [
      { startMs: 0, endMs: 2_300 },
      { startMs: 2_300, endMs: 6_000 },
    ])
    if (first === undefined || second === undefined) throw new Error('应该拆成两段')
    const clips = [
      video({ id: 'v1', start: 0, ...first }),
      video({ id: 'v2', start: first.duration, ...second }),
    ]
    const sentences = [
      said(1_000, 2_000, '前一句'),
      said(2_000, 3_000, '跨过接缝的一句'),
      said(3_000, 3_600, '后一句'),
    ]
    expect(recognizedCaptions(clips, new Map(clips.map((clip) => [clip.id, sentences])))).toEqual({
      captions: [
        { start: 500, duration: 1_000, text: '前一句', owner: 'v1' },
        { start: 1_500, duration: 1_000, text: '跨过接缝的一句', owner: 'v1' },
        { start: 2_500, duration: 600, text: '后一句', owner: 'v2' },
      ],
      skipped: 0,
      silent: [],
      elsewhere: [],
    })
  })

  it('后一个片段里只有跨过接缝那句的后半：列成有话、句子归别的片段，不算没有话；真的没话的只算没有话', () => {
    const clips = [
      video({ id: 'v1', start: 0, mediaStart: 0, duration: 2_000 }),
      video({ id: 'v2', start: 2_000, mediaStart: 2_000, duration: 2_000 }),
      video({ id: 'v3', start: 4_000, mediaStart: 6_000, duration: 2_000 }),
    ]
    const sentences = [said(1_500, 2_500, '跨过接缝的一句')]
    expect(recognizedCaptions(clips, new Map(clips.map((clip) => [clip.id, sentences])))).toEqual({
      captions: [{ start: 1_500, duration: 1_000, text: '跨过接缝的一句', owner: 'v1' }],
      skipped: 0,
      silent: ['v3'],
      elsewhere: ['v2'],
    })
  })

  it('句子开头哪个片段都没播出（被裁掉了）：由时间线上第一个播出这句一部分的片段写，从片段开头起，结尾照句子', () => {
    // 素材 0.5–1.5 秒和 2.5–3.8 秒排在一起（中间那段删了），2.5–3.8 秒在 5 秒处又用了一次
    const clips = [
      video({ id: 'v1', start: 0, mediaStart: 500, duration: 1_000 }),
      video({ id: 'v3', start: 1_000, mediaStart: 2_500, duration: 1_300 }),
      video({ id: 'v4', start: 5_000, mediaStart: 2_500, duration: 1_300 }),
    ]
    const sentences = [said(2_000, 3_000, '开头被裁掉的一句')]
    expect(
      recognizedCaptions(clips, new Map(clips.map((clip) => [clip.id, sentences]))).captions,
    ).toEqual([{ start: 1_000, duration: 500, text: '开头被裁掉的一句', owner: 'v3' }])
  })
})

describe('识别出来的字幕避开已有的字幕', () => {
  const wanted = (start: number, duration: number, text = '新') => ({
    start,
    duration,
    text,
    owner: 'v1',
  })

  it('和已有的重叠时截短到自己那段时间里空着的最长一截；放不下的不要，数一下', () => {
    const existing = [{ start: 1_000, duration: 1_000 }]
    expect(
      placeCaptions(existing, [
        wanted(500, 1_000, '压到开头'),
        wanted(1_500, 1_000, '压到结尾'),
        wanted(1_200, 600, '整句压住'),
        wanted(800, 2_200, '两头都空'),
      ]),
    ).toEqual({
      placed: [
        wanted(500, 500, '压到开头'),
        // 按开始时间放：前面空着的一截被「压到开头」占了，取后面的 2–3 秒
        wanted(2_000, 1_000, '两头都空'),
      ],
      // 「整句压住」整句都被盖着；「压到结尾」后面那一截已经给了「两头都空」
      skipped: 2,
    })
  })

  it('新加的句子之间也不重叠：后放的截短', () => {
    expect(placeCaptions([], [wanted(0, 1_000, '一'), wanted(500, 1_000, '二')])).toEqual({
      placed: [wanted(0, 1_000, '一'), wanted(1_000, 500, '二')],
      skipped: 0,
    })
  })

  it('换算加避让：每个片段各取各的，一句都没有的片段单独列出来', () => {
    const clips = [
      video({ id: 'v1', start: 0, duration: 2_000 }),
      video({ id: 'v2', start: 2_000, duration: 2_000 }),
      captionClip({ id: 'cap-m', start: 2_000, duration: 500 }),
    ]
    expect(
      recognizedCaptions(
        clips,
        new Map([
          ['v1', [said(0, 1_000)]],
          ['v2', [said(3_000, 4_000)]],
        ]),
      ),
    ).toEqual({
      captions: [{ start: 0, duration: 1_000, text: '一句话', owner: 'v1' }],
      skipped: 0,
      silent: ['v2'],
      elsewhere: [],
    })
  })
})

describe('要识别字幕的视频片段', () => {
  const takes = new Map([
    ['a.mp4', 'job-a'],
    ['b.mp4', 'job-b'],
  ])
  const jobOf = (src: string) => takes.get(src)

  it('有声音、没有自己的字幕、素材对得上的才识别；同一条素材的两个片段各是一个', () => {
    const clips = [
      video({ id: 'v1', src: 'a.mp4' }),
      video({ id: 'v2', src: 'a.mp4', start: 2_000 }),
      video({ id: 'captioned', src: 'b.mp4', start: 4_000 }),
      video({ id: 'muted', src: 'b.mp4', start: 6_000, muted: true }),
      video({ id: 'unknown', src: 'other.mp4', start: 8_000 }),
      // 关了原声但原声分离出来了：照样识别
      video({ id: 'detached', src: 'b.mp4', start: 10_000, muted: true, syncOrigin: 'o1' }),
      audio({ id: 'voice', src: 'b.mp4', start: 10_000, syncOrigin: 'o1' }),
      captionClip({ id: 'cap-1', start: 4_000, owner: 'captioned' }),
      // 手动加的字幕不算哪个片段的
      captionClip({ id: 'cap-2', start: 0, owner: null }),
    ]
    expect(recognitionTargets(clips, jobOf)).toEqual({
      targets: [
        { clipId: 'v1', sourceJobId: 'job-a' },
        { clipId: 'v2', sourceJobId: 'job-a' },
        { clipId: 'detached', sourceJobId: 'job-b' },
      ],
    })
  })

  it('一个都没有时说明原因', () => {
    expect(recognitionTargets([audio()], jobOf)).toEqual({ refusal: 'empty' })
    expect(
      recognitionTargets([video({ id: 'v1', src: 'a.mp4' }), captionClip({ owner: 'v1' })], jobOf),
    ).toEqual({ refusal: 'captioned' })
    expect(
      recognitionTargets(
        [video({ id: 'v1', src: 'a.mp4', muted: true }), video({ id: 'v2', src: 'x.mp4' })],
        jobOf,
      ),
    ).toEqual({ refusal: 'unusable' })
  })
})

describe('字幕跟着它的视频片段走', () => {
  const before: FilmClip[] = [
    video({ id: 'v1', start: 0, duration: 3_000 }),
    video({ id: 'v2', start: 3_000, duration: 3_000, track: 0 }),
    captionClip({ id: 'own-1', start: 500, duration: 1_000, owner: 'v1' }),
    captionClip({ id: 'own-2', start: 1_500, duration: 1_000, owner: 'v1' }),
    captionClip({ id: 'other', start: 3_500, duration: 1_000, owner: 'v2' }),
    captionClip({ id: 'manual', start: 8_000, duration: 1_000, owner: null }),
  ]
  /** 一步编辑之后：视频片段按 `changes` 改。 */
  const after = (changes: Record<string, Partial<VideoClip>>): FilmClip[] =>
    before.map((clip) => (clip.kind === 'video' ? { ...clip, ...changes[clip.id] } : clip))

  it('视频片段挪了：它的字幕挪同样的时间差，别的片段的字幕、手动加的不动', () => {
    expect(captionsFollowing(before, after({ v1: { start: 10_000 } }))).toEqual({
      starts: new Map([
        ['own-1', 10_500],
        ['own-2', 11_500],
      ]),
      removed: [],
    })
  })

  it('往前挪到 0 秒之前的字幕收在 0', () => {
    // 这一句被拖到了片段开始之前
    const own = captionClip({ id: 'own', start: 800, duration: 500, owner: 'v1' })
    expect(
      captionsFollowing(
        [video({ id: 'v1', start: 1_000, duration: 2_000 }), own],
        [video({ id: 'v1', start: 0, duration: 2_000 }), own],
      ),
    ).toEqual({ starts: new Map([['own', 0]]), removed: [] })
  })

  it('裁剪开头（入点跟着变）、改速度：字幕不动', () => {
    expect(
      captionsFollowing(before, after({ v1: { start: 500, mediaStart: 500, duration: 2_500 } })),
    ).toEqual({ starts: new Map(), removed: [] })
    expect(captionsFollowing(before, after({ v1: { playbackRate: 2 } }))).toEqual({
      starts: new Map(),
      removed: [],
    })
  })

  it('和它一起挪了的字幕按它自己的', () => {
    const moved = after({ v1: { start: 1_000 } }).map((clip) =>
      clip.id === 'own-1' ? { ...clip, start: 1_400 } : clip,
    )
    expect(captionsFollowing(before, moved)).toEqual({
      starts: new Map([['own-2', 2_500]]),
      removed: [],
    })
  })

  it('视频片段删了：它的字幕一起删', () => {
    expect(
      captionsFollowing(
        before,
        before.filter((clip) => clip.id !== 'v1'),
      ),
    ).toEqual({
      starts: new Map(),
      removed: ['own-1', 'own-2'],
    })
  })

  it('挪过去会和别的字幕重叠：整步不做', () => {
    expect(captionsFollowing(before, after({ v1: { start: 7_000 } }))).toEqual({
      refusal: 'overlap',
    })
  })

  it('切开以后：从切点起的字幕归后半段，跨着切点的留在前半段', () => {
    const clip = video({ id: 'v1', start: 0, duration: 4_000 })
    const clips = [
      clip,
      captionClip({ id: 'early', start: 500, duration: 500, owner: 'v1' }),
      captionClip({ id: 'across', start: 1_800, duration: 700, owner: 'v1' }),
      captionClip({ id: 'late', start: 2_500, duration: 500, owner: 'v1' }),
      captionClip({ id: 'manual', start: 3_000, duration: 500, owner: null }),
    ]
    const plan = splitAt(clip, 2_000, clips, new Map())
    if (!('cuts' in plan)) throw new Error('应该能切开')
    expect(splitOwners(clips, plan.cuts, new Map([['v1', 'v1-half']]))).toEqual(
      new Map([['late', 'v1-half']]),
    )
  })
})

describe('配音片段跟着它配的那句字幕走', () => {
  const dub = (id: string, locale: string, of: string, start: number) =>
    audio({
      id,
      start,
      duration: 1_000,
      dub: { locale, caption: of, trimmed: false, text: null, voice: null, speed: 1 },
    })
  const before: FilmClip[] = [
    captionClip({ id: 'a1', start: 500, duration: 1_000, owner: 'v1' }),
    captionClip({ id: 'b2', start: 2_000, duration: 1_000, owner: 'v1' }),
    dub('en-a1', 'en', 'a1', 500),
    dub('de-a1', 'de', 'a1', 500),
    dub('en-b2', 'en', 'b2', 2_000),
    // 配的那句本来就不在：不跟着谁
    dub('en-gone', 'en', 'missing', 5_000),
  ]
  const after = (changes: Record<string, Partial<FilmClip>>, dropped: string[] = []) =>
    before
      .filter((clip) => !dropped.includes(clip.id))
      .map((clip) => ({ ...clip, ...changes[clip.id] }) as FilmClip)

  it('字幕挪了：各语言的配音挪同样的时间差，早于 0 的收在 0；自己也挪了的按自己的', () => {
    expect(dubsFollowing(before, after({ a1: { start: 0 }, b2: { start: 3_000 } }))).toEqual({
      starts: new Map([
        ['en-a1', 0],
        ['de-a1', 0],
        ['en-b2', 3_000],
      ]),
      removed: [],
    })
    expect(
      dubsFollowing(before, after({ a1: { start: 1_500 }, 'en-a1': { start: 200 } })).starts,
    ).toEqual(new Map([['de-a1', 1_500]]))
  })

  it('挪了一个配音片段：它配的那句字幕挪同样的时间差，这句其它语言的配音再跟着字幕挪', () => {
    const moved = after({ 'en-a1': { start: 800 } })
    const plan = captionsFollowing(before, moved)
    expect(plan).toEqual({ starts: new Map([['a1', 800]]), removed: [] })
    if ('refusal' in plan) throw new Error('应该能挪')
    const captioned = moved.map((clip) => ({
      ...clip,
      start: plan.starts.get(clip.id) ?? clip.start,
    }))
    expect(dubsFollowing(before, captioned)).toEqual({
      starts: new Map([['de-a1', 800]]),
      removed: [],
    })
  })

  it('裁配音片段的开头（入点跟着变）、裁结尾：字幕不动', () => {
    expect(
      captionsFollowing(before, after({ 'en-a1': { start: 800, mediaStart: 300, duration: 700 } })),
    ).toEqual({ starts: new Map(), removed: [] })
    expect(captionsFollowing(before, after({ 'en-a1': { duration: 400 } }))).toEqual({
      starts: new Map(),
      removed: [],
    })
  })

  it('配音片段挪过去，它的字幕会和别的字幕重叠：整步不做', () => {
    expect(captionsFollowing(before, after({ 'en-a1': { start: 1_800 } }))).toEqual({
      refusal: 'overlap',
    })
  })

  it('配音片段挪过去，它的字幕会到 0 秒以前：整步不做', () => {
    // 配音片段裁过开头，比字幕晚 0.3 秒开始：挪到 0.2 秒时字幕要到 -0.1 秒
    const late = before.map((clip) => (clip.id === 'en-a1' ? { ...clip, start: 800 } : clip))
    const moved = late.map((clip) => (clip.id === 'en-a1' ? { ...clip, start: 200 } : clip))
    expect(captionsFollowing(late, moved)).toEqual({ refusal: 'early' })
  })

  it('字幕删了：它的各语言配音一起删；裁剪字幕（开始不变）配音不动', () => {
    expect(dubsFollowing(before, after({ b2: { duration: 300 } }, ['a1']))).toEqual({
      starts: new Map(),
      removed: ['en-a1', 'de-a1'],
    })
  })
})

describe('选中的片段在「字幕」里对应什么', () => {
  const dubOf = (id: string, of: string, locale: string | null) =>
    audio({ id, dub: { locale, caption: of, trimmed: false, text: null, voice: null, speed: 1 } })
  const texted = new Set(['title-1'])

  it('选中字幕：标出这一句，切到「字幕」', () => {
    const focus = captionsFocus([captionClip({ id: 'a1' })], texted)
    expect([...focus.lines]).toEqual(['a1'])
    expect(focus.view).toBe('captions')
  })

  it('选中其它语言的配音片段、旁白片段：标出它们配的那句，切到「字幕」', () => {
    const focus = captionsFocus([dubOf('en-a1', 'a1', 'en'), dubOf('n-b2', 'b2', null)], texted)
    expect([...focus.lines]).toEqual(['a1', 'b2'])
    expect(focus.view).toBe('captions')
  })

  it('选中有文字的元素、模板片段：不标字幕，切到「画面文字」；同时选中了字幕时还是「字幕」', () => {
    expect(captionsFocus([host({ id: 'title-1' })], texted)).toEqual({
      lines: new Set(),
      view: 'texts',
    })
    expect(captionsFocus([host({ id: 'title-1' }), captionClip({ id: 'a1' })], texted).view).toBe(
      'captions',
    )
  })

  it('选中没有文字的元素片段、视频片段、配乐或什么都没选：不切', () => {
    expect(captionsFocus([host({ id: 'plain' })], texted).view).toBeUndefined()
    expect(captionsFocus([video(), audio()], texted).view).toBeUndefined()
    expect(captionsFocus([], texted)).toEqual({ lines: new Set(), view: undefined })
  })
})

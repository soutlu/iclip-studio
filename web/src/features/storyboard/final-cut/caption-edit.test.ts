import { describe, expect, it } from 'vitest'
import { audio, caption as captionClip, video } from '@/testing/final-cut'
import {
  captionClock,
  captionsFollowing,
  captionSpot,
  captionsInOrder,
  placeCaptions,
  recognitionTargets,
  recognizedCaptions,
  sentenceCaptions,
  splitOwners,
} from './caption-edit'
import { splitAt } from './clip-edit'
import type { FilmClip, VideoClip } from './composition/film'

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
  it('只取片段用掉的那段素材里的句子，从入点算起，头尾超出片段的截掉，截完不到 0.1 秒、字是空的不要', () => {
    // 片段从 final-cut 的 1 秒起、长 3 秒，用掉素材的 2–5 秒
    const clip = video({ id: 'v1', start: 1_000, mediaStart: 2_000, duration: 3_000 })
    expect(
      sentenceCaptions(clip, [
        said(1_000, 1_500, '入点之前'),
        said(1_800, 2_600, '跨着入点'),
        said(3_000, 4_000, ' 中间 '),
        said(4_900, 6_000, '截完正好 0.1 秒'),
        said(4_950, 6_000, '截完不到 0.1 秒'),
        said(3_000, 3_500, '  '),
      ]),
    ).toEqual([
      { start: 1_000, duration: 600, text: '跨着入点', owner: 'v1' },
      { start: 2_000, duration: 1_000, text: '中间', owner: 'v1' },
      { start: 3_900, duration: 100, text: '截完正好 0.1 秒', owner: 'v1' },
    ])
  })

  it('速度不是 1：素材里的时间除以速度', () => {
    // 2 倍速：final-cut 里 2 秒用掉素材的 1–5 秒
    const clip = video({ id: 'v1', start: 0, mediaStart: 1_000, duration: 2_000, playbackRate: 2 })
    expect(sentenceCaptions(clip, [said(2_000, 3_000), said(4_000, 6_000)])).toEqual([
      { start: 500, duration: 500, text: '一句话', owner: 'v1' },
      { start: 1_500, duration: 500, text: '一句话', owner: 'v1' },
    ])
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

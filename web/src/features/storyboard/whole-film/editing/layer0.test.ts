import { describe, expect, it } from 'vitest'
import {
  card,
  contextOf,
  draftOf,
  expectOk,
  overlay,
  source,
  spans,
  video,
} from '@/testing/whole-film'
import { MAX_VOLUME, type WholeFilmDraft } from './draft'
import {
  deleteClip,
  insertComponent,
  insertMaterial,
  moveClip,
  setClipVolume,
  splitClip,
  trimClip,
  type InsertAt,
} from './layer0'
import { filmDuration } from './timeline'

const context = contextOf({
  s1: source(10_000),
  s2: source(5_000),
  big: source(200_000),
  wide: { ...source(5_000), width: 1920, height: 1080 },
})

/** 组件段 2 秒、两段视频、组件段 1.5 秒：c1 0–2000、v1 2000–5000、v2 5000–7000、c2 7000–8500 */
const withCards = () =>
  draftOf([
    card('c1', 2_000),
    video('v1', 's1', 1_000, 3_000),
    video('v2', 's2', 0, 2_000),
    card('c2', 1_500),
  ])

const manyVideos = (count: number) =>
  draftOf(Array.from({ length: count }, (_, i) => video(`v${i + 1}`, 's1', 0, 500)))

const material = (at: InsertAt, duration = 1_000) => ({
  sourceJobId: 's1',
  playbackStart: 5_000,
  duration,
  at,
})

const ids = (draft: WholeFilmDraft) => draft.layer0.map((c) => c.id)

describe('insertMaterial', () => {
  it('按段序号插入，后面整体后移；组件段与视频段一样算一段', () => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ index: 2 }), context))
    expect(spans(draft)).toEqual([
      ['c1', 0, 2_000],
      ['v1', 2_000, 5_000],
      ['v3', 5_000, 6_000],
      ['v2', 6_000, 8_000],
      ['c2', 8_000, 9_500],
    ])
    expect(draft.layer0[2]).toMatchObject({ playbackStart: 5_000, sourceJobId: 's1', volume: 1 })
  })

  it.each([
    [0, ['v3', 'c1', 'v1', 'v2', 'c2']],
    [4, ['c1', 'v1', 'v2', 'c2', 'v3']],
    [99, ['c1', 'v1', 'v2', 'c2', 'v3']],
    [-3, ['v3', 'c1', 'v1', 'v2', 'c2']],
  ])('序号 %i：任意位置都能插，超出范围收到两端', (index, expected) => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ index }), context))
    expect(ids(draft)).toEqual(expected)
  })

  it.each([
    ['在一段前半：插在这段前面，不拆段', 3_000, ['c1', 'v3', 'v1', 'v2', 'c2']],
    ['在一段后半：插在这段后面，不拆段', 4_000, ['c1', 'v1', 'v3', 'v2', 'c2']],
    ['在开头的组件段前半：插到最前', 500, ['v3', 'c1', 'v1', 'v2', 'c2']],
    ['在末尾的组件段后半：插到最后', 8_000, ['c1', 'v1', 'v2', 'c2', 'v3']],
    ['在整片之后：插到最后', 20_000, ['c1', 'v1', 'v2', 'c2', 'v3']],
  ])('落点%s', (_, timeMs, expected) => {
    const before = withCards()
    const { draft } = expectOk(insertMaterial(before, material({ timeMs }), context))
    expect(ids(draft)).toEqual(expected)
    expect(draft.layer0.find((c) => c.id === 'v1')).toMatchObject({
      duration: 3_000,
      playbackStart: 1_000,
    })
  })

  it('第一段视频定下画布尺寸，之后加别的尺寸不改；只有组件段时没有画布', () => {
    const cardsOnly = draftOf([card('c1', 1_000)])
    expect(cardsOnly.canvas).toBeNull()
    const first = expectOk(
      insertMaterial(
        cardsOnly,
        { sourceJobId: 'wide', playbackStart: 0, duration: 1_000, at: { index: 1 } },
        context,
      ),
    ).draft
    expect(first.canvas).toEqual({ width: 1920, height: 1080 })
    const second = expectOk(insertMaterial(first, material({ index: 0 }), context)).draft
    expect(second.canvas).toEqual({ width: 1920, height: 1080 })
  })

  it('整片正好 120 秒可以加，多 1 毫秒不行，也不缩短', () => {
    const base = withCards()
    const room = 120_000 - filmDuration(base)
    const range = (duration: number) => ({
      sourceJobId: 'big',
      playbackStart: 0,
      duration,
      at: { index: 0 },
    })
    expect(insertMaterial(base, range(room), context).ok).toBe(true)
    expect(insertMaterial(base, range(room + 1), context)).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
  })

  it('不限段数：已有 150 段照样能加', () => {
    const { draft } = expectOk(insertMaterial(manyVideos(150), material({ index: 0 }), context))
    expect(draft.layer0).toHaveLength(151)
  })

  it.each([
    [
      '素材不在上下文里',
      { sourceJobId: 'nope', playbackStart: 0, duration: 1_000 },
      'unknown-source',
    ],
    ['短于 0.1 秒', { sourceJobId: 's1', playbackStart: 0, duration: 99 }, 'too-short'],
    ['超出素材结尾', { sourceJobId: 's1', playbackStart: 9_500, duration: 501 }, 'outside-source'],
    ['入点为负', { sourceJobId: 's1', playbackStart: -1, duration: 500 }, 'outside-source'],
  ] as const)('拒绝：%s', (_, range, refusal) => {
    expect(insertMaterial(withCards(), { ...range, at: { index: 0 } }, context)).toEqual({
      ok: false,
      refusal,
    })
  })
})

describe('insertComponent', () => {
  const component = (at: InsertAt, duration = 1_000) => ({
    component: 'logo-outro',
    duration,
    variables: { title: '拾步' },
    at,
  })

  it('组件段插在两段视频之间，与视频段同等占时间，后面的段让开', () => {
    const film = draftOf([video('v1', 's1', 0, 3_000), video('v2', 's2', 0, 2_000)])
    const { draft } = expectOk(insertComponent(film, component({ index: 1 }, 1_500)))
    expect(spans(draft)).toEqual([
      ['v1', 0, 3_000],
      ['c1', 3_000, 4_500],
      ['v2', 4_500, 6_500],
    ])
    expect(draft.layer0[1]).toEqual({
      id: 'c1',
      type: 'component',
      start: 3_000,
      duration: 1_500,
      playbackStart: 0,
      component: 'logo-outro',
      variables: { title: '拾步' },
    })
  })

  it('落在一段中间：插到最近的切点，不拆段', () => {
    const film = draftOf([video('v1', 's1', 0, 3_000), video('v2', 's2', 0, 2_000)])
    expect(ids(expectOk(insertComponent(film, component({ timeMs: 1_000 }))).draft)).toEqual([
      'c1',
      'v1',
      'v2',
    ])
    expect(ids(expectOk(insertComponent(film, component({ timeMs: 2_000 }))).draft)).toEqual([
      'v1',
      'c1',
      'v2',
    ])
  })

  it('组件段也能放进空的成片轨，画布仍未定', () => {
    const { draft } = expectOk(insertComponent(draftOf([]), component({ timeMs: 0 })))
    expect(spans(draft)).toEqual([['c1', 0, 1_000]])
    expect(draft.canvas).toBeNull()
  })

  it('超过 120 秒不让放，不缩短', () => {
    const film = draftOf([video('v1', 'big', 0, 115_000)])
    expect(insertComponent(film, component({ index: 1 }, 5_000)).ok).toBe(true)
    expect(insertComponent(film, component({ index: 1 }, 5_001))).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
  })
})

describe('moveClip', () => {
  const three = () =>
    draftOf([video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 1_000), video('v3', 's1', 0, 1_000)])

  it('挪到第 to 段之前（按挪动前的序号），整轨重新首尾相接', () => {
    const { draft } = expectOk(moveClip(three(), { clipId: 'v1', to: 2 }))
    expect(spans(draft)).toEqual([
      ['v2', 0, 1_000],
      ['v1', 1_000, 2_000],
      ['v3', 2_000, 3_000],
    ])
    expect(ids(expectOk(moveClip(three(), { clipId: 'v3', to: 1 })).draft)).toEqual([
      'v1',
      'v3',
      'v2',
    ])
  })

  it('落点就在它自己两侧：原样返回，不算改动', () => {
    const before = three()
    expect(expectOk(moveClip(before, { clipId: 'v2', to: 1 })).draft).toBe(before)
    expect(expectOk(moveClip(before, { clipId: 'v2', to: 2 })).draft).toBe(before)
  })

  it('落点超出两端时挪到最前或最后', () => {
    expect(ids(expectOk(moveClip(three(), { clipId: 'v3', to: -5 })).draft)).toEqual([
      'v3',
      'v1',
      'v2',
    ])
    expect(ids(expectOk(moveClip(three(), { clipId: 'v1', to: 99 })).draft)).toEqual([
      'v2',
      'v3',
      'v1',
    ])
  })

  it('组件段与视频段一样能换到任意位置', () => {
    expect(ids(expectOk(moveClip(withCards(), { clipId: 'c1', to: 2 })).draft)).toEqual([
      'v1',
      'c1',
      'v2',
      'c2',
    ])
    expect(ids(expectOk(moveClip(withCards(), { clipId: 'v2', to: 0 })).draft)).toEqual([
      'v2',
      'c1',
      'v1',
      'c2',
    ])
    expect(moveClip(withCards(), { clipId: 'x', to: 0 })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })
})

describe('trimClip', () => {
  /** v1 0–3000（s1 入点 1000）、v2 3000–5000，1 秒处有特效块 */
  const base = (): WholeFilmDraft =>
    draftOf([video('v1', 's1', 1_000, 3_000), video('v2', 's2', 0, 2_000)], {
      overlays: [overlay('o1', 1_000, 500)],
    })

  const trim = (draft: WholeFilmDraft, clipId: string, edge: 'start' | 'end', deltaMs: number) =>
    trimClip(draft, { clipId, edge, deltaMs }, context)

  it('修结尾：整轨收紧，后面整体前移；特效块不跟随', () => {
    const { draft } = expectOk(trim(base(), 'v1', 'end', -1_000))
    expect(spans(draft)).toEqual([
      ['v1', 0, 2_000],
      ['v2', 2_000, 4_000],
    ])
    expect(draft.overlays[0]).toMatchObject({ start: 1_000, duration: 500 })
  })

  it('修开头：切点不动，这段从更晚的画面开始，后面整体前移', () => {
    const { draft } = expectOk(trim(base(), 'v1', 'start', 500))
    expect(draft.layer0[0]).toMatchObject({ start: 0, duration: 2_500, playbackStart: 1_500 })
    expect(draft.layer0[1]).toMatchObject({ start: 2_500 })
  })

  it.each([
    ['结尾修到最短 0.1 秒', 'end', -50_000, { duration: 100, playbackStart: 1_000 }],
    ['开头修到最短 0.1 秒', 'start', 50_000, { duration: 100, playbackStart: 3_900 }],
    ['结尾往后拉到素材末尾为止', 'end', 50_000, { duration: 9_000, playbackStart: 1_000 }],
    ['开头往前拉到素材开头为止', 'start', -50_000, { duration: 4_000, playbackStart: 0 }],
  ] as const)('%s', (_, edge, deltaMs, expected) => {
    const { draft } = expectOk(trim(base(), 'v1', edge, deltaMs))
    expect(draft.layer0[0]).toMatchObject({ start: 0, ...expected })
  })

  it('整片已满 120 秒：再往长拉不动，原样返回', () => {
    const full = draftOf([video('v1', 'big', 0, 119_000), video('v2', 'big', 0, 1_000)])
    expect(expectOk(trim(full, 'v1', 'end', 5_000)).draft).toBe(full)
    const near = draftOf([video('v1', 'big', 1_000, 118_000), video('v2', 'big', 0, 1_000)])
    const { draft } = expectOk(trim(near, 'v1', 'start', -5_000))
    expect(draft.layer0[0]).toMatchObject({ duration: 119_000, playbackStart: 0 })
    expect(filmDuration(draft)).toBe(120_000)
  })

  it('组件段两端都能拖：修开头时从组件自己时间里更晚处起播', () => {
    const { draft } = expectOk(trim(withCards(), 'c1', 'start', 500))
    expect(draft.layer0[0]).toMatchObject({ start: 0, duration: 1_500, playbackStart: 500 })
    expect(draft.layer0[1]).toMatchObject({ id: 'v1', start: 1_500 })
    const longer = expectOk(trim(withCards(), 'c2', 'end', 500)).draft
    expect(spans(longer).at(-1)).toEqual(['c2', 7_000, 9_000])
  })

  it('组件段往前拉开头：入点退回去，退到 0 就停住', () => {
    const film = draftOf([card('c1', 2_000, { playbackStart: 800 }), video('v1', 's1', 0, 1_000)])
    const back = expectOk(trim(film, 'c1', 'start', -500)).draft
    expect(back.layer0[0]).toMatchObject({ duration: 2_500, playbackStart: 300 })
    const stopped = expectOk(trim(film, 'c1', 'start', -5_000)).draft
    expect(stopped.layer0[0]).toMatchObject({ duration: 2_800, playbackStart: 0 })
    const fresh = withCards()
    expect(expectOk(trim(fresh, 'c1', 'start', -500)).draft).toBe(fresh)
  })

  it('组件段拉长只受总长上限约束', () => {
    const { draft } = expectOk(trim(withCards(), 'c1', 'end', 500_000))
    expect(filmDuration(draft)).toBe(120_000)
  })

  it('上下文缺少草稿里的成片：是调用方的错，直接报错', () => {
    expect(() =>
      trimClip(base(), { clipId: 'v1', edge: 'end', deltaMs: 1 }, contextOf({})),
    ).toThrow('整片编辑上下文缺少成片 s1')
  })
})

describe('splitClip', () => {
  const base = () => draftOf([video('v1', 's1', 1_000, 3_000), video('v2', 's2', 0, 2_000)])

  it('拆成首尾相接的两段，总长不变；后半段接着原入点', () => {
    const { draft } = expectOk(splitClip(base(), { timeMs: 1_200 }))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_200],
      ['v3', 1_200, 3_000],
      ['v2', 3_000, 5_000],
    ])
    expect(draft.layer0[1]).toMatchObject({ playbackStart: 2_200, sourceJobId: 's1' })
  })

  it('组件段也能拆：后半段从组件自己时间里接着往后播', () => {
    const film = draftOf([video('v1', 's1', 0, 1_000), card('c1', 3_000, { playbackStart: 400 })])
    const { draft } = expectOk(splitClip(film, { timeMs: 2_000 }))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_000],
      ['c1', 1_000, 2_000],
      ['c2', 2_000, 4_000],
    ])
    expect(draft.layer0[1]).toMatchObject({ type: 'component', playbackStart: 400 })
    expect(draft.layer0[2]).toMatchObject({
      type: 'component',
      component: 'card',
      playbackStart: 1_400,
    })
  })

  it.each([
    [100, true],
    [2_900, true],
    [99, false],
    [2_901, false],
  ])('拆开后两段都要不短于 0.1 秒：在 %i 毫秒拆 → %s', (timeMs, ok) => {
    expect(splitClip(base(), { timeMs }).ok).toBe(ok)
  })

  it('优先拆指定的段，它拆不了就拆播放头下的段', () => {
    const { draft } = expectOk(splitClip(base(), { timeMs: 4_000, clipId: 'v1' }))
    expect(ids(draft)).toEqual(['v1', 'v2', 'v3'])
    expect(splitClip(base(), { timeMs: 3_000 })).toEqual({
      ok: false,
      refusal: 'nothing-to-split',
    })
  })

  it('不限段数：已有 150 段照样能拆', () => {
    expect(splitClip(manyVideos(150), { timeMs: 250 }).ok).toBe(true)
  })
})

describe('deleteClip', () => {
  const base = () =>
    draftOf(
      [video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 2_000), video('v3', 's1', 0, 3_000)],
      {
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: 'sub', sentenceIndex: 0, text: '改' }],
        },
      },
    )

  it('删段后整轨收紧', () => {
    const { draft } = expectOk(deleteClip(base(), { clipId: 'v2' }))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_000],
      ['v3', 1_000, 4_000],
    ])
  })

  it('改过的字幕留着（字幕跟着素材走，段加回来时还生效）', () => {
    const { draft } = expectOk(deleteClip(base(), { clipId: 'v1' }))
    expect(draft.captions.edits).toHaveLength(1)
  })

  it('删掉组件段；没有视频段时画布清空', () => {
    const { draft } = expectOk(deleteClip(withCards(), { clipId: 'c1' }))
    expect(spans(draft)[0]).toEqual(['v1', 0, 3_000])
    const noFirst = expectOk(deleteClip(withCards(), { clipId: 'v1' })).draft
    const onlyCards = expectOk(deleteClip(noFirst, { clipId: 'v2' })).draft
    expect(onlyCards.canvas).toBeNull()
    expect(deleteClip(withCards(), { clipId: 'x' })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })

  it('整片变短：特效块原样留着，不截、不删', () => {
    const overlays = [overlay('o1', 2_000, 1_000), overlay('o2', 3_500, 300)]
    const film = draftOf([video('v1', 's1', 0, 2_500), video('v2', 's1', 0, 1_500)], { overlays })
    expect(expectOk(deleteClip(film, { clipId: 'v2' })).draft.overlays).toEqual(overlays)
  })
})

describe('setClipVolume', () => {
  it.each([
    [5, MAX_VOLUME],
    [-1, 0],
    [2.5, 2.5],
  ])('音量 %f 收进 0 到 +12 dB → %f', (volume, expected) => {
    const { draft } = expectOk(setClipVolume(withCards(), { clipId: 'v1', volume }))
    expect(draft.layer0[1]).toMatchObject({ volume: expected })
  })

  it('音量没变原样返回；组件段没有原声', () => {
    const before = withCards()
    expect(expectOk(setClipVolume(before, { clipId: 'v1', volume: 1 })).draft).toBe(before)
    expect(setClipVolume(before, { clipId: 'c1', volume: 1 })).toEqual({
      ok: false,
      refusal: 'not-a-video',
    })
  })
})

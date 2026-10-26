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
  deleteClips,
  insertComponent,
  insertMaterial,
  moveClips,
  setClipsVolume,
  splitClip,
  trimClip,
  type InsertAt,
} from './layer0'
import { filmDuration } from './timeline'

const context = contextOf(
  {
    s1: source(10_000),
    s2: source(5_000),
    big: source(200_000),
    wide: { ...source(5_000), width: 1920, height: 1080 },
  },
  {},
  // long 比 120 秒还长，只受总长上限约束
  { card: 3_000, long: 200_000 },
)

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
  pieces: [{ playbackStart: 5_000, duration }],
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
    ['在成片之后：插到最后', 20_000, ['c1', 'v1', 'v2', 'c2', 'v3']],
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
        { sourceJobId: 'wide', pieces: [{ playbackStart: 0, duration: 1_000 }], at: { index: 1 } },
        context,
      ),
    ).draft
    expect(first.canvas).toEqual({ width: 1920, height: 1080 })
    const second = expectOk(insertMaterial(first, material({ index: 0 }), context)).draft
    expect(second.canvas).toEqual({ width: 1920, height: 1080 })
  })

  it('成片正好 120 秒可以加，多 1 毫秒不行，也不缩短', () => {
    const base = withCards()
    const room = 120_000 - filmDuration(base)
    const range = (duration: number) => ({
      sourceJobId: 'big',
      pieces: [{ playbackStart: 0, duration }],
      at: { index: 0 },
    })
    expect(insertMaterial(base, range(room), context).ok).toBe(true)
    expect(insertMaterial(base, range(room + 1), context)).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
    // 几段一起加时按几段的总长算
    const pieces = (last: number) => ({
      sourceJobId: 'big',
      pieces: [
        { playbackStart: 0, duration: 1_000 },
        { playbackStart: 1_000, duration: last },
      ],
      at: { index: 0 },
    })
    expect(insertMaterial(base, pieces(room - 1_000), context).ok).toBe(true)
    expect(insertMaterial(base, pieces(room - 999), context)).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
  })

  it('几段按先后连着插在落点处，各成一段、id 依次往后数', () => {
    const { draft } = expectOk(
      insertMaterial(
        withCards(),
        {
          sourceJobId: 's1',
          pieces: [
            { playbackStart: 1_500, duration: 500 },
            { playbackStart: 2_000, duration: 2_500 },
            { playbackStart: 4_500, duration: 700 },
          ],
          at: { index: 1 },
        },
        context,
      ),
    )
    expect(spans(draft)).toEqual([
      ['c1', 0, 2_000],
      ['v3', 2_000, 2_500],
      ['v4', 2_500, 5_000],
      ['v5', 5_000, 5_700],
      ['v1', 5_700, 8_700],
      ['v2', 8_700, 10_700],
      ['c2', 10_700, 12_200],
    ])
    expect(draft.layer0.slice(1, 4).map((clip) => clip.playbackStart)).toEqual([
      1_500, 2_000, 4_500,
    ])
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
  ] as const)('拒绝：%s', (_, { sourceJobId, ...piece }, refusal) => {
    expect(
      insertMaterial(withCards(), { sourceJobId, pieces: [piece], at: { index: 0 } }, context),
    ).toEqual({ ok: false, refusal })
  })

  it('几段里有一段不合格就整个拒绝', () => {
    const pieces = [
      { playbackStart: 0, duration: 1_000 },
      { playbackStart: 1_000, duration: 99 },
    ]
    expect(
      insertMaterial(withCards(), { sourceJobId: 's1', pieces, at: { index: 0 } }, context),
    ).toEqual({ ok: false, refusal: 'too-short' })
  })
})

describe('insertComponent', () => {
  const component = (at: InsertAt, duration = 1_000) => ({
    component: 'fixture-scene',
    duration,
    variables: { title: '示例' },
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
      component: 'fixture-scene',
      variables: { title: '示例' },
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

  it('组件段也能放进空的画面轨，画布仍未定', () => {
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

describe('moveClips', () => {
  const three = () =>
    draftOf([video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 1_000), video('v3', 's1', 0, 1_000)])
  const move = (draft: WholeFilmDraft, clipIds: string[], to: number) =>
    ids(expectOk(moveClips(draft, { clipIds, to })).draft)

  it('挪到第 to 段之前（按挪动前的序号），整轨重新首尾相接', () => {
    const { draft } = expectOk(moveClips(three(), { clipIds: ['v1'], to: 2 }))
    expect(spans(draft)).toEqual([
      ['v2', 0, 1_000],
      ['v1', 1_000, 2_000],
      ['v3', 2_000, 3_000],
    ])
    expect(move(three(), ['v3'], 1)).toEqual(['v1', 'v3', 'v2'])
  })

  it('落点就在它自己两侧：原样返回，不算改动', () => {
    const before = three()
    expect(expectOk(moveClips(before, { clipIds: ['v2'], to: 1 })).draft).toBe(before)
    expect(expectOk(moveClips(before, { clipIds: ['v2'], to: 2 })).draft).toBe(before)
  })

  it('落点超出两端时挪到最前或最后', () => {
    expect(move(three(), ['v3'], -5)).toEqual(['v3', 'v1', 'v2'])
    expect(move(three(), ['v1'], 99)).toEqual(['v2', 'v3', 'v1'])
  })

  it('组件段与视频段一样能换到任意位置', () => {
    expect(move(withCards(), ['c1'], 2)).toEqual(['v1', 'c1', 'v2', 'c2'])
    expect(move(withCards(), ['v2'], 0)).toEqual(['v2', 'c1', 'v1', 'c2'])
  })

  it('连着的几段当成一整块挪，块里先后不变', () => {
    expect(move(withCards(), ['v1', 'v2'], 0)).toEqual(['v1', 'v2', 'c1', 'c2'])
    expect(move(withCards(), ['c1', 'v1'], 4)).toEqual(['v2', 'c2', 'c1', 'v1'])
    // ⌥→ 往后挪一位：落点是块后第二段之前
    const { draft } = expectOk(moveClips(withCards(), { clipIds: ['c1', 'v1'], to: 3 }))
    expect(spans(draft)).toEqual([
      ['v2', 0, 2_000],
      ['c1', 2_000, 4_000],
      ['v1', 4_000, 7_000],
      ['c2', 7_000, 8_500],
    ])
  })

  it('落点在块里或紧挨两侧：原样返回', () => {
    const before = withCards()
    for (const to of [1, 2, 3])
      expect(expectOk(moveClips(before, { clipIds: ['v1', 'v2'], to })).draft).toBe(before)
  })

  it.each([
    ['有不在画面轨上的段', ['v1', 'x'], 'unknown-clip'],
    ['没给段', [], 'unknown-clip'],
    ['几段不相连', ['c1', 'v2'], 'not-contiguous'],
  ] as const)('拒绝：%s', (_, clipIds, refusal) => {
    expect(moveClips(withCards(), { clipIds, to: 0 })).toEqual({ ok: false, refusal })
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

  it('成片已满 120 秒：再往长拉不动，原样返回', () => {
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

  it('组件段结尾最多拉到组件自己的时长放完（card 3 秒），后面的段跟着移；往短里拖照常', () => {
    const longest = expectOk(trim(withCards(), 'c1', 'end', 50_000)).draft
    expect(spans(longest).slice(0, 2)).toEqual([
      ['c1', 0, 3_000],
      ['v1', 3_000, 6_000],
    ])
    const shorter = expectOk(trim(longest, 'c1', 'end', -800)).draft
    expect(shorter.layer0[0]).toMatchObject({ duration: 2_200, playbackStart: 0 })
  })

  it('左端修剪过的组件段：结尾最多到组件时长减去入点，开头往前拉退到入点 0 为止', () => {
    const film = draftOf([card('c1', 1_500, { playbackStart: 800 }), video('v1', 's1', 0, 1_000)])
    const end = expectOk(trim(film, 'c1', 'end', 50_000)).draft
    expect(end.layer0[0]).toMatchObject({ duration: 2_200, playbackStart: 800 })
    const start = expectOk(trim(end, 'c1', 'start', -5_000)).draft
    expect(start.layer0[0]).toMatchObject({ duration: 3_000, playbackStart: 0 })
  })

  it('草稿里已经超出组件时长的组件段：拖结尾时收回上限以内，往长往短拖都不报错', () => {
    const film = draftOf([card('c1', 5_000), video('v1', 's1', 0, 1_000)])
    for (const deltaMs of [300, -300]) {
      const { draft } = expectOk(trim(film, 'c1', 'end', deltaMs))
      expect(spans(draft)).toEqual([
        ['c1', 0, 3_000],
        ['v1', 3_000, 4_000],
      ])
    }
  })

  it('组件段拉长也受总长上限约束', () => {
    const film = draftOf([card('c1', 2_000, { component: 'long' }), video('v1', 's1', 0, 3_000)])
    const { draft } = expectOk(trim(film, 'c1', 'end', 500_000))
    expect(filmDuration(draft)).toBe(120_000)
  })

  it('上下文缺少草稿里的素材片或组件：是调用方的错，直接报错', () => {
    expect(() =>
      trimClip(base(), { clipId: 'v1', edge: 'end', deltaMs: 1 }, contextOf({})),
    ).toThrow('成片编辑上下文缺少素材片 s1')
    expect(() =>
      trimClip(withCards(), { clipId: 'c1', edge: 'end', deltaMs: 1 }, contextOf({})),
    ).toThrow('成片编辑上下文缺少组件 card')
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

describe('deleteClips', () => {
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
    const { draft } = expectOk(deleteClips(base(), { clipIds: ['v2'] }))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_000],
      ['v3', 1_000, 4_000],
    ])
  })

  it('一次删几段，后面的段跟着前移', () => {
    const { draft } = expectOk(deleteClips(withCards(), { clipIds: ['v1', 'v2'] }))
    expect(spans(draft)).toEqual([
      ['c1', 0, 2_000],
      ['c2', 2_000, 3_500],
    ])
  })

  it('改过的字幕留着（字幕跟着素材走，段加回来时还生效）', () => {
    const { draft } = expectOk(deleteClips(base(), { clipIds: ['v1'] }))
    expect(draft.captions.edits).toHaveLength(1)
  })

  it('删掉组件段；没有视频段时画布清空', () => {
    const { draft } = expectOk(deleteClips(withCards(), { clipIds: ['c1'] }))
    expect(spans(draft)[0]).toEqual(['v1', 0, 3_000])
    const onlyCards = expectOk(deleteClips(withCards(), { clipIds: ['v1', 'v2'] })).draft
    expect(onlyCards.canvas).toBeNull()
  })

  it.each([
    ['有不在画面轨上的段', ['v1', 'x']],
    ['没给段', []],
  ])('拒绝：%s', (_, clipIds) => {
    expect(deleteClips(withCards(), { clipIds })).toEqual({ ok: false, refusal: 'unknown-clip' })
  })

  it('成片变短：特效块原样留着，不截、不删', () => {
    const overlays = [overlay('o1', 2_000, 1_000), overlay('o2', 3_500, 300)]
    const film = draftOf([video('v1', 's1', 0, 2_500), video('v2', 's1', 0, 1_500)], { overlays })
    expect(expectOk(deleteClips(film, { clipIds: ['v2'] })).draft.overlays).toEqual(overlays)
  })
})

describe('setClipsVolume', () => {
  it.each([
    [5, MAX_VOLUME],
    [-1, 0],
    [2.5, 2.5],
  ])('音量 %f 收进 0 到 +12 dB → %f', (volume, expected) => {
    const { draft } = expectOk(setClipsVolume(withCards(), { clipIds: ['v1'], volume }))
    expect(draft.layer0[1]).toMatchObject({ volume: expected })
  })

  it('几段视频一起设成同一个值，组件段跳过', () => {
    const film = draftOf([
      { ...video('v1', 's1', 0, 1_000), volume: 0.5 },
      card('c1', 1_000),
      { ...video('v2', 's2', 0, 1_000), volume: 2 },
    ])
    const { draft } = expectOk(setClipsVolume(film, { clipIds: ['v1', 'c1', 'v2'], volume: 1.5 }))
    expect(draft.layer0).toEqual([
      { ...film.layer0[0], volume: 1.5 },
      film.layer0[1],
      { ...film.layer0[2], volume: 1.5 },
    ])
  })

  it('音量都没变原样返回；全是组件段没有原声', () => {
    const before = withCards()
    expect(expectOk(setClipsVolume(before, { clipIds: ['v1', 'v2'], volume: 1 })).draft).toBe(
      before,
    )
    expect(setClipsVolume(before, { clipIds: ['c1'], volume: 1 })).toEqual({
      ok: false,
      refusal: 'not-a-video',
    })
    expect(setClipsVolume(before, { clipIds: ['v1', 'x'], volume: 1 })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })
})

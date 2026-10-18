import { describe, expect, it } from 'vitest'
import { card, contextOf, draftOf, expectOk, source, spans, video } from '@/testing/whole-film'
import type { WholeFilmDraft } from './draft'
import { deleteClip, insertMaterial, moveClip, setClipVolume, splitClip, trimClip } from './layer0'
import { filmDuration } from './timeline'

const context = contextOf({
  s1: source(10_000),
  s2: source(5_000),
  big: source(200_000),
  wide: { ...source(5_000), width: 1920, height: 1080 },
})

/** 片头 2 秒、两段视频、片尾 1.5 秒：c1 0–2000、v1 2000–5000、v2 5000–7000、c2 7000–8500 */
const withCards = () =>
  draftOf([
    card('c1', 'intro', 2_000),
    video('v1', 's1', 1_000, 3_000),
    video('v2', 's2', 0, 2_000),
    card('c2', 'outro', 1_500),
  ])

const transition = (id: string, afterClipId: string, duration = 500) => ({
  id,
  afterClipId,
  component: 'fade',
  duration,
  variables: {},
})

const manyVideos = (count: number) =>
  draftOf(Array.from({ length: count }, (_, i) => video(`v${i + 1}`, 's1', 0, 1_000)))

const material = (at: { videoIndex: number } | { timeMs: number }, duration = 1_000) => ({
  sourceJobId: 's1',
  playbackStart: 5_000,
  duration,
  at,
})

describe('insertMaterial', () => {
  it('按视频段序号插入，插在片尾之前，后面整体后移', () => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ videoIndex: 2 }), context))
    expect(spans(draft)).toEqual([
      ['c1', 0, 2_000],
      ['v1', 2_000, 5_000],
      ['v2', 5_000, 7_000],
      ['v3', 7_000, 8_000],
      ['c2', 8_000, 9_500],
    ])
    expect(draft.layer0[3]).toMatchObject({ playbackStart: 5_000, sourceJobId: 's1', volume: 1 })
  })

  it.each([
    [0, ['c1', 'v3', 'v1', 'v2', 'c2']],
    [99, ['c1', 'v1', 'v2', 'v3', 'c2']],
    [-3, ['c1', 'v3', 'v1', 'v2', 'c2']],
  ])('序号 %i 收进片头之后、片尾之前', (videoIndex, ids) => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ videoIndex }), context))
    expect(draft.layer0.map((c) => c.id)).toEqual(ids)
  })

  it('播放头在一段中间：先拆开这段，再插在两半之间；拆出的后半段接着原入点', () => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ timeMs: 3_000 }), context))
    expect(spans(draft)).toEqual([
      ['c1', 0, 2_000],
      ['v1', 2_000, 3_000],
      ['v4', 3_000, 4_000],
      ['v3', 4_000, 6_000],
      ['v2', 6_000, 8_000],
      ['c2', 8_000, 9_500],
    ])
    expect(draft.layer0[1]).toMatchObject({ playbackStart: 1_000 })
    expect(draft.layer0[3]).toMatchObject({ playbackStart: 2_000, sourceJobId: 's1' })
  })

  it.each([
    ['离段首不到 0.1 秒：插在这段前面', 2_050, ['c1', 'v3', 'v1', 'v2', 'c2']],
    ['离段尾不到 0.1 秒：插在这段后面', 4_950, ['c1', 'v1', 'v3', 'v2', 'c2']],
    ['在片头上：插在片头之后', 500, ['c1', 'v3', 'v1', 'v2', 'c2']],
    ['在片尾上：插在片尾之前', 8_000, ['c1', 'v1', 'v2', 'v3', 'c2']],
    ['在片尾之后：插在片尾之前', 20_000, ['c1', 'v1', 'v2', 'v3', 'c2']],
  ])('播放头%s', (_, timeMs, ids) => {
    const { draft } = expectOk(insertMaterial(withCards(), material({ timeMs }), context))
    expect(draft.layer0.map((c) => c.id)).toEqual(ids)
  })

  it('第一段视频定下画布尺寸，之后加别的尺寸不改', () => {
    const empty = draftOf([])
    expect(empty.canvas).toBeNull()
    const first = expectOk(
      insertMaterial(
        empty,
        { sourceJobId: 'wide', playbackStart: 0, duration: 1_000, at: { videoIndex: 0 } },
        context,
      ),
    ).draft
    expect(first.canvas).toEqual({ width: 1920, height: 1080 })
    const second = expectOk(insertMaterial(first, material({ videoIndex: 0 }), context)).draft
    expect(second.canvas).toEqual({ width: 1920, height: 1080 })
  })

  it('整片正好 120 秒可以加，多 1 毫秒不行', () => {
    const base = withCards()
    const room = 120_000 - filmDuration(base)
    const range = (duration: number) => ({
      sourceJobId: 'big',
      playbackStart: 0,
      duration,
      at: { videoIndex: 0 },
    })
    expect(insertMaterial(base, range(room), context).ok).toBe(true)
    expect(insertMaterial(base, range(room + 1), context)).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
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
    expect(insertMaterial(withCards(), { ...range, at: { videoIndex: 0 } }, context)).toEqual({
      ok: false,
      refusal,
    })
  })

  it('视频段最多 100 段；要先拆开一段时按多出两段算', () => {
    expect(insertMaterial(manyVideos(100), material({ videoIndex: 0 }, 100), context)).toEqual({
      ok: false,
      refusal: 'too-many-clips',
    })
    const almost = manyVideos(99)
    expect(insertMaterial(almost, material({ videoIndex: 0 }, 100), context).ok).toBe(true)
    expect(insertMaterial(almost, material({ timeMs: 500 }, 100), context)).toEqual({
      ok: false,
      refusal: 'too-many-clips',
    })
  })
})

describe('moveClip', () => {
  const three = () =>
    draftOf([video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 1_000), video('v3', 's1', 0, 1_000)])

  it('拖过下一段的中点就换到它后面，整轨重新首尾相接', () => {
    const { draft } = expectOk(moveClip(three(), { clipId: 'v1', deltaMs: 1_200 }, context))
    expect(spans(draft)).toEqual([
      ['v2', 0, 1_000],
      ['v1', 1_000, 2_000],
      ['v3', 2_000, 3_000],
    ])
  })

  it('没越过中点：原样返回，不算改动', () => {
    const before = three()
    expect(expectOk(moveClip(before, { clipId: 'v1', deltaMs: 400 }, context)).draft).toBe(before)
  })

  it('拖过头按 Studio 的拖动夹在整片范围内', () => {
    const { draft } = expectOk(moveClip(three(), { clipId: 'v3', deltaMs: -50_000 }, context))
    expect(draft.layer0.map((c) => c.id)).toEqual(['v3', 'v1', 'v2'])
  })

  it('片头片尾不动，视频段只在两者之间换位', () => {
    const { draft } = expectOk(moveClip(withCards(), { clipId: 'v2', deltaMs: -50_000 }, context))
    expect(draft.layer0.map((c) => c.id)).toEqual(['c1', 'v2', 'v1', 'c2'])
    expect(moveClip(withCards(), { clipId: 'c1', deltaMs: 3_000 }, context)).toEqual({
      ok: false,
      refusal: 'not-a-video',
    })
    expect(moveClip(withCards(), { clipId: 'x', deltaMs: 1 }, context)).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })

  it('转场跟着它前面那段走；换位后放不下就拒绝', () => {
    // v1 后面挂 0.5 秒转场（切点前后各 0.25 秒）；把 v1 挪到 v2 后面，它的转场跟到 v1→c2 切点，c2 只有 0.2 秒
    const film = draftOf(
      [video('v1', 's1', 0, 600), video('v2', 's1', 0, 1_000), card('c2', 'outro', 200)],
      { transitions: [transition('t1', 'v1')] },
    )
    expect(moveClip(film, { clipId: 'v1', deltaMs: 1_200 }, context)).toEqual({
      ok: false,
      refusal: 'transition-does-not-fit',
    })
  })
})

describe('trimClip', () => {
  /** v1 0–3000（s1 入点 1000）、v2 3000–5000，v1 后面有转场，1 秒处有包装 */
  const base = (): WholeFilmDraft =>
    draftOf([video('v1', 's1', 1_000, 3_000), video('v2', 's2', 0, 2_000)], {
      transitions: [transition('t1', 'v1')],
      overlays: [{ id: 'o1', component: 'badge', start: 1_000, duration: 500, variables: {} }],
    })

  it('修结尾：整轨收紧，后面整体前移；包装不跟随', () => {
    const { draft } = expectOk(
      trimClip(base(), { clipId: 'v1', edge: 'end', deltaMs: -1_000 }, context),
    )
    expect(spans(draft)).toEqual([
      ['v1', 0, 2_000],
      ['v2', 2_000, 4_000],
    ])
    expect(draft.overlays[0]).toMatchObject({ start: 1_000, duration: 500 })
  })

  it('修开头：切点不动，这段从更晚的画面开始，后面整体前移', () => {
    const { draft } = expectOk(
      trimClip(base(), { clipId: 'v1', edge: 'start', deltaMs: 500 }, context),
    )
    expect(draft.layer0[0]).toMatchObject({ start: 0, duration: 2_500, playbackStart: 1_500 })
    expect(draft.layer0[1]).toMatchObject({ start: 2_500 })
  })

  it.each([
    ['结尾修到最短 0.1 秒', 'end', -50_000, { duration: 100, playbackStart: 1_000 }],
    ['开头修到最短 0.1 秒', 'start', 50_000, { duration: 100, playbackStart: 3_900 }],
    ['结尾往后拉到素材末尾为止', 'end', 50_000, { duration: 9_000, playbackStart: 1_000 }],
    ['开头往前拉到素材开头为止', 'start', -50_000, { duration: 4_000, playbackStart: 0 }],
  ] as const)('%s', (_, edge, deltaMs, expected) => {
    // 不挂转场，只看片段本身的边界
    const plain = { ...base(), transitions: [] }
    const { draft } = expectOk(trimClip(plain, { clipId: 'v1', edge, deltaMs }, context))
    expect(draft.layer0[0]).toMatchObject({ start: 0, ...expected })
  })

  it('整片已满 120 秒：再往长拉不动，原样返回', () => {
    const full = draftOf([video('v1', 'big', 0, 119_000), video('v2', 'big', 0, 1_000)])
    expect(
      expectOk(trimClip(full, { clipId: 'v1', edge: 'end', deltaMs: 5_000 }, context)).draft,
    ).toBe(full)
    const near = draftOf([video('v1', 'big', 1_000, 118_000), video('v2', 'big', 0, 1_000)])
    const { draft } = expectOk(
      trimClip(near, { clipId: 'v1', edge: 'start', deltaMs: -5_000 }, context),
    )
    expect(draft.layer0[0]).toMatchObject({ duration: 119_000, playbackStart: 0 })
    expect(filmDuration(draft)).toBe(120_000)
  })

  const trim = (draft: WholeFilmDraft, clipId: string, edge: 'start' | 'end', deltaMs: number) =>
    trimClip(draft, { clipId, edge, deltaMs }, context)

  it('片头只拖右端、片尾只拖左端，拖左端往前是加长', () => {
    const cards = withCards()
    const locked = { ok: false, refusal: 'edge-not-editable' }
    expect(trim(cards, 'c1', 'start', 100)).toEqual(locked)
    expect(trim(cards, 'c2', 'end', 100)).toEqual(locked)
    const intro = expectOk(trim(cards, 'c1', 'end', 500)).draft
    expect(spans(intro)[0]).toEqual(['c1', 0, 2_500])
    expect(filmDuration(intro)).toBe(9_000)
    const outro = expectOk(trim(cards, 'c2', 'start', -500)).draft
    expect(spans(outro).at(-1)).toEqual(['c2', 7_000, 9_000])
    const shortest = expectOk(trim(cards, 'c2', 'start', 9_000)).draft
    expect(spans(shortest).at(-1)).toEqual(['c2', 7_000, 7_100])
  })

  it('片头片尾只受总长上限约束', () => {
    const { draft } = expectOk(trim(withCards(), 'c1', 'end', 500_000))
    expect(filmDuration(draft)).toBe(120_000)
  })

  it('邻段修短到放不下转场时拒绝：转场 0.5 秒，切点后要留 0.25 秒', () => {
    const { draft } = expectOk(trim(base(), 'v2', 'end', -1_750))
    expect(draft.transitions).toEqual([transition('t1', 'v1')])
    expect(trim(base(), 'v2', 'end', -1_751)).toEqual({
      ok: false,
      refusal: 'transition-does-not-fit',
    })
  })

  it('上下文缺少草稿里的成片：是调用方的错，直接报错', () => {
    expect(() =>
      trimClip(base(), { clipId: 'v1', edge: 'end', deltaMs: 1 }, contextOf({})),
    ).toThrow('整片编辑上下文缺少成片 s1')
  })
})

describe('splitClip', () => {
  const base = () =>
    draftOf([video('v1', 's1', 1_000, 3_000), video('v2', 's2', 0, 2_000)], {
      transitions: [transition('t1', 'v1')],
    })

  it('拆成首尾相接的两段，总长不变；原段后面的转场改挂到后半段', () => {
    const { draft } = expectOk(splitClip(base(), { timeMs: 1_200 }, context))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_200],
      ['v3', 1_200, 3_000],
      ['v2', 3_000, 5_000],
    ])
    expect(draft.layer0[1]).toMatchObject({ playbackStart: 2_200, sourceJobId: 's1' })
    expect(draft.transitions).toEqual([transition('t1', 'v3')])
  })

  it.each([
    [100, true],
    [2_900, true],
    [99, false],
    [2_901, false],
  ])('拆开后两段都要不短于 0.1 秒：在 %i 毫秒拆 → %s', (timeMs, ok) => {
    const plain = draftOf([video('v1', 's1', 1_000, 3_000), video('v2', 's2', 0, 2_000)])
    expect(splitClip(plain, { timeMs }, context).ok).toBe(ok)
  })

  it('原段的转场挂到后半段，后半段放不下时拒绝', () => {
    // 转场切点前要留 0.25 秒：在 2800 拆，后半段只剩 0.2 秒
    expect(splitClip(base(), { timeMs: 2_800 }, context)).toEqual({
      ok: false,
      refusal: 'transition-does-not-fit',
    })
  })

  it('拆播放头下的视频段；片头片尾不拆', () => {
    const { draft } = expectOk(splitClip(base(), { timeMs: 4_000, clipId: 'v1' }, context))
    expect(draft.layer0.map((c) => c.id)).toEqual(['v1', 'v2', 'v3'])
    expect(splitClip(withCards(), { timeMs: 1_000 }, context)).toEqual({
      ok: false,
      refusal: 'nothing-to-split',
    })
  })

  it('已有 100 段视频时不能再拆', () => {
    expect(splitClip(manyVideos(100), { timeMs: 500 }, context)).toEqual({
      ok: false,
      refusal: 'too-many-clips',
    })
  })
})

describe('deleteClip', () => {
  const base = () =>
    draftOf(
      [video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 2_000), video('v3', 's1', 0, 3_000)],
      {
        transitions: [transition('t1', 'v1'), transition('t2', 'v2')],
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: 'sub', sentenceIndex: 0, text: '改' }],
        },
      },
    )

  it('删段后整轨收紧；挂在它后面的转场一起删，前面切点上的转场留在新切点上', () => {
    const { draft } = expectOk(deleteClip(base(), { clipId: 'v2' }, context))
    expect(spans(draft)).toEqual([
      ['v1', 0, 1_000],
      ['v3', 1_000, 4_000],
    ])
    expect(draft.transitions.map((t) => t.id)).toEqual(['t1'])
  })

  it('前面切点上的转场换到新切点后放不下：拒绝', () => {
    const film = draftOf(
      [video('v1', 's1', 0, 1_000), video('v2', 's1', 0, 2_000), video('v3', 's1', 0, 200)],
      { transitions: [transition('t1', 'v1')] },
    )
    expect(deleteClip(film, { clipId: 'v2' }, context)).toEqual({
      ok: false,
      refusal: 'transition-does-not-fit',
    })
  })

  it('删掉最后一段：它前面的切点没了，那个转场也去掉', () => {
    const { draft } = expectOk(deleteClip(base(), { clipId: 'v3' }, context))
    expect(draft.transitions.map((t) => t.id)).toEqual(['t1'])
  })

  it('改过的字幕留着（字幕跟着素材走，段加回来时还生效）', () => {
    const { draft } = expectOk(deleteClip(base(), { clipId: 'v1' }, context))
    expect(draft.captions.edits).toHaveLength(1)
  })

  it('删掉片头；没有视频段时画布清空', () => {
    const { draft } = expectOk(deleteClip(withCards(), { clipId: 'c1' }, context))
    expect(spans(draft)[0]).toEqual(['v1', 0, 3_000])
    const noFirst = expectOk(deleteClip(withCards(), { clipId: 'v1' }, context)).draft
    const onlyCards = expectOk(deleteClip(noFirst, { clipId: 'v2' }, context)).draft
    expect(onlyCards.canvas).toBeNull()
    expect(deleteClip(withCards(), { clipId: 'x' }, context)).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })

  it('整片变短：包装截到片尾，剩不到 0.1 秒的去掉', () => {
    const overlay = (id: string, start: number, duration: number) => ({
      id,
      component: 'badge',
      start,
      duration,
      variables: {},
    })
    const film = draftOf([video('v1', 's1', 0, 2_500), video('v2', 's1', 0, 1_500)], {
      overlays: [overlay('o1', 2_000, 1_000), overlay('o2', 3_500, 300)],
    })
    expect(expectOk(deleteClip(film, { clipId: 'v2' }, context)).draft.overlays).toEqual([
      overlay('o1', 2_000, 500),
    ])
    const sliver = draftOf([video('v1', 's1', 0, 2_450), video('v2', 's1', 0, 1_000)], {
      overlays: [overlay('o1', 2_400, 500)],
    })
    expect(expectOk(deleteClip(sliver, { clipId: 'v2' }, context)).draft.overlays).toEqual([])
  })
})

describe('setClipVolume', () => {
  it.each([
    [3, 2],
    [-1, 0],
    [0.5, 0.5],
  ])('音量 %f 收进 0–2 → %f', (volume, expected) => {
    const { draft } = expectOk(setClipVolume(withCards(), { clipId: 'v1', volume }))
    expect(draft.layer0[1]).toMatchObject({ volume: expected })
  })

  it('音量没变原样返回；片头片尾没有原声', () => {
    const before = withCards()
    expect(expectOk(setClipVolume(before, { clipId: 'v1', volume: 1 })).draft).toBe(before)
    expect(setClipVolume(before, { clipId: 'c1', volume: 1 })).toEqual({
      ok: false,
      refusal: 'not-a-video',
    })
  })
})

import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import { MAX_SCALE, MIN_SCALE, type OverlayClip, type WholeFilmDraft } from './draft'
import {
  addOverlay,
  dropOverlay,
  moveOverlay,
  overlayRowAt,
  removeOverlay,
  setOverlayPosition,
  setOverlayTransform,
  trimOverlay,
  type OverlayRow,
} from './overlays'
import { filmDuration, layer0End } from './timeline'
import { setComponentVariables } from './variables'

const withOverlays = (overlays: OverlayClip[]): WholeFilmDraft =>
  draftOf([video('v1', 's1', 0, 10_000)], { overlays })

/** 每块的 [id, 行, 开始, 结束, zIndex]，按草稿里的先后 */
const layout = (draft: WholeFilmDraft) =>
  draft.overlays.map((o) => [o.id, o.track, o.start, o.start + o.duration, o.zIndex])

const badge = (atMs: number, durationMs = 1_000) => ({
  component: 'badge',
  durationMs,
  variables: { label: '新品' },
  atMs,
})

describe('addOverlay：点卡片', () => {
  it('在最上面开一行，从播放头起放，叠在所有特效块之上；原来的行都往下让一行', () => {
    const film = withOverlays([
      overlay('o1', 2_000, 1_000, { track: 0, zIndex: 4 }),
      overlay('o2', 0, 5_000, { track: 1, zIndex: 2 }),
    ])
    const { draft } = expectOk(addOverlay(film, badge(2_500, 1_500)))
    expect(layout(draft)).toEqual([
      ['o1', 1, 2_000, 3_000, 4],
      ['o2', 2, 0, 5_000, 2],
      ['o3', 0, 2_500, 4_000, 5],
    ])
    expect(draft.overlays[2]).toMatchObject({ playbackStart: 0, variables: { label: '新品' } })
  })

  it('第一个特效块的 zIndex 是 1；可以超出画面轨的结尾，画面轨为空也能放', () => {
    const empty = expectOk(addOverlay(draftOf([]), badge(0, 3_000))).draft
    expect(layout(empty)).toEqual([['o1', 0, 0, 3_000, 1]])
  })

  it('超出画面轨结尾的特效块让成片变长：成片到特效块最晚的结尾', () => {
    const film = withOverlays([])
    expect(filmDuration(film)).toBe(10_000)
    const longer = expectOk(addOverlay(film, badge(9_000, 3_500))).draft
    expect([layer0End(longer), filmDuration(longer)]).toEqual([10_000, 12_500])
  })

  it('在 120 秒之后结束的不让放，不截短', () => {
    expect(addOverlay(withOverlays([]), badge(119_000)).ok).toBe(true)
    expect(addOverlay(withOverlays([]), badge(119_001))).toEqual({
      ok: false,
      refusal: 'overlay-too-long',
    })
  })
})

describe('overlayRowAt：指针落在哪一行', () => {
  it.each<[number, number, OverlayRow]>([
    [-0.2, 2, { insertAt: 0 }],
    [0, 2, { track: 0 }],
    [1.9, 2, { track: 1 }],
    [2, 2, { insertAt: 2 }],
    [0.5, 0, { insertAt: 0 }],
  ])('第 %f 行（共 %i 行）→ %o', (rowFloat, count, row) => {
    expect(overlayRowAt(rowFloat, count)).toEqual(row)
  })
})

describe('dropOverlay：拖卡片到特效轨', () => {
  /** 第 0 行 x 2–3 秒；第 1 行 y 0–3 秒、z 3–6 秒 */
  const film = () =>
    withOverlays([
      overlay('x', 2_000, 1_000, { track: 0, zIndex: 1 }),
      overlay('y', 0, 3_000, { track: 1, zIndex: 2 }),
      overlay('z', 3_500, 2_500, { track: 1, zIndex: 3 }),
    ])

  it('落在行上的空处：就放在那一刻，叠在所有特效块之上', () => {
    const { draft } = expectOk(dropOverlay(film(), { ...badge(4_000), row: { track: 0 } }))
    expect(layout(draft).at(-1)).toEqual(['o1', 0, 4_000, 5_000, 4])
  })

  it('与行上的块相撞：挪到这一行离它最近的空位，不截短', () => {
    const nearer = expectOk(dropOverlay(film(), { ...badge(2_500), row: { track: 0 } })).draft
    expect(layout(nearer).at(-1)).toEqual(['o1', 0, 3_000, 4_000, 4])
  })

  it('前后两个空位一样近：取后面的', () => {
    const tie = expectOk(dropOverlay(film(), { ...badge(2_000), row: { track: 0 } })).draft
    expect(layout(tie).at(-1)).toEqual(['o1', 0, 3_000, 4_000, 4])
  })

  it('行上没有放得下的空当：放在这一行最后一块之后', () => {
    const { draft } = expectOk(dropOverlay(film(), { ...badge(3_200, 2_000), row: { track: 1 } }))
    expect(layout(draft).at(-1)).toEqual(['o1', 1, 6_000, 8_000, 4])
  })

  it('落在所有行之上或之下的空处：在那里开一行', () => {
    const above = expectOk(dropOverlay(film(), { ...badge(2_500), row: { insertAt: 0 } })).draft
    expect(layout(above)).toEqual([
      ['x', 1, 2_000, 3_000, 1],
      ['y', 2, 0, 3_000, 2],
      ['z', 2, 3_500, 6_000, 3],
      ['o1', 0, 2_500, 3_500, 4],
    ])
    const below = expectOk(dropOverlay(film(), { ...badge(2_500), row: { insertAt: 2 } })).draft
    expect(layout(below).at(-1)).toEqual(['o1', 2, 2_500, 3_500, 4])
    expect(layout(below).slice(0, 3)).toEqual(layout(film()))
  })

  it('挪到空位后在 120 秒之后结束：不让放', () => {
    const late = withOverlays([overlay('x', 100_000, 19_500, { track: 0 })])
    expect(dropOverlay(late, { ...badge(110_000), row: { track: 0 } })).toEqual({
      ok: false,
      refusal: 'overlay-too-long',
    })
  })
})

describe('moveOverlay：拖特效块', () => {
  it('只在原来那一行左右挪：相撞就停在最近的空位，zIndex 都不变', () => {
    const film = withOverlays([
      overlay('a', 0, 1_000, { track: 0, zIndex: 1 }),
      overlay('b', 3_000, 1_000, { track: 0, zIndex: 7 }),
    ])
    const free = expectOk(moveOverlay(film, { overlayId: 'a', deltaMs: 1_000 })).draft
    expect(layout(free)).toEqual([
      ['a', 0, 1_000, 2_000, 1],
      ['b', 0, 3_000, 4_000, 7],
    ])
    const blocked = expectOk(moveOverlay(film, { overlayId: 'a', deltaMs: 3_200 })).draft
    expect(layout(blocked)[0]).toEqual(['a', 0, 4_000, 5_000, 1])
    const before = withOverlays([overlay('a', 0, 1_000)])
    expect(expectOk(moveOverlay(before, { overlayId: 'a', deltaMs: 0 })).draft).toBe(before)
  })

  it('拖过头停在 0 与 120 秒之间', () => {
    const film = withOverlays([overlay('a', 5_000, 2_000)])
    expect(layout(expectOk(moveOverlay(film, { overlayId: 'a', deltaMs: 500_000 })).draft)).toEqual(
      [['a', 0, 118_000, 120_000, 1]],
    )
    expect(layout(expectOk(moveOverlay(film, { overlayId: 'a', deltaMs: -50_000 })).draft)).toEqual(
      [['a', 0, 0, 2_000, 1]],
    )
  })

  it('往上挪：盖过现在压在它下面、时间上重叠的块；别的块不变', () => {
    // a 在第 0 行、z 5；b 在第 1 行、z 1，与 a 重叠；c 在第 1 行、z 9，与 b 不重叠
    const film = withOverlays([
      overlay('a', 0, 4_000, { track: 0, zIndex: 5 }),
      overlay('b', 1_000, 2_000, { track: 1, zIndex: 1 }),
      overlay('c', 5_000, 1_000, { track: 1, zIndex: 9 }),
    ])
    const { draft } = expectOk(
      moveOverlay(film, { overlayId: 'b', deltaMs: 0, row: { insertAt: 0 } }),
    )
    expect(layout(draft)).toEqual([
      ['a', 1, 0, 4_000, 5],
      ['b', 0, 1_000, 3_000, 6],
      ['c', 2, 5_000, 6_000, 9],
    ])
  })

  it('往上挪时已经盖过下面的块：zIndex 不变', () => {
    const film = withOverlays([
      overlay('a', 0, 4_000, { track: 0, zIndex: 1 }),
      overlay('b', 1_000, 2_000, { track: 1, zIndex: 3 }),
    ])
    const { draft } = expectOk(
      moveOverlay(film, { overlayId: 'b', deltaMs: 0, row: { insertAt: 0 } }),
    )
    expect(layout(draft)).toEqual([
      ['a', 1, 0, 4_000, 1],
      ['b', 0, 1_000, 3_000, 3],
    ])
  })

  it('往下挪：沉到现在压在它上面、时间上重叠的块之下，不低于 0；别的块不变', () => {
    const film = withOverlays([
      overlay('a', 0, 4_000, { track: 0, zIndex: 5 }),
      overlay('b', 0, 4_000, { track: 1, zIndex: 1 }),
      overlay('c', 6_000, 1_000, { track: 1, zIndex: 2 }),
    ])
    const { draft } = expectOk(
      moveOverlay(film, { overlayId: 'a', deltaMs: 0, row: { insertAt: 2 } }),
    )
    expect(layout(draft)).toEqual([
      ['a', 1, 0, 4_000, 0],
      ['b', 0, 0, 4_000, 1],
      ['c', 0, 6_000, 7_000, 2],
    ])
  })

  it('往下挪到已有的一行：相撞挪到空位，按落定后的位置重排叠放', () => {
    const film = withOverlays([
      overlay('a', 2_000, 4_000, { track: 0, zIndex: 5 }),
      overlay('b', 0, 4_000, { track: 1, zIndex: 1 }),
      overlay('c', 4_000, 4_000, { track: 2, zIndex: 3 }),
    ])
    const { draft } = expectOk(moveOverlay(film, { overlayId: 'a', deltaMs: 0, row: { track: 2 } }))
    // c 在 4–8 秒，a 落到 0–4 秒；第 0 行空了，行号收紧；a 现在只与上面的 b 重叠，沉到 b 之下
    expect(layout(draft)).toEqual([
      ['a', 1, 0, 4_000, 0],
      ['b', 0, 0, 4_000, 1],
      ['c', 1, 4_000, 8_000, 3],
    ])
  })
})

describe('trimOverlay', () => {
  const film = () =>
    withOverlays([
      overlay('a', 2_000, 1_000, { track: 0 }),
      overlay('b', 6_000, 2_000, { track: 0 }),
      overlay('c', 0, 9_000, { track: 1 }),
    ])

  it.each([
    ['右端拉到同一行的下一块为止', 'a', 'end', 10_000, ['a', 2_000, 6_000, 0]],
    ['左端拉到同一行的上一块为止（入点 0 拉不动）', 'b', 'start', -10_000, ['b', 6_000, 8_000, 0]],
    ['右端拉到 120 秒为止', 'b', 'end', 500_000, ['b', 6_000, 120_000, 0]],
    ['不同行的块不挡', 'c', 'end', 5_000, ['c', 0, 14_000, 0]],
    ['修左端：从组件自己时间里更晚处起播', 'b', 'start', 500, ['b', 6_500, 8_000, 500]],
    ['最短 0.1 秒', 'b', 'start', 10_000, ['b', 7_900, 8_000, 1_900]],
  ] as const)('%s', (_, overlayId, edge, deltaMs, expected) => {
    const { draft } = expectOk(trimOverlay(film(), { overlayId, edge, deltaMs }))
    expect(
      draft.overlays.map((o) => [o.id, o.start, o.start + o.duration, o.playbackStart]),
    ).toContainEqual(expected)
  })

  it('入点不是 0 时左端能往前拉，退到 0 或碰到同一行的上一块就停住', () => {
    const trimmed = withOverlays([
      overlay('a', 0, 1_000, { track: 0 }),
      overlay('b', 3_000, 1_000, { track: 0, playbackStart: 600 }),
    ])
    const { draft } = expectOk(
      trimOverlay(trimmed, { overlayId: 'b', edge: 'start', deltaMs: -5_000 }),
    )
    expect(draft.overlays[1]).toMatchObject({ start: 2_400, duration: 1_600, playbackStart: 0 })
  })
})

describe('removeOverlay 与可填项', () => {
  it('删掉特效块，空出来的行收掉；改特效块的可填项', () => {
    const film = withOverlays([
      overlay('a', 0, 1_000, { track: 0 }),
      overlay('b', 0, 1_000, { track: 1 }),
      overlay('c', 0, 1_000, { track: 2 }),
    ])
    const removed = expectOk(removeOverlay(film, { overlayId: 'b' })).draft
    expect(removed.overlays.map((o) => [o.id, o.track])).toEqual([
      ['a', 0],
      ['c', 1],
    ])
    expect(removeOverlay(film, { overlayId: 'x' })).toEqual({ ok: false, refusal: 'unknown-clip' })
    const edited = expectOk(
      setComponentVariables(film, { id: 'c', variables: { label: '限时' } }),
    ).draft
    expect(edited.overlays[2]?.variables).toEqual({ label: '限时' })
  })
})

describe('setOverlayPosition：在画面上挪', () => {
  const film = () =>
    withOverlays([overlay('a', 0, 1_000, { track: 0 }), overlay('b', 0, 1_000, { track: 1 })])

  it('只改这一块的位置：取整，裁在 ±4096 以内', () => {
    const moved = expectOk(setOverlayPosition(film(), { overlayId: 'b', x: 120.4, y: -35.6 })).draft
    expect(moved.overlays.map((o) => [o.id, o.x, o.y])).toEqual([
      ['a', 0, 0],
      ['b', 120, -36],
    ])
    const far = expectOk(setOverlayPosition(film(), { overlayId: 'a', x: 5_000, y: -9_999 })).draft
    expect(far.overlays[0]).toMatchObject({ x: 4_096, y: -4_096 })
    // -0.4 取整得 -0，记成 0
    const near = expectOk(setOverlayPosition(moved, { overlayId: 'b', x: -0.4, y: 0 })).draft
    expect(Object.is(near.overlays[1]?.x, 0)).toBe(true)
  })

  it('位置没变时原样返回；没写位置的块按没挪过算；不认识的 id 被拒', () => {
    const draft = film()
    expect(expectOk(setOverlayPosition(draft, { overlayId: 'a', x: 0.3, y: -0.2 })).draft).toBe(
      draft,
    )
    // 有位置之前存的草稿没写 x、y
    const { x: _x, y: _y, ...legacy } = overlay('a', 0, 1_000)
    const unset = withOverlays([legacy])
    expect(expectOk(setOverlayPosition(unset, { overlayId: 'a', x: 0, y: 0 })).draft).toBe(unset)
    expect(setOverlayPosition(draft, { overlayId: 'x', x: 1, y: 1 })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })

  it('时间线上挪动、换行、修剪、改可填项、在画面上挪都保留位置与缩放、旋转、转轴', () => {
    const placed = withOverlays([
      overlay('a', 2_000, 1_000, {
        track: 0,
        x: 40,
        y: -60,
        scale: 1.5,
        rotation: -30,
        pivotX: 300,
        pivotY: 900,
      }),
      overlay('b', 0, 1_000, { track: 1, x: -8, y: 12 }),
    ])
    const placements = (draft: WholeFilmDraft) =>
      Object.fromEntries(
        draft.overlays.map((o) => [o.id, [o.x, o.y, o.scale, o.rotation, o.pivotX, o.pivotY]]),
      )
    const before = placements(placed)
    const edits = [
      moveOverlay(placed, { overlayId: 'a', deltaMs: 500 }),
      moveOverlay(placed, { overlayId: 'a', deltaMs: 0, row: { insertAt: 2 } }),
      trimOverlay(placed, { overlayId: 'a', edge: 'start', deltaMs: 300 }),
      setComponentVariables(placed, { id: 'b', variables: { label: '限时' } }),
      removeOverlay(placed, { overlayId: 'b' }),
    ]
    for (const result of edits) {
      const after = placements(expectOk(result).draft)
      for (const [id, at] of Object.entries(after)) expect(at).toEqual(before[id])
    }
    const moved = expectOk(setOverlayPosition(placed, { overlayId: 'a', x: 0, y: 0 })).draft
    expect(placements(moved)['a']).toEqual([0, 0, 1.5, -30, 300, 900])
  })
})

describe('setOverlayTransform：在画面上缩放、旋转', () => {
  const film = () =>
    withOverlays([overlay('a', 0, 1_000, { track: 0 }), overlay('b', 0, 1_000, { track: 1 })])
  const pivot = { x: 200, y: 300 }

  it('只改这一块：倍数裁在 10%–1000%，角度规整到 (-180, 180]', () => {
    const turned = expectOk(
      setOverlayTransform(film(), { overlayId: 'b', scale: 1.25, rotation: 45, pivot }),
    ).draft
    expect(turned.overlays[0]).toEqual(film().overlays[0])
    expect(turned.overlays[1]).toMatchObject({ scale: 1.25, rotation: 45 })

    const scaleOf = (scale: number) =>
      expectOk(setOverlayTransform(film(), { overlayId: 'a', scale, rotation: 0, pivot })).draft
        .overlays[0]?.scale
    expect([scaleOf(0.05), scaleOf(11), scaleOf(MIN_SCALE), scaleOf(MAX_SCALE)]).toEqual([
      MIN_SCALE,
      MAX_SCALE,
      0.1,
      10,
    ])

    const rotationOf = (rotation: number) =>
      expectOk(setOverlayTransform(film(), { overlayId: 'a', scale: 1, rotation, pivot })).draft
        .overlays[0]?.rotation
    // 范围里的小数原样记下，不带出浮点误差
    expect([-180, 190, 540, -190, 180, -179.5, 720.5, -2.3].map(rotationOf)).toEqual([
      180, -170, 180, 170, 180, -179.5, 0.5, -2.3,
    ])
  })

  it('转轴在离开原大、不转时记下（取整、裁法同位置），变换着时沿用，回到原大、不转后再变换重取', () => {
    const first = expectOk(
      setOverlayTransform(film(), {
        overlayId: 'a',
        scale: 2,
        rotation: 0,
        pivot: { x: 120.6, y: -5_000 },
      }),
    ).draft
    expect(first.overlays[0]).toMatchObject({ pivotX: 121, pivotY: -4_096 })
    // 变换着时再转、再缩、缩回原大都沿用记下的转轴
    const again = expectOk(
      setOverlayTransform(first, {
        overlayId: 'a',
        scale: 0.5,
        rotation: 90,
        pivot: { x: 1, y: 2 },
      }),
    ).draft
    expect(again.overlays[0]).toMatchObject({
      scale: 0.5,
      rotation: 90,
      pivotX: 121,
      pivotY: -4_096,
    })
    const back = expectOk(
      setOverlayTransform(again, { overlayId: 'a', scale: 1, rotation: 0, pivot: { x: 3, y: 4 } }),
    ).draft
    expect(back.overlays[0]).toMatchObject({ scale: 1, rotation: 0, pivotX: 121, pivotY: -4_096 })
    // 回到原大、不转之后画面上没有变换，下一次变换取新的转轴
    const anew = expectOk(
      setOverlayTransform(back, { overlayId: 'a', scale: 1, rotation: 45, pivot: { x: 5, y: 6 } }),
    ).draft
    expect(anew.overlays[0]).toMatchObject({ scale: 1, rotation: 45, pivotX: 5, pivotY: 6 })
    // 有这几个字段之前存的草稿没写它们，按原大、不转算，第一次变换就记下转轴
    const { scale: _s, rotation: _r, pivotX: _px, pivotY: _py, ...legacy } = overlay('a', 0, 1_000)
    const legacyTurned = expectOk(
      setOverlayTransform(withOverlays([legacy]), { overlayId: 'a', scale: 2, rotation: 0, pivot }),
    ).draft
    expect(legacyTurned.overlays[0]).toMatchObject({ scale: 2, pivotX: 200, pivotY: 300 })
  })

  it('倍数与角度都没变时原样返回，转轴也不写；没写这些字段的块按原大、不转算；不认识的 id 被拒', () => {
    const draft = film()
    expect(
      expectOk(setOverlayTransform(draft, { overlayId: 'a', scale: 1, rotation: 0, pivot })).draft,
    ).toBe(draft)
    // 规整之后再比：360° 是 0°，300° 是 -60°
    expect(
      expectOk(setOverlayTransform(draft, { overlayId: 'a', scale: 1, rotation: 360, pivot }))
        .draft,
    ).toBe(draft)
    const turned = expectOk(
      setOverlayTransform(draft, { overlayId: 'a', scale: 3, rotation: -60, pivot }),
    ).draft
    expect(
      expectOk(
        setOverlayTransform(turned, {
          overlayId: 'a',
          scale: 3,
          rotation: 300,
          pivot: { x: 9, y: 9 },
        }),
      ).draft,
    ).toBe(turned)
    // 有这几个字段之前存的草稿没写它们
    const { scale: _s, rotation: _r, pivotX: _px, pivotY: _py, ...legacy } = overlay('a', 0, 1_000)
    const unset = withOverlays([legacy])
    expect(
      expectOk(setOverlayTransform(unset, { overlayId: 'a', scale: 1, rotation: 0, pivot })).draft,
    ).toBe(unset)
    expect(setOverlayTransform(draft, { overlayId: 'x', scale: 2, rotation: 0, pivot })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })
})

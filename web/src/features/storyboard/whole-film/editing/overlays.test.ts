import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, video } from '@/testing/whole-film'
import type { OverlayClip } from './draft'
import { addOverlay, moveOverlay, removeOverlay, trimOverlay } from './overlays'
import { setComponentVariables } from './variables'

const overlay = (id: string, start: number, duration: number): OverlayClip => ({
  id,
  component: 'badge',
  start,
  duration,
  variables: {},
})

/** 整片 10 秒，包装 o1 2–3 秒、o2 6–8 秒 */
const film = () =>
  draftOf([video('v1', 's1', 0, 10_000)], {
    overlays: [overlay('o1', 2_000, 1_000), overlay('o2', 6_000, 2_000)],
  })

const spansOf = (overlays: OverlayClip[]) =>
  overlays.map((o) => [o.id, o.start, o.start + o.duration])

describe('addOverlay', () => {
  const badge = (atMs: number, durationMs = 1_500) => ({
    component: 'badge',
    durationMs,
    variables: { label: '新品' },
    atMs,
  })

  it('从播放头开始，时长取组件自带的', () => {
    const { draft } = expectOk(addOverlay(film(), badge(3_500)))
    expect(spansOf(draft.overlays)).toEqual([
      ['o1', 2_000, 3_000],
      ['o3', 3_500, 5_000],
      ['o2', 6_000, 8_000],
    ])
    expect(draft.overlays[1]?.variables).toEqual({ label: '新品' })
  })

  it('后面放不下就往前挪，空当比组件短就截短到空当', () => {
    const shifted = expectOk(addOverlay(film(), badge(5_000))).draft
    expect(spansOf(shifted.overlays)[1]).toEqual(['o3', 4_500, 6_000])
    const truncated = expectOk(addOverlay(film(), badge(3_200, 5_000))).draft
    expect(spansOf(truncated.overlays)[1]).toEqual(['o3', 3_000, 6_000])
  })

  it('超过整片就截短到片尾', () => {
    const { draft } = expectOk(addOverlay(draftOf([video('v1', 's1', 0, 1_000)]), badge(0, 3_000)))
    expect(spansOf(draft.overlays)).toEqual([['o1', 0, 1_000]])
  })

  it('播放头落在已有包装上、空当不足 0.1 秒、整片为空：都不加', () => {
    expect(addOverlay(film(), badge(2_500))).toEqual({ ok: false, refusal: 'no-room' })
    const tight = draftOf([video('v1', 's1', 0, 10_000)], {
      overlays: [overlay('o1', 0, 3_000), overlay('o2', 3_050, 1_000)],
    })
    expect(addOverlay(tight, badge(3_000))).toEqual({ ok: false, refusal: 'no-room' })
    expect(addOverlay(draftOf([]), badge(0))).toEqual({ ok: false, refusal: 'no-room' })
  })
})

describe('moveOverlay', () => {
  it('按 Studio 的拖动移动，停在相邻包装和片尾之间', () => {
    const moved = expectOk(moveOverlay(film(), { overlayId: 'o1', deltaMs: 1_000 })).draft
    expect(spansOf(moved.overlays)[0]).toEqual(['o1', 3_000, 4_000])
    const blocked = expectOk(moveOverlay(film(), { overlayId: 'o1', deltaMs: 10_000 })).draft
    expect(spansOf(blocked.overlays)[0]).toEqual(['o1', 5_000, 6_000])
    const atEnd = expectOk(moveOverlay(film(), { overlayId: 'o2', deltaMs: 10_000 })).draft
    expect(spansOf(atEnd.overlays)[1]).toEqual(['o2', 8_000, 10_000])
    const atStart = expectOk(moveOverlay(film(), { overlayId: 'o1', deltaMs: -10_000 })).draft
    expect(spansOf(atStart.overlays)[0]).toEqual(['o1', 0, 1_000])
  })

  it('没动原样返回；不认识的拒绝', () => {
    const before = film()
    expect(expectOk(moveOverlay(before, { overlayId: 'o1', deltaMs: 0 })).draft).toBe(before)
    expect(moveOverlay(before, { overlayId: 'x', deltaMs: 0 })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })
})

describe('trimOverlay', () => {
  it.each([
    ['右端拉到下一段包装为止', 'o1', 'end', 10_000, ['o1', 2_000, 6_000]],
    ['左端拉到上一段包装为止', 'o2', 'start', -10_000, ['o2', 3_000, 8_000]],
    ['右端拉到片尾为止', 'o2', 'end', 10_000, ['o2', 6_000, 10_000]],
    ['最短 0.1 秒', 'o2', 'start', 10_000, ['o2', 7_900, 8_000]],
  ] as const)('%s', (_, overlayId, edge, deltaMs, expected) => {
    const { draft } = expectOk(trimOverlay(film(), { overlayId, edge, deltaMs }))
    expect(spansOf(draft.overlays)).toContainEqual(expected)
  })
})

describe('removeOverlay 与可填项', () => {
  it('删掉包装；改包装的可填项', () => {
    const removed = expectOk(removeOverlay(film(), { overlayId: 'o1' })).draft
    expect(removed.overlays.map((o) => o.id)).toEqual(['o2'])
    expect(removeOverlay(film(), { overlayId: 'x' })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
    const edited = expectOk(
      setComponentVariables(film(), { id: 'o2', variables: { label: '限时' } }),
    ).draft
    expect(edited.overlays[1]?.variables).toEqual({ label: '限时' })
  })
})

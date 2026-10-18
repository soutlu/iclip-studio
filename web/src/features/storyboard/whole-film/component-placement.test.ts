import { describe, expect, it } from 'vitest'
import { card, draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import catalogJson from './catalog/catalog.json'
import { itemOf, type ComponentCatalog } from './component-catalog'
import { placeComponent, placedPiece, type Placing, type TrackLane } from './component-placement'
import type { WholeFilmDraft } from './editing/draft'
import type { OverlayRow } from './editing/overlays'

const catalog = catalogJson as ComponentCatalog
const item = (name: string) => {
  const found = itemOf(catalog, name)
  if (found === undefined) throw new Error(`目录里没有 ${name}`)
  return found
}

/** v1 0–3000、v2 3000–5000 */
const film = (): WholeFilmDraft =>
  draftOf([video('v1', 's1', 0, 3_000), video('v2', 's1', 0, 2_000)])

const click = (playheadMs: number): Placing => ({ via: 'click', playheadMs })
const drop = (lane: TrackLane, timeMs: number, overlayRow: OverlayRow = { track: 0 }): Placing => ({
  via: 'drop',
  lane,
  timeMs,
  overlayRow,
})

const layerIds = (draft: WholeFilmDraft) => draft.layer0.map((clip) => clip.id)

describe('placeComponent：点卡片按 kind 去处', () => {
  it('block 插进成片轨离播放头最近的切点，时长取组件自己的', () => {
    // logo-outro 是 block，6 秒；播放头 2 秒在 v1 后半，插到 v1 与 v2 之间
    const { draft } = expectOk(placeComponent(film(), item('logo-outro'), click(2_000)))
    expect(layerIds(draft)).toEqual(['v1', 'c1', 'v2'])
    expect(draft.layer0[1]).toMatchObject({
      type: 'component',
      component: 'logo-outro',
      start: 3_000,
      duration: 6_000,
      playbackStart: 0,
      variables: {},
    })
    expect(draft.overlays).toEqual([])
  })

  it('component 放到特效轨：在最上面开一行，从播放头开始，叠在最上面，成片轨不动', () => {
    // hw-arrow 是 component，4 秒
    const busy = draftOf([video('v1', 's1', 0, 3_000), video('v2', 's1', 0, 2_000)], {
      overlays: [overlay('o1', 0, 1_000, { zIndex: 3 })],
    })
    const { draft } = expectOk(placeComponent(busy, item('hw-arrow'), click(1_200)))
    expect(layerIds(draft)).toEqual(['v1', 'v2'])
    expect(draft.overlays).toEqual([
      { ...overlay('o1', 0, 1_000, { zIndex: 3 }), track: 1 },
      {
        id: 'o2',
        component: 'hw-arrow',
        start: 1_200,
        duration: 4_000,
        playbackStart: 0,
        track: 0,
        zIndex: 4,
        variables: {},
      },
    ])
  })

  it('字幕样式换掉整片的字幕样式', () => {
    const { draft } = expectOk(placeComponent(film(), item('caption-highlight'), click(0)))
    expect(draft.captions.component).toBe('caption-highlight')
    expect(draft.layer0).toEqual(film().layer0)
  })

  it('没有固定时长的组件：取 10 秒与整片时长里长的那个', () => {
    // count-up 是 component、没有固定时长
    const short = expectOk(placeComponent(film(), item('count-up'), click(0))).draft
    expect(short.overlays[0]?.duration).toBe(10_000)
    const long = draftOf([video('v1', 's1', 0, 15_000)])
    expect(
      expectOk(placeComponent(long, item('count-up'), click(0))).draft.overlays[0]?.duration,
    ).toBe(15_000)
  })
})

describe('placeComponent：拖放只看落在哪条轨', () => {
  it('component 拖到成片轨也是一段，插到离松手处最近的切点', () => {
    const { draft } = expectOk(placeComponent(film(), item('hw-arrow'), drop('film', 4_500)))
    expect(layerIds(draft)).toEqual(['v1', 'v2', 'c1'])
    expect(draft.layer0[2]).toMatchObject({ start: 5_000, duration: 4_000 })
  })

  it('block 拖到特效轨就是特效块，落在松手处的那一行、那一刻', () => {
    const busy = draftOf([video('v1', 's1', 0, 3_000)], {
      overlays: [overlay('o1', 0, 1_000, { track: 0 }), overlay('o2', 0, 1_000, { track: 1 })],
    })
    const { draft } = expectOk(
      placeComponent(busy, item('logo-outro'), drop('overlay', 1_500, { track: 1 })),
    )
    expect(layerIds(draft)).toEqual(['v1'])
    expect(draft.overlays.at(-1)).toMatchObject({
      component: 'logo-outro',
      start: 1_500,
      duration: 6_000,
      track: 1,
    })
    const opened = expectOk(
      placeComponent(busy, item('logo-outro'), drop('overlay', 500, { insertAt: 2 })),
    ).draft
    expect(opened.overlays.at(-1)).toMatchObject({ start: 500, track: 2 })
  })

  it('转场类组件只是普通组件：拖到特效轨放在松手处，不对齐切点', () => {
    const { draft } = expectOk(
      placeComponent(film(), item('grid-pixelate-wipe'), drop('overlay', 2_400)),
    )
    expect(draft.overlays[0]).toMatchObject({ start: 2_400, duration: 1_200 })
  })

  it('组件段可以放在已有组件段旁边、整片最前', () => {
    const cards = draftOf([card('c1', 1_000), video('v1', 's1', 0, 3_000)])
    const { draft } = expectOk(placeComponent(cards, item('logo-outro'), drop('film', 100)))
    expect(layerIds(draft)).toEqual(['c2', 'c1', 'v1'])
  })

  it.each([
    ['字幕样式拖到成片轨', 'caption-highlight', 'film'],
    ['字幕样式拖到特效轨', 'caption-highlight', 'overlay'],
    ['别的组件拖到字幕轨', 'hw-arrow', 'caption'],
    ['拖到音乐轨', 'logo-outro', 'music'],
  ] as const)('%s：拒绝', (_, name, lane) => {
    expect(placeComponent(film(), item(name), drop(lane, 0))).toEqual({
      ok: false,
      refusal: 'drop-elsewhere',
    })
  })

  it('放进去超过 120 秒：成片轨与特效轨都拒绝，不缩短', () => {
    const full = draftOf([video('v1', 's1', 0, 115_000)], { overlays: [overlay('o1', 0, 1_000)] })
    expect(placeComponent(full, item('logo-outro'), drop('film', 0))).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
    expect(placeComponent(full, item('logo-outro'), drop('overlay', 114_001))).toEqual({
      ok: false,
      refusal: 'overlay-too-long',
    })
  })
})

describe('placedPiece：放置后新出现的片段', () => {
  const before = draftOf([video('v1', 's1', 0, 3_000), card('c1', 1_000)], {
    overlays: [overlay('o1', 0, 1_000)],
  })

  it('插进成片轨的是组件段，放到特效轨的是特效块', () => {
    const clip = expectOk(placeComponent(before, item('logo-outro'), drop('film', 0))).draft
    expect(placedPiece(before, clip)).toEqual({
      kind: 'clip',
      id: layerIds(clip).find((id) => !layerIds(before).includes(id)),
    })
    const block = expectOk(placeComponent(before, item('hw-arrow'), click(0))).draft
    expect(placedPiece(before, block)).toEqual({
      kind: 'overlay',
      id: block.overlays.find((entry) => entry.id !== 'o1')?.id,
    })
  })

  it('换字幕样式没有新片段', () => {
    const styled = expectOk(placeComponent(before, item('caption-highlight'), click(0))).draft
    expect(placedPiece(before, styled)).toBeUndefined()
  })
})

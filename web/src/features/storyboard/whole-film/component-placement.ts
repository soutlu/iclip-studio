import { durationMsOf, type CatalogItem } from './component-catalog'
import type { WholeFilmDraft } from './editing/draft'
import { insertComponent } from './editing/layer0'
import { addOverlay, dropOverlay, type OverlayRow } from './editing/overlays'
import { refuse, type EditResult } from './editing/result'
import { filmDuration } from './editing/timeline'

/** 拖着东西能落到的轨；字幕轨不收拖放，字幕样式只在字幕轨标题上换 */
export type TrackLane = 'film' | 'overlay' | 'music'

/**
 * 组件怎么到成片里：点组件栏里的卡片（放在播放头处），或拖到某条轨的某个时刻松手；
 * `overlayRow` 是松手处在特效轨上对应的行，只在拖到特效轨时用。
 */
export type Placing =
  | { via: 'click'; playheadMs: number }
  | { via: 'drop'; lane: TrackLane; timeMs: number; overlayRow: OverlayRow }

/** 点卡片时的去处：block 插进画面轨，其余放到特效轨 */
const clickLane = (item: CatalogItem): TrackLane => (item.kind === 'block' ? 'film' : 'overlay')

/** 放置后新出现的那个组件段或特效块；没有新片段时为 undefined */
export const placedPiece = (
  before: WholeFilmDraft,
  after: WholeFilmDraft,
): { kind: 'clip' | 'overlay'; id: string } | undefined => {
  const clips = new Set(before.layer0.map((clip) => clip.id))
  const clip = after.layer0.find((item) => !clips.has(item.id))
  if (clip !== undefined) return { kind: 'clip', id: clip.id }
  const overlays = new Set(before.overlays.map((overlay) => overlay.id))
  const overlay = after.overlays.find((item) => !overlays.has(item.id))
  return overlay === undefined ? undefined : { kind: 'overlay', id: overlay.id }
}

/**
 * 把组件目录里的一个组件放进成片，一步编辑；放到哪条轨只看拖到哪条轨（点卡片时看 {@link clickLane}）：
 * - 画面轨：作为一段插到离那一刻最近的切点，后面的段跟着让开；
 * - 特效轨：点卡片时在最上面开一行、从播放头起放；拖放时落到松手处的那一行，相撞就挪到这一行
 *   最近的空位，松手在所有行之上或之下就开一行；新放的特效块叠在所有特效块之上；
 * - 音乐轨放不了组件。
 * 时长取组件自己的时长，没有时取 10 秒与成片时长里长的那个；放进去超过成片总长上限时拒绝，不缩短。
 * 可填项都不写进草稿，合成时取组件自己的默认值。
 */
export const placeComponent = (
  draft: WholeFilmDraft,
  item: CatalogItem,
  placing: Placing,
): EditResult => {
  const lane = placing.via === 'drop' ? placing.lane : clickLane(item)
  const timeMs = placing.via === 'drop' ? placing.timeMs : placing.playheadMs
  if (lane === 'music') return refuse('drop-elsewhere')
  const duration = durationMsOf(item, filmDuration(draft))
  switch (lane) {
    case 'film':
      return insertComponent(draft, {
        component: item.name,
        duration,
        variables: {},
        at: { timeMs },
      })
    case 'overlay': {
      const overlay = { component: item.name, durationMs: duration, variables: {}, atMs: timeMs }
      return placing.via === 'drop'
        ? dropOverlay(draft, { ...overlay, row: placing.overlayRow })
        : addOverlay(draft, overlay)
    }
  }
}

import { durationMsOf, type CatalogItem } from './component-catalog'
import type { WholeFilmDraft } from './editing/draft'
import { insertComponent } from './editing/layer0'
import { addOverlay, dropOverlay, type OverlayRow } from './editing/overlays'
import { refuse, type EditResult } from './editing/result'

export type TrackLane = 'film' | 'overlay' | 'music'

export type Placing =
  | { via: 'click'; playheadMs: number }
  | { via: 'drop'; lane: TrackLane; timeMs: number; overlayRow: OverlayRow }

const clickLane = (item: CatalogItem): TrackLane => (item.kind === 'block' ? 'film' : 'overlay')

export const placedPiece = (
  before: WholeFilmDraft,
  after: WholeFilmDraft,
): { kind: 'clip'; id: string } | { kind: 'overlay'; id: string } | undefined => {
  const clips = new Set(before.layer0.map((clip) => clip.id))
  const clip = after.layer0.find((item) => !clips.has(item.id))
  if (clip !== undefined) return { kind: 'clip', id: clip.id }
  const overlays = new Set(before.overlays.map((overlay) => overlay.id))
  const overlay = after.overlays.find((item) => !overlays.has(item.id))
  return overlay === undefined ? undefined : { kind: 'overlay', id: overlay.id }
}

export const placeComponent = (
  draft: WholeFilmDraft,
  item: CatalogItem,
  placing: Placing,
): EditResult => {
  const lane = placing.via === 'drop' ? placing.lane : clickLane(item)
  const timeMs = placing.via === 'drop' ? placing.timeMs : placing.playheadMs
  if (lane === 'music') return refuse('drop-elsewhere')
  const duration = durationMsOf(item)
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

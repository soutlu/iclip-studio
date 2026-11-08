import type {
  WholeFilmCaptionEdit,
  WholeFilmComponentClip,
  WholeFilmDocument,
  WholeFilmOverlay,
  WholeFilmVideoClip,
} from '@/shared/api/generated/types.gen'
import { DEFAULT_TIMELINE_MIN_DURATION } from '../vendor/hyperframes-studio/player/components/timelineGroupEditing'

export type WholeFilmDraft = WholeFilmDocument
export type VideoClip = WholeFilmVideoClip
export type ComponentClip = WholeFilmComponentClip
export type Layer0Clip = VideoClip | ComponentClip
export type CaptionEdit = WholeFilmCaptionEdit
export type OverlayClip = WholeFilmOverlay
export type ComponentVariables = ComponentClip['variables']

export const MIN_CLIP_MS = Math.round(DEFAULT_TIMELINE_MIN_DURATION * 1000)
export const MAX_FILM_MS = 120_000
export const MAX_VOLUME = 3.981072
export const MAX_OFFSET = 4096

export const toOffset = (value: number): number =>
  Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, Math.round(value))) + 0

export const MIN_SCALE = 0.1
export const MAX_SCALE = 10

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

export const normalizeDegrees = (value: number): number => {
  if (value > -180 && value <= 180) return value + 0
  const turned = ((value % 360) + 360) % 360
  return turned > 180 ? turned - 360 : turned
}

export type TransformArgs = { scale: number; rotation: number; pivot: { x: number; y: number } }

type Transform = Pick<OverlayClip, 'scale' | 'rotation' | 'pivotX' | 'pivotY'>

export const transformed = (current: Transform, args: TransformArgs): Transform | undefined => {
  const scale = clampScale(args.scale)
  const rotation = normalizeDegrees(args.rotation)
  const from = { scale: current.scale ?? 1, rotation: current.rotation ?? 0 }
  if (scale === from.scale && rotation === from.rotation) return undefined
  const identity = from.scale === 1 && from.rotation === 0
  return {
    scale,
    rotation,
    pivotX: identity ? toOffset(args.pivot.x) : (current.pivotX ?? 0),
    pivotY: identity ? toOffset(args.pivot.y) : (current.pivotY ?? 0),
  }
}

export const DEFAULT_CAPTION_COMPONENT = 'default-caption'

export const emptyDraft = (): WholeFilmDraft => ({
  canvas: null,
  layer0: [],
  captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [] },
  music: null,
  overlays: [],
})

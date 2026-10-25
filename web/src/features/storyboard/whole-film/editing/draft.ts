import type {
  WholeFilmCaptionEdit,
  WholeFilmComponentClip,
  WholeFilmDocument,
  WholeFilmOverlay,
  WholeFilmVideoClip,
} from '@/shared/api/generated/types.gen'
import { DEFAULT_TIMELINE_MIN_DURATION } from '../vendor/hyperframes-studio/player/components/timelineGroupEditing'

// 成片草稿的形状以合同为准（contract/openapi.json 的 WholeFilmDocument），时间都是整数毫秒。

export type WholeFilmDraft = WholeFilmDocument
export type VideoClip = WholeFilmVideoClip
export type ComponentClip = WholeFilmComponentClip
export type Layer0Clip = VideoClip | ComponentClip
export type CaptionEdit = WholeFilmCaptionEdit
export type OverlayClip = WholeFilmOverlay
export type ComponentVariables = ComponentClip['variables']

/** 每种片段的最短时长，取 Studio 的默认值（0.1 秒） */
export const MIN_CLIP_MS = Math.round(DEFAULT_TIMELINE_MIN_DURATION * 1000)
/** 成片总长上限；特效块也不能在这之后结束 */
export const MAX_FILM_MS = 120_000
/** 音量上限 +12 dB，同 HyperFrames 的 audioGain */
export const MAX_VOLUME = 3.981072
/** 特效块、字幕在画面上挪开的位置上限（画面像素，正负都是），同服务端的画布边长上限 */
export const MAX_OFFSET = 4096

/** 画面上的位置记成整数像素，裁在 ±{@link MAX_OFFSET} 以内；`+ 0` 把 -0 记成 0 */
export const toOffset = (value: number): number =>
  Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, Math.round(value))) + 0

/** 特效块、字幕等比缩放的倍数范围（10%–1000%），同服务端 */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 10

/** 缩放倍数裁在 {@link MIN_SCALE}–{@link MAX_SCALE} 以内 */
const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

/** 角度（顺时针）规整到 (-180, 180]，同服务端：-180 记成 180 */
const normalizeDegrees = (value: number): number => {
  // 先折进 [0, 360)：取余后加 360 再取余，结果总是正数，不会出现 -0
  const turned = ((value % 360) + 360) % 360
  return turned > 180 ? turned - 360 : turned
}

/** 缩放、旋转一块的参数：倍数、顺时针角度，与第一次变换时取的转轴（画面像素） */
export type TransformArgs = { scale: number; rotation: number; pivot: { x: number; y: number } }

type Transform = Pick<OverlayClip, 'scale' | 'rotation' | 'pivotX' | 'pivotY'>

/**
 * 特效块、字幕缩放旋转之后的这几项：倍数裁在 10%–1000%，角度规整到 (-180, 180]；转轴只在还没记过
 * 时取 `pivot`（取整、裁法同位置），之后沿用，再转、再缩画面不跳。倍数与角度都没变时为 undefined，
 * 转轴也不记。有这几个字段之前存的草稿没写，按原大、不转算。
 */
export const transformed = (current: Transform, args: TransformArgs): Transform | undefined => {
  const scale = clampScale(args.scale)
  const rotation = normalizeDegrees(args.rotation)
  if (scale === (current.scale ?? 1) && rotation === (current.rotation ?? 0)) return undefined
  return {
    scale,
    rotation,
    pivotX: current.pivotX ?? toOffset(args.pivot.x),
    pivotY: current.pivotY ?? toOffset(args.pivot.y),
  }
}

/** 新草稿的字幕样式：组件目录里的产品默认字幕（白字黑边） */
export const DEFAULT_CAPTION_COMPONENT = 'default-caption'

export const emptyDraft = (): WholeFilmDraft => ({
  canvas: null,
  layer0: [],
  captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [] },
  music: null,
  overlays: [],
})

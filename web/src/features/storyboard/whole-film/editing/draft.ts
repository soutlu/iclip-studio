import type {
  WholeFilmCaptionEdit,
  WholeFilmComponentClip,
  WholeFilmDocument,
  WholeFilmOverlay,
  WholeFilmVideoClip,
} from '@/shared/api/generated/types.gen'
import { DEFAULT_TIMELINE_MIN_DURATION } from '../vendor/hyperframes-studio/player/components/timelineGroupEditing'

// 整片草稿的形状以合同为准（contract/openapi.json 的 WholeFilmDocument），时间都是整数毫秒。

export type WholeFilmDraft = WholeFilmDocument
export type VideoClip = WholeFilmVideoClip
export type ComponentClip = WholeFilmComponentClip
export type Layer0Clip = VideoClip | ComponentClip
export type CaptionEdit = WholeFilmCaptionEdit
export type OverlayClip = WholeFilmOverlay
export type ComponentVariables = ComponentClip['variables']

/** 每种片段的最短时长，取 Studio 的默认值（0.1 秒） */
export const MIN_CLIP_MS = Math.round(DEFAULT_TIMELINE_MIN_DURATION * 1000)
/** 整片总长上限；特效块也不能在这之后结束 */
export const MAX_FILM_MS = 120_000
/** 音量上限 +12 dB，同 HyperFrames 的 audioGain */
export const MAX_VOLUME = 3.981072
/** 特效块、字幕在画面上挪开的位置上限（画面像素，正负都是），同服务端的画布边长上限 */
export const MAX_OFFSET = 4096

/** 画面上的位置记成整数像素，裁在 ±{@link MAX_OFFSET} 以内；`+ 0` 把 -0 记成 0 */
export const toOffset = (value: number): number =>
  Math.min(MAX_OFFSET, Math.max(-MAX_OFFSET, Math.round(value))) + 0

/** 新草稿的字幕样式：组件目录里的产品默认字幕（白字黑边） */
export const DEFAULT_CAPTION_COMPONENT = 'default-caption'

export const emptyDraft = (): WholeFilmDraft => ({
  canvas: null,
  layer0: [],
  captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [] },
  music: null,
  overlays: [],
})

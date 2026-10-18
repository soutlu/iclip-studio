import type {
  WholeFilmCaptionEdit,
  WholeFilmComponentClip,
  WholeFilmDocument,
  WholeFilmOverlay,
  WholeFilmTransition,
  WholeFilmVideoClip,
} from '@/shared/api/generated/types.gen'
import { DEFAULT_TIMELINE_MIN_DURATION } from '../vendor/hyperframes-studio/player/components/timelineGroupEditing'

// 整片草稿的形状以合同为准（contract/openapi.json 的 WholeFilmDocument），时间都是整数毫秒。

export type WholeFilmDraft = WholeFilmDocument
export type VideoClip = WholeFilmVideoClip
export type ComponentClip = WholeFilmComponentClip
export type Layer0Clip = VideoClip | ComponentClip
export type TransitionClip = WholeFilmTransition
export type CaptionEdit = WholeFilmCaptionEdit
export type OverlayClip = WholeFilmOverlay
export type ComponentVariables = ComponentClip['variables']
export type EndCardRole = ComponentClip['role']

/** 每种片段的最短时长，取 Studio 的默认值（0.1 秒） */
export const MIN_CLIP_MS = Math.round(DEFAULT_TIMELINE_MIN_DURATION * 1000)
/** 整片总长上限，含片头片尾 */
export const MAX_FILM_MS = 120_000
export const MAX_VIDEO_CLIPS = 100
export const DEFAULT_END_CARD_MS = 2_000
export const MAX_VOLUME = 2
/** 新草稿的字幕样式：组件目录里的产品默认字幕（白字黑边） */
export const DEFAULT_CAPTION_COMPONENT = 'default-caption'

export const emptyDraft = (): WholeFilmDraft => ({
  canvas: null,
  layer0: [],
  transitions: [],
  captions: { component: DEFAULT_CAPTION_COMPONENT, edits: [] },
  music: null,
  overlays: [],
})

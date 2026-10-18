import {
  resolveTimelineMove,
  resolveTimelineResize,
} from '../vendor/hyperframes-studio/player/components/timelineEditing'
import { transitionWindow } from '../composition/build'
import { resolveAllTrackGaps } from '../vendor/hyperframes-studio/player/components/timelineGaps'
import type { EditContext, MusicMedia, SourceMedia } from './context'
import {
  MIN_CLIP_MS,
  type ComponentClip,
  type EndCardRole,
  type Layer0Clip,
  type OverlayClip,
  type TransitionClip,
  type VideoClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/** 整片时长：第 0 层各段时长之和 */
export const filmDuration = (draft: Pick<WholeFilmDraft, 'layer0'>): number =>
  draft.layer0.reduce((sum, clip) => sum + clip.duration, 0)

export const videoClips = (draft: Pick<WholeFilmDraft, 'layer0'>): VideoClip[] =>
  draft.layer0.filter((clip): clip is VideoClip => clip.type === 'video')

export const endCard = (
  draft: Pick<WholeFilmDraft, 'layer0'>,
  role: EndCardRole,
): ComponentClip | undefined =>
  draft.layer0.find(
    (clip): clip is ComponentClip => clip.type === 'component' && clip.role === role,
  )

export type Cut = {
  afterClipId: string
  beforeClipId: string
  timeMs: number
  transition: TransitionClip | null
}

/** 第 0 层相邻两段之间的切点，按时间先后 */
export const cutsOf = (draft: Pick<WholeFilmDraft, 'layer0' | 'transitions'>): Cut[] => {
  const cuts: Cut[] = []
  draft.layer0.forEach((clip, index) => {
    const next = draft.layer0[index + 1]
    if (!next) return
    cuts.push({
      afterClipId: clip.id,
      beforeClipId: next.id,
      timeMs: next.start,
      transition: draft.transitions.find((t) => t.afterClipId === clip.id) ?? null,
    })
  })
  return cuts
}

/** 上下文必须带齐草稿引用到的素材；缺了是调用方的错 */
export const sourceOf = (context: EditContext, sourceJobId: string): SourceMedia => {
  const source = context.sources[sourceJobId]
  if (!source) throw new Error(`整片编辑上下文缺少成片 ${sourceJobId}`)
  return source
}

export const musicOf = (context: EditContext, jobId: string): MusicMedia => {
  const music = context.music[jobId]
  if (!music) throw new Error(`整片编辑上下文缺少音乐 ${jobId}`)
  return music
}

/** 新片段的 id：同前缀里最大的序号加一，同一份草稿总得到同一个结果 */
export const nextId = (draft: WholeFilmDraft, prefix: 'v' | 'c' | 't' | 'o'): string => {
  let max = 0
  for (const { id } of [...draft.layer0, ...draft.transitions, ...draft.overlays]) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${prefix}${max + 1}`
}

// Studio 的时间函数只有常量带单位（秒、厘秒取整），这里按毫秒调用：pixelsPerSecond = 1、clientX
// 即毫秒增量，最短时长显式传 MIN_CLIP_MS。这样取整落在 0.01 毫秒上，不会把不在厘秒网格上的
// 毫秒值拉偏；结果再取整数毫秒。
const MS_GESTURE = { originClientX: 0, pixelsPerSecond: 1 } as const

type ResizeClip = { start: number; duration: number; playbackStart?: number }

export const resizeMs = (
  clip: ResizeClip,
  edge: 'start' | 'end',
  deltaMs: number,
  bounds: { minStart: number; maxEnd: number },
): ResizeClip => {
  const next = resolveTimelineResize(
    { ...clip, ...MS_GESTURE, ...bounds, minDuration: MIN_CLIP_MS },
    edge,
    deltaMs,
  )
  return {
    start: Math.round(next.start),
    duration: Math.round(next.duration),
    ...(next.playbackStart === undefined ? {} : { playbackStart: Math.round(next.playbackStart) }),
  }
}

export const moveStartMs = (
  clip: { start: number; duration: number },
  deltaMs: number,
  bounds: { minStart: number; maxStart: number },
): number =>
  Math.round(
    resolveTimelineMove(
      { ...clip, ...MS_GESTURE, ...bounds, track: 0, originRow: 0, trackOrder: [0] },
      deltaMs,
      0,
    ).start,
  )

/**
 * 把片段放到第 0 层的 index 处，后面的片段整体后移它的时长（波纹），保持开始时间按数组顺序递增，
 * 交给 compactLayer0 收紧。
 */
export const insertAt = (layer0: Layer0Clip[], index: number, clip: Layer0Clip): Layer0Clip[] => {
  const last = layer0.at(-1)
  const at = layer0[index]?.start ?? (last ? last.start + last.duration : 0)
  return [
    ...layer0.slice(0, index),
    { ...clip, start: at },
    ...layer0.slice(index).map((c) => ({ ...c, start: c.start + clip.duration })),
  ]
}

/**
 * 第 0 层始终从 0 起首尾相接：用 Studio 的整轨压实收紧。Studio 按开始时间排序，所以要求各操作
 * 保持开始时间按数组顺序严格递增；违反即编程错误。
 */
const compactLayer0 = (layer0: Layer0Clip[]): Layer0Clip[] => {
  layer0.forEach((clip, index) => {
    const previous = layer0[index - 1]
    if (previous && !(clip.start > previous.start)) {
      throw new Error('第 0 层片段的开始时间没有按顺序递增')
    }
  })
  const shifts = new Map(resolveAllTrackGaps(layer0).map((s) => [s.key, Math.round(s.newStart)]))
  return layer0.map((clip) => {
    const start = shifts.get(clip.id)
    return start === undefined ? clip : { ...clip, start }
  })
}

/** 转场跟着 afterClipId 那一段；那一段没了或成了最后一段（切点没了）就去掉 */
const keepCutTransitions = (
  layer0: Layer0Clip[],
  transitions: TransitionClip[],
): TransitionClip[] => {
  const kept: TransitionClip[] = []
  for (const transition of transitions) {
    const index = layer0.findIndex((clip) => clip.id === transition.afterClipId)
    if (index < 0 || index === layer0.length - 1) continue
    if (kept.some((t) => t.afterClipId === transition.afterClipId)) continue
    kept.push(transition)
  }
  return kept
}

/**
 * 每个转场都落在切点前后两段之内（规则同合成构建的 `transitionWindow`）；目录里没有的转场不查。
 * 第 0 层的改动让哪个转场放不下，这次改动就被拒。
 */
export const checkTransitions = (draft: WholeFilmDraft, context: EditContext): EditResult => {
  for (const transition of draft.transitions) {
    const spec = context.transitions[transition.component]
    if (spec === undefined) continue
    const window = transitionWindow(draft, transition, {
      cutAt: spec.cutAt,
      durationMs: transition.duration,
    })
    if (window?.fits !== true) return refuse('transition-does-not-fit')
  }
  return done(draft)
}

/** 包装不跟随第 0 层；整片变短时截到片尾，剩不到最短时长的去掉 */
const fitOverlays = (overlays: OverlayClip[], total: number): OverlayClip[] =>
  [...overlays]
    .sort((a, b) => a.start - b.start)
    .filter((overlay) => overlay.start + MIN_CLIP_MS <= total)
    .map((overlay) =>
      overlay.start + overlay.duration > total
        ? { ...overlay, duration: total - overlay.start }
        : overlay,
    )

/**
 * 每次改动后的收紧：第 0 层压实，转场、包装按新的第 0 层修正；没有视频段时画布清空。
 * 画布在第一段视频加入时定下，之后不随调序、删段改变。
 */
export const normalize = (draft: WholeFilmDraft): WholeFilmDraft => {
  const layer0 = compactLayer0(draft.layer0)
  return {
    ...draft,
    canvas: layer0.some((clip) => clip.type === 'video') ? draft.canvas : null,
    layer0,
    transitions: keepCutTransitions(layer0, draft.transitions),
    overlays: fitOverlays(draft.overlays, filmDuration({ layer0 })),
  }
}

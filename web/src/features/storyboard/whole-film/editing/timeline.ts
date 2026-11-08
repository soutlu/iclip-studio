import {
  resolveTimelineMove,
  resolveTimelineResize,
} from '../vendor/hyperframes-studio/player/components/timelineEditing'
import { resolveAllTrackGaps } from '../vendor/hyperframes-studio/player/components/timelineGaps'
import type { EditContext, MusicMedia, SourceMedia } from './context'
import { MIN_CLIP_MS, type Layer0Clip, type WholeFilmDraft } from './draft'

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export const layer0End = (draft: Pick<WholeFilmDraft, 'layer0'>): number =>
  draft.layer0.reduce((sum, clip) => sum + clip.duration, 0)

export const filmDuration = (draft: Pick<WholeFilmDraft, 'layer0' | 'overlays'>): number =>
  Math.max(layer0End(draft), ...draft.overlays.map((overlay) => overlay.start + overlay.duration))

export type Cut = { afterClipId: string; beforeClipId: string; timeMs: number }

export const cutsOf = (draft: Pick<WholeFilmDraft, 'layer0'>): Cut[] => {
  const cuts: Cut[] = []
  draft.layer0.forEach((clip, index) => {
    const next = draft.layer0[index + 1]
    if (next) cuts.push({ afterClipId: clip.id, beforeClipId: next.id, timeMs: next.start })
  })
  return cuts
}

export const insertIndexAt = (layer0: readonly Layer0Clip[], timeMs: number): number => {
  const index = layer0.findIndex((clip) => clip.start + clip.duration / 2 > timeMs)
  return index < 0 ? layer0.length : index
}

export const sourceOf = (context: EditContext, sourceJobId: string): SourceMedia => {
  const source = context.sources[sourceJobId]
  if (!source) throw new Error(`成片编辑上下文缺少素材片 ${sourceJobId}`)
  return source
}

export const musicOf = (context: EditContext, jobId: string): MusicMedia => {
  const music = context.music[jobId]
  if (!music) throw new Error(`成片编辑上下文缺少音乐 ${jobId}`)
  return music
}

export const componentMsOf = (context: EditContext, component: string): number => {
  const durationMs = context.components[component]
  if (durationMs === undefined) throw new Error(`成片编辑上下文缺少组件 ${component}`)
  return durationMs
}

export const nextId = (draft: WholeFilmDraft, prefix: 'v' | 'c' | 'o', offset = 0): string => {
  let max = 0
  for (const { id } of [...draft.layer0, ...draft.overlays]) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${prefix}${max + 1 + offset}`
}

const MS_GESTURE = { originClientX: 0, pixelsPerSecond: 1 } as const

type ResizeClip = { start: number; duration: number; playbackStart: number }

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
    playbackStart: Math.round(next.playbackStart ?? clip.playbackStart),
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

export const insertAt = (layer0: Layer0Clip[], index: number, clip: Layer0Clip): Layer0Clip[] => {
  const last = layer0.at(-1)
  const at = layer0[index]?.start ?? (last ? last.start + last.duration : 0)
  return [
    ...layer0.slice(0, index),
    { ...clip, start: at },
    ...layer0.slice(index).map((c) => ({ ...c, start: c.start + clip.duration })),
  ]
}

const compactLayer0 = (layer0: Layer0Clip[]): Layer0Clip[] => {
  layer0.forEach((clip, index) => {
    const previous = layer0[index - 1]
    if (previous && !(clip.start > previous.start)) {
      throw new Error('第 0 层片段的开始时间没有按顺序递增')
    }
  })
  const lane = layer0.map((clip) => ({ ...clip, track: 0 }))
  const shifts = new Map(resolveAllTrackGaps(lane).map((s) => [s.key, Math.round(s.newStart)]))
  return layer0.map((clip) => {
    const start = shifts.get(clip.id)
    return start === undefined ? clip : { ...clip, start }
  })
}

export const normalize = (draft: WholeFilmDraft): WholeFilmDraft => {
  const layer0 = compactLayer0(draft.layer0)
  return {
    ...draft,
    canvas: layer0.some((clip) => clip.type === 'video') ? draft.canvas : null,
    layer0,
  }
}

import {
  resolveTimelineMove,
  resolveTimelineResize,
} from '../vendor/hyperframes-studio/player/components/timelineEditing'
import { resolveAllTrackGaps } from '../vendor/hyperframes-studio/player/components/timelineGaps'
import type { EditContext, MusicMedia, SourceMedia } from './context'
import { MIN_CLIP_MS, type Layer0Clip, type WholeFilmDraft } from './draft'

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/** 成片轨（第 0 层）的结尾：各段时长之和 */
export const layer0End = (draft: Pick<WholeFilmDraft, 'layer0'>): number =>
  draft.layer0.reduce((sum, clip) => sum + clip.duration, 0)

/**
 * 整片时长：同 HyperFrames，所有轨上内容的最远结束，即成片轨的结尾与特效块最晚的结尾里大的那个；
 * 特效块超出成片轨的部分叠在空画面上照样渲染，音乐也铺到这里。
 */
export const filmDuration = (draft: Pick<WholeFilmDraft, 'layer0' | 'overlays'>): number =>
  Math.max(layer0End(draft), ...draft.overlays.map((overlay) => overlay.start + overlay.duration))

export type Cut = { afterClipId: string; beforeClipId: string; timeMs: number }

/** 第 0 层相邻两段之间的切点，按时间先后 */
export const cutsOf = (draft: Pick<WholeFilmDraft, 'layer0'>): Cut[] => {
  const cuts: Cut[] = []
  draft.layer0.forEach((clip, index) => {
    const next = draft.layer0[index + 1]
    if (next) cuts.push({ afterClipId: clip.id, beforeClipId: next.id, timeMs: next.start })
  })
  return cuts
}

/**
 * 离 timeMs 最近的插入点（插在返回的那一段之前；等于段数时插到最后）：落在哪段的中点之前就插在
 * 那段前面，所以只会插在切点或两端，不会把段拆开。
 */
export const insertIndexAt = (layer0: readonly Layer0Clip[], timeMs: number): number => {
  const index = layer0.findIndex((clip) => clip.start + clip.duration / 2 > timeMs)
  return index < 0 ? layer0.length : index
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
export const nextId = (draft: WholeFilmDraft, prefix: 'v' | 'c' | 'o'): string => {
  let max = 0
  for (const { id } of [...draft.layer0, ...draft.overlays]) {
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

type ResizeClip = { start: number; duration: number; playbackStart: number }

/** 修剪一端，算法用 Studio 的修剪：修开头时入点跟着前后移，入点不小于 0 */
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
  const lane = layer0.map((clip) => ({ ...clip, track: 0 }))
  const shifts = new Map(resolveAllTrackGaps(lane).map((s) => [s.key, Math.round(s.newStart)]))
  return layer0.map((clip) => {
    const start = shifts.get(clip.id)
    return start === undefined ? clip : { ...clip, start }
  })
}

/**
 * 第 0 层每次改动后的收紧：整轨压实；没有视频段时画布清空。特效块不跟随第 0 层。
 * 画布在第一段视频加入时定下，之后不随调序、删段改变。
 */
export const normalize = (draft: WholeFilmDraft): WholeFilmDraft => {
  const layer0 = compactLayer0(draft.layer0)
  return {
    ...draft,
    canvas: layer0.some((clip) => clip.type === 'video') ? draft.canvas : null,
    layer0,
  }
}

import { contiguousRange } from '../../editing/range-select'
import type { EditContext } from './context'
import {
  MAX_FILM_MS,
  MAX_VOLUME,
  MIN_CLIP_MS,
  type ComponentClip,
  type ComponentVariables,
  type Layer0Clip,
  type VideoClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import {
  clamp,
  componentMsOf,
  insertAt,
  insertIndexAt,
  layer0End,
  nextId,
  normalize,
  resizeMs,
  sourceOf,
} from './timeline'

// 第 0 层（画面轨）是视频段与组件段的同一个列表，先后不限，始终从 0 起首尾相接。

const replaceClip = (draft: WholeFilmDraft, clip: Layer0Clip): WholeFilmDraft => ({
  ...draft,
  layer0: draft.layer0.map((c) => (c.id === clip.id ? clip : c)),
})

/** 插到第 index 段之前（等于段数时插到最后），或插到离 timeMs 最近的切点 */
export type InsertAt = { index: number } | { timeMs: number }

const indexAt = (draft: WholeFilmDraft, at: InsertAt) =>
  'index' in at ? clamp(at.index, 0, draft.layer0.length) : insertIndexAt(draft.layer0, at.timeMs)

/** 把几段按先后连着插到第 index 段之前，后面的段整体后移 */
const insertAllAt = (layer0: Layer0Clip[], index: number, clips: readonly Layer0Clip[]) =>
  clips.reduce((lane, clip, offset) => insertAt(lane, index + offset, clip), layer0)

/** 按先后连着放进第 0 层，后面的段整体后移；成片超过总长上限时拒绝，不缩短 */
const insertClips = (
  draft: WholeFilmDraft,
  clips: readonly Layer0Clip[],
  at: InsertAt,
): EditResult => {
  if (clips.some((clip) => clip.duration < MIN_CLIP_MS)) return refuse('too-short')
  const added = clips.reduce((sum, clip) => sum + clip.duration, 0)
  // 特效块本来就不晚于上限结束，画面轨不超过上限，成片也就不超过
  if (layer0End(draft) + added > MAX_FILM_MS) return refuse('film-too-long')
  return done(normalize({ ...draft, layer0: insertAllAt(draft.layer0, indexAt(draft, at), clips) }))
}

/** 素材里的一段：从素材的 playbackStart 起放 duration（毫秒） */
export type MaterialPiece = { playbackStart: number; duration: number }

/** 把同一条素材里的几段按先后连着加入成片，每段成为画面轨上的一段；第一段视频定下画布尺寸 */
export const insertMaterial = (
  draft: WholeFilmDraft,
  args: { sourceJobId: string; pieces: readonly MaterialPiece[]; at: InsertAt },
  context: EditContext,
): EditResult => {
  const source = context.sources[args.sourceJobId]
  if (!source) return refuse('unknown-source')
  const outside = args.pieces.some(
    (piece) => piece.playbackStart < 0 || piece.playbackStart + piece.duration > source.durationMs,
  )
  if (outside) return refuse('outside-source')
  const clips = args.pieces.map((piece, offset): VideoClip => ({
    id: nextId(draft, 'v', offset),
    type: 'video',
    start: 0,
    duration: piece.duration,
    playbackStart: piece.playbackStart,
    sourceJobId: args.sourceJobId,
    volume: 1,
  }))
  return insertClips(
    { ...draft, canvas: draft.canvas ?? { width: source.width, height: source.height } },
    clips,
    args.at,
  )
}

/**
 * 把组件作为一段放进画面轨，与视频段同等占时间。variables 是写进草稿的可填项，没写的项合成时取
 * 组件自己的默认值。
 */
export const insertComponent = (
  draft: WholeFilmDraft,
  args: { component: string; duration: number; variables: ComponentVariables; at: InsertAt },
): EditResult => {
  const clip: ComponentClip = {
    id: nextId(draft, 'c'),
    type: 'component',
    start: 0,
    duration: args.duration,
    playbackStart: 0,
    component: args.component,
    variables: args.variables,
  }
  return insertClips(draft, [clip], args.at)
}

/** 第 0 层里有没有这几段 */
const hasAll = (draft: WholeFilmDraft, clipIds: readonly string[]) =>
  clipIds.every((id) => draft.layer0.some((clip) => clip.id === id))

/**
 * 调整连着的几段（按画面轨先后给 id）的顺序，当成一整块挪到第 `to` 个插入点，即挪动前的第 `to`
 * 段之前，等于段数时挪到最后（拖动时由 {@link insertIndexAt} 按松手处算出）。落点就在这一块里或
 * 紧挨它两侧时原样返回；这几段不相连时拒绝。
 */
export const moveClips = (
  draft: WholeFilmDraft,
  args: { clipIds: readonly string[]; to: number },
): EditResult => {
  if (args.clipIds.length === 0 || !hasAll(draft, args.clipIds)) return refuse('unknown-clip')
  const range = contiguousRange(
    draft.layer0.map((clip) => clip.id),
    args.clipIds,
  )
  if (range === undefined) return refuse('not-contiguous')
  const to = clamp(args.to, 0, draft.layer0.length)
  if (to >= range.from && to <= range.to + 1) return done(draft)
  const block = draft.layer0.slice(range.from, range.to + 1)
  const others = draft.layer0.filter((clip) => !block.includes(clip))
  const at = to > range.to ? to - block.length : to
  return done(normalize({ ...draft, layer0: insertAllAt(others, at, block) }))
}

/**
 * 修剪一段的一端，算法用 Studio 的修剪。修开头时切点不动、入点后移（组件段从组件自己时间里更晚处
 * 起播）；之后整轨收紧，后面的段跟着移。视频段不超出素材，组件段不超出组件自己的时长（已经超出的
 * 段拖结尾时收回上限以内），任何一段都不短于最短时长，成片拉长到总长上限就停住。
 */
export const trimClip = (
  draft: WholeFilmDraft,
  args: { clipId: string; edge: 'start' | 'end'; deltaMs: number },
  context: EditContext,
): EditResult => {
  const clip = draft.layer0.find((c) => c.id === args.clipId)
  if (!clip) return refuse('unknown-clip')
  const room = Math.max(0, MAX_FILM_MS - layer0End(draft))
  const timing = { start: clip.start, duration: clip.duration, playbackStart: clip.playbackStart }
  const trimmed =
    args.edge === 'end'
      ? resizeMs(timing, 'end', args.deltaMs, {
          minStart: clip.start,
          maxEnd:
            clip.start +
            Math.min(
              (clip.type === 'video'
                ? sourceOf(context, clip.sourceJobId).durationMs
                : componentMsOf(context, clip.component)) - clip.playbackStart,
              clip.duration + room,
            ),
        })
      : resizeMs(timing, 'start', args.deltaMs, {
          minStart: clip.start - room,
          maxEnd: clip.start + clip.duration,
        })
  if (trimmed.duration === clip.duration && trimmed.playbackStart === clip.playbackStart) {
    return done(draft)
  }
  return done(
    normalize(
      replaceClip(draft, {
        ...clip,
        duration: trimmed.duration,
        playbackStart: trimmed.playbackStart,
      }),
    ),
  )
}

/** 拆开后两段都不短于最短时长 */
const canSplitAt = (clip: Layer0Clip, timeMs: number) =>
  timeMs >= clip.start + MIN_CLIP_MS && timeMs <= clip.start + clip.duration - MIN_CLIP_MS

/** 在 timeMs 处把一段拆成两段，后半段接着前半段的入点往后播；优先拆 clipId 指定的段，否则拆播放头下的段 */
export const splitClip = (
  draft: WholeFilmDraft,
  args: { timeMs: number; clipId?: string },
): EditResult => {
  const preferred = draft.layer0.find((c) => c.id === args.clipId)
  const target = [preferred, ...draft.layer0].find(
    (clip): clip is Layer0Clip => clip !== undefined && canSplitAt(clip, args.timeMs),
  )
  if (!target) return refuse('nothing-to-split')
  const offset = args.timeMs - target.start
  const tail: Layer0Clip = {
    ...target,
    id: nextId(draft, target.type === 'video' ? 'v' : 'c'),
    start: target.start + offset,
    duration: target.duration - offset,
    playbackStart: target.playbackStart + offset,
  }
  const index = draft.layer0.indexOf(target)
  return done(
    normalize({
      ...draft,
      layer0: [
        ...draft.layer0.slice(0, index),
        { ...target, duration: offset },
        tail,
        ...draft.layer0.slice(index + 1),
      ],
    }),
  )
}

/** 删掉第 0 层的几段，后面的段跟着前移 */
export const deleteClips = (
  draft: WholeFilmDraft,
  args: { clipIds: readonly string[] },
): EditResult => {
  if (args.clipIds.length === 0 || !hasAll(draft, args.clipIds)) return refuse('unknown-clip')
  return done(
    normalize({ ...draft, layer0: draft.layer0.filter((c) => !args.clipIds.includes(c.id)) }),
  )
}

/** 几段视频的原声音量一起设成同一个值，收进 0 到上限；组件段没有原声，跳过；一段视频都没有时拒绝 */
export const setClipsVolume = (
  draft: WholeFilmDraft,
  args: { clipIds: readonly string[]; volume: number },
): EditResult => {
  if (args.clipIds.length === 0 || !hasAll(draft, args.clipIds)) return refuse('unknown-clip')
  const videos = draft.layer0.filter(
    (clip): clip is VideoClip => clip.type === 'video' && args.clipIds.includes(clip.id),
  )
  if (videos.length === 0) return refuse('not-a-video')
  const volume = clamp(args.volume, 0, MAX_VOLUME)
  if (videos.every((clip) => clip.volume === volume)) return done(draft)
  return done({
    ...draft,
    layer0: draft.layer0.map((clip) =>
      clip.type === 'video' && args.clipIds.includes(clip.id) ? { ...clip, volume } : clip,
    ),
  })
}

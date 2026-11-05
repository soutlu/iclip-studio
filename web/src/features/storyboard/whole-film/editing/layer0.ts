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

const replaceClip = (draft: WholeFilmDraft, clip: Layer0Clip): WholeFilmDraft => ({
  ...draft,
  layer0: draft.layer0.map((c) => (c.id === clip.id ? clip : c)),
})

export type InsertAt = { index: number } | { timeMs: number }

const indexAt = (draft: WholeFilmDraft, at: InsertAt) =>
  'index' in at ? clamp(at.index, 0, draft.layer0.length) : insertIndexAt(draft.layer0, at.timeMs)

const insertAllAt = (layer0: Layer0Clip[], index: number, clips: readonly Layer0Clip[]) =>
  clips.reduce((lane, clip, offset) => insertAt(lane, index + offset, clip), layer0)

const insertClips = (
  draft: WholeFilmDraft,
  clips: readonly Layer0Clip[],
  at: InsertAt,
): EditResult => {
  if (clips.some((clip) => clip.duration < MIN_CLIP_MS)) return refuse('too-short')
  const added = clips.reduce((sum, clip) => sum + clip.duration, 0)
  if (layer0End(draft) + added > MAX_FILM_MS) return refuse('film-too-long')
  return done(normalize({ ...draft, layer0: insertAllAt(draft.layer0, indexAt(draft, at), clips) }))
}

export type MaterialPiece = { playbackStart: number; duration: number }

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

const hasAll = (draft: WholeFilmDraft, clipIds: readonly string[]) =>
  clipIds.every((id) => draft.layer0.some((clip) => clip.id === id))

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

const canSplitAt = (clip: Layer0Clip, timeMs: number) =>
  timeMs >= clip.start + MIN_CLIP_MS && timeMs <= clip.start + clip.duration - MIN_CLIP_MS

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

export const deleteClips = (
  draft: WholeFilmDraft,
  args: { clipIds: readonly string[] },
): EditResult => {
  if (args.clipIds.length === 0 || !hasAll(draft, args.clipIds)) return refuse('unknown-clip')
  return done(
    normalize({ ...draft, layer0: draft.layer0.filter((c) => !args.clipIds.includes(c.id)) }),
  )
}

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

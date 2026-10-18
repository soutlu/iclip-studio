import type { EditContext } from './context'
import {
  MAX_FILM_MS,
  MAX_VIDEO_CLIPS,
  MAX_VOLUME,
  MIN_CLIP_MS,
  type Layer0Clip,
  type VideoClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import {
  checkTransitions,
  clamp,
  endCard,
  filmDuration,
  insertAt,
  moveStartMs,
  nextId,
  normalize,
  resizeMs,
  sourceOf,
  videoClips,
} from './timeline'

/** 视频段在第 0 层里可放的下标范围：片头之后、片尾之前 */
const videoSlots = (draft: WholeFilmDraft) => {
  const first = endCard(draft, 'intro') ? 1 : 0
  const last = draft.layer0.length - (endCard(draft, 'outro') ? 1 : 0)
  return { first, last }
}

const replaceClip = (draft: WholeFilmDraft, clip: Layer0Clip): WholeFilmDraft => ({
  ...draft,
  layer0: draft.layer0.map((c) => (c.id === clip.id ? clip : c)),
})

const splitInDraft = (draft: WholeFilmDraft, clip: VideoClip, offsetMs: number) => {
  const tail: VideoClip = {
    ...clip,
    id: nextId(draft, 'v'),
    start: clip.start + offsetMs,
    duration: clip.duration - offsetMs,
    playbackStart: clip.playbackStart + offsetMs,
  }
  const index = draft.layer0.indexOf(clip)
  return {
    tailIndex: index + 1,
    draft: {
      ...draft,
      layer0: [
        ...draft.layer0.slice(0, index),
        { ...clip, duration: offsetMs },
        tail,
        ...draft.layer0.slice(index + 1),
      ],
      // 原段后面的切点现在在后半段后面
      transitions: draft.transitions.map((t) =>
        t.afterClipId === clip.id ? { ...t, afterClipId: tail.id } : t,
      ),
    },
  }
}

/** 拆开后两段都不短于最短时长 */
const canSplitAt = (clip: VideoClip, timeMs: number) =>
  timeMs >= clip.start + MIN_CLIP_MS && timeMs <= clip.start + clip.duration - MIN_CLIP_MS

export type InsertAt = { videoIndex: number } | { timeMs: number }

/**
 * 把一段素材加入成片：按视频段序号插入，或插到播放头处（播放头在段中间时先拆开这段）。
 * 插入点总在片头之后、片尾之前。
 */
export const insertMaterial = (
  draft: WholeFilmDraft,
  args: { sourceJobId: string; playbackStart: number; duration: number; at: InsertAt },
  context: EditContext,
): EditResult => {
  const source = context.sources[args.sourceJobId]
  if (!source) return refuse('unknown-source')
  if (args.duration < MIN_CLIP_MS) return refuse('too-short')
  if (args.playbackStart < 0 || args.playbackStart + args.duration > source.durationMs) {
    return refuse('outside-source')
  }
  if (filmDuration(draft) + args.duration > MAX_FILM_MS) return refuse('film-too-long')

  let base = draft
  let index: number
  const { first, last } = videoSlots(draft)
  if ('videoIndex' in args.at) {
    index = clamp(first + args.at.videoIndex, first, last)
  } else {
    const { timeMs } = args.at
    const under = draft.layer0.find((c) => timeMs >= c.start && timeMs < c.start + c.duration)
    if (under?.type === 'video' && canSplitAt(under, timeMs)) {
      const split = splitInDraft(draft, under, timeMs - under.start)
      base = split.draft
      index = split.tailIndex
    } else if (under?.type === 'video') {
      const atStart = timeMs - under.start < under.start + under.duration - timeMs
      index = draft.layer0.indexOf(under) + (atStart ? 0 : 1)
    } else {
      index = under?.type === 'component' && under.role === 'intro' ? first : last
    }
  }
  if (videoClips(base).length + 1 > MAX_VIDEO_CLIPS) return refuse('too-many-clips')

  const clip: VideoClip = {
    id: nextId(base, 'v'),
    type: 'video',
    start: 0,
    duration: args.duration,
    playbackStart: args.playbackStart,
    sourceJobId: args.sourceJobId,
    volume: 1,
  }
  return checkTransitions(
    normalize({
      ...base,
      canvas: base.canvas ?? { width: source.width, height: source.height },
      layer0: insertAt(base.layer0, index, clip),
    }),
    context,
  )
}

/** 拖动一段视频调整顺序：按 Studio 的拖动换算出落点，越过哪段的中点就排到它的哪一侧 */
export const moveClip = (
  draft: WholeFilmDraft,
  args: { clipId: string; deltaMs: number },
  context: EditContext,
): EditResult => {
  const clip = draft.layer0.find((c) => c.id === args.clipId)
  if (!clip) return refuse('unknown-clip')
  if (clip.type !== 'video') return refuse('not-a-video')
  const intro = endCard(draft, 'intro')
  const outro = endCard(draft, 'outro')
  const start = moveStartMs(clip, args.deltaMs, {
    minStart: intro ? intro.duration : 0,
    maxStart: (outro ? outro.start : filmDuration(draft)) - clip.duration,
  })
  const center = start + clip.duration / 2
  const videos = videoClips(draft)
  const videoIndex = videos.filter(
    (other) => other.id !== clip.id && other.start + other.duration / 2 < center,
  ).length
  if (videoIndex === videos.indexOf(clip)) return done(draft)
  const without = draft.layer0.filter((c) => c.id !== clip.id)
  return checkTransitions(
    normalize({ ...draft, layer0: insertAt(without, (intro ? 1 : 0) + videoIndex, clip) }),
    context,
  )
}

/**
 * 修剪一段的一端，算法用 Studio 的修剪。修开头时切点不动、改素材入点；之后整轨收紧，后面的段跟着移。
 * 视频段不超出素材，任何一段都不短于最短时长，整片不超过总长上限；片头只能拖右端，片尾只能拖左端。
 */
export const trimClip = (
  draft: WholeFilmDraft,
  args: { clipId: string; edge: 'start' | 'end'; deltaMs: number },
  context: EditContext,
): EditResult => {
  const clip = draft.layer0.find((c) => c.id === args.clipId)
  if (!clip) return refuse('unknown-clip')
  if (clip.type === 'component' && (clip.role === 'intro') !== (args.edge === 'end')) {
    return refuse('edge-not-editable')
  }
  const room = Math.max(0, MAX_FILM_MS - filmDuration(draft))
  const timing =
    clip.type === 'video'
      ? { start: clip.start, duration: clip.duration, playbackStart: clip.playbackStart }
      : { start: clip.start, duration: clip.duration }
  let trimmed: { duration: number; playbackStart?: number }
  if (args.edge === 'end') {
    const sourceRoom =
      clip.type === 'video'
        ? sourceOf(context, clip.sourceJobId).durationMs - clip.playbackStart
        : Number.POSITIVE_INFINITY
    const maxEnd = clip.start + Math.min(sourceRoom, clip.duration + room)
    trimmed = resizeMs(timing, 'end', args.deltaMs, { minStart: clip.start, maxEnd })
  } else {
    trimmed = resizeMs(timing, 'start', args.deltaMs, {
      minStart: clip.start - room,
      maxEnd: clip.start + clip.duration,
    })
  }
  if (clip.type === 'video') {
    const playbackStart = trimmed.playbackStart ?? clip.playbackStart
    if (trimmed.duration === clip.duration && playbackStart === clip.playbackStart) {
      return done(draft)
    }
    return checkTransitions(
      normalize(replaceClip(draft, { ...clip, duration: trimmed.duration, playbackStart })),
      context,
    )
  }
  if (trimmed.duration === clip.duration) return done(draft)
  return checkTransitions(
    normalize(replaceClip(draft, { ...clip, duration: trimmed.duration })),
    context,
  )
}

/** 在 timeMs 处把视频段拆成两段；优先拆 clipId 指定的段，否则拆播放头下的段 */
export const splitClip = (
  draft: WholeFilmDraft,
  args: { timeMs: number; clipId?: string },
  context: EditContext,
): EditResult => {
  const preferred = draft.layer0.find((c) => c.id === args.clipId)
  const target = [preferred, ...draft.layer0].find(
    (clip): clip is VideoClip => clip?.type === 'video' && canSplitAt(clip, args.timeMs),
  )
  if (!target) return refuse('nothing-to-split')
  if (videoClips(draft).length + 1 > MAX_VIDEO_CLIPS) return refuse('too-many-clips')
  return checkTransitions(
    normalize(splitInDraft(draft, target, args.timeMs - target.start).draft),
    context,
  )
}

/**
 * 删掉第 0 层的一段（视频段、片头或片尾）；挂在它后面的转场一起删。它前面切点上的转场换到新的
 * 切点上，放不下时拒绝。
 */
export const deleteClip = (
  draft: WholeFilmDraft,
  args: { clipId: string },
  context: EditContext,
): EditResult => {
  if (!draft.layer0.some((c) => c.id === args.clipId)) return refuse('unknown-clip')
  return checkTransitions(
    normalize({
      ...draft,
      layer0: draft.layer0.filter((c) => c.id !== args.clipId),
      transitions: draft.transitions.filter((t) => t.afterClipId !== args.clipId),
    }),
    context,
  )
}

/** 一段视频的原声音量，收进 0–2 */
export const setClipVolume = (
  draft: WholeFilmDraft,
  args: { clipId: string; volume: number },
): EditResult => {
  const clip = draft.layer0.find((c) => c.id === args.clipId)
  if (!clip) return refuse('unknown-clip')
  if (clip.type !== 'video') return refuse('not-a-video')
  const volume = clamp(args.volume, 0, MAX_VOLUME)
  return done(volume === clip.volume ? draft : replaceClip(draft, { ...clip, volume }))
}

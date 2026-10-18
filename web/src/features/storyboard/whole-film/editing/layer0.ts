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
  insertAt,
  insertIndexAt,
  layer0End,
  nextId,
  normalize,
  resizeMs,
  sourceOf,
} from './timeline'

// 第 0 层（成片轨）是视频段与组件段的同一个列表，先后不限，始终从 0 起首尾相接。

const replaceClip = (draft: WholeFilmDraft, clip: Layer0Clip): WholeFilmDraft => ({
  ...draft,
  layer0: draft.layer0.map((c) => (c.id === clip.id ? clip : c)),
})

/** 插到第 index 段之前（等于段数时插到最后），或插到离 timeMs 最近的切点 */
export type InsertAt = { index: number } | { timeMs: number }

const indexAt = (draft: WholeFilmDraft, at: InsertAt) =>
  'index' in at ? clamp(at.index, 0, draft.layer0.length) : insertIndexAt(draft.layer0, at.timeMs)

/** 放进第 0 层，后面的段整体后移；整片超过总长上限时拒绝，不缩短 */
const insertClip = (draft: WholeFilmDraft, clip: Layer0Clip, at: InsertAt): EditResult => {
  if (clip.duration < MIN_CLIP_MS) return refuse('too-short')
  // 特效块本来就不晚于上限结束，成片轨不超过上限，整片也就不超过
  if (layer0End(draft) + clip.duration > MAX_FILM_MS) return refuse('film-too-long')
  return done(normalize({ ...draft, layer0: insertAt(draft.layer0, indexAt(draft, at), clip) }))
}

/** 把一段素材加入成片；第一段视频定下画布尺寸 */
export const insertMaterial = (
  draft: WholeFilmDraft,
  args: { sourceJobId: string; playbackStart: number; duration: number; at: InsertAt },
  context: EditContext,
): EditResult => {
  const source = context.sources[args.sourceJobId]
  if (!source) return refuse('unknown-source')
  if (args.playbackStart < 0 || args.playbackStart + args.duration > source.durationMs) {
    return refuse('outside-source')
  }
  const clip: VideoClip = {
    id: nextId(draft, 'v'),
    type: 'video',
    start: 0,
    duration: args.duration,
    playbackStart: args.playbackStart,
    sourceJobId: args.sourceJobId,
    volume: 1,
  }
  return insertClip(
    { ...draft, canvas: draft.canvas ?? { width: source.width, height: source.height } },
    clip,
    args.at,
  )
}

/**
 * 把组件作为一段放进成片轨，与视频段同等占时间。variables 是写进草稿的可填项，没写的项合成时取
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
  return insertClip(draft, clip, args.at)
}

/**
 * 调整一段的顺序：挪到第 `to` 个插入点，即挪动前的第 `to` 段之前，等于段数时挪到最后（拖动时由
 * {@link insertIndexAt} 按松手处算出）。落点就在它自己两侧时原样返回。
 */
export const moveClip = (
  draft: WholeFilmDraft,
  args: { clipId: string; to: number },
): EditResult => {
  const from = draft.layer0.findIndex((c) => c.id === args.clipId)
  const clip = draft.layer0[from]
  if (!clip) return refuse('unknown-clip')
  const to = clamp(args.to, 0, draft.layer0.length)
  if (to === from || to === from + 1) return done(draft)
  const others = draft.layer0.filter((c) => c.id !== clip.id)
  return done(normalize({ ...draft, layer0: insertAt(others, to > from ? to - 1 : to, clip) }))
}

/**
 * 修剪一段的一端，算法用 Studio 的修剪。修开头时切点不动、入点后移（组件段从组件自己时间里更晚处
 * 起播）；之后整轨收紧，后面的段跟着移。视频段不超出素材，任何一段都不短于最短时长，整片拉长到
 * 总长上限就停住。
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
              clip.type === 'video'
                ? sourceOf(context, clip.sourceJobId).durationMs - clip.playbackStart
                : Number.POSITIVE_INFINITY,
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

/** 删掉第 0 层的一段，后面的段跟着前移 */
export const deleteClip = (draft: WholeFilmDraft, args: { clipId: string }): EditResult => {
  if (!draft.layer0.some((c) => c.id === args.clipId)) return refuse('unknown-clip')
  return done(normalize({ ...draft, layer0: draft.layer0.filter((c) => c.id !== args.clipId) }))
}

/** 一段视频的原声音量，收进 0 到上限 */
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

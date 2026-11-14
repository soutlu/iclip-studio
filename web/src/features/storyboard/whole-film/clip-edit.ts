import type { Edge } from '../editing/timeline-drag'
import { isMediaClip, MIN_CLIP_MS, type FilmClip } from './composition/film'
import { onRow, topTrack, zoneOf, type RowKey } from './placement'
import { resolveNearestFreeStart } from './vendor/hyperframes-studio/player/components/timelineCollision'
import {
  resolveAllTrackGaps,
  resolveCloseGapShifts,
  resolveTrackGapAt,
} from './vendor/hyperframes-studio/player/components/timelineGaps'

/**
 * 一个片段在成片里的起止和它的入点（毫秒）。入点是从素材的哪里开始放，
 * 组件或块的片段是从组件自己的第几毫秒开始播（`playbackStart`）。
 */
export type Timing = { start: number; duration: number; mediaStart: number }

export const timingOf = (clip: FilmClip): Timing => ({
  start: clip.start,
  duration: clip.duration,
  mediaStart: isMediaClip(clip) ? clip.mediaStart : clip.playbackStart,
})

const endOf = (clip: Pick<FilmClip, 'start' | 'duration'>) => clip.start + clip.duration

const rowKeyOf = (clip: FilmClip): RowKey => ({ zone: zoneOf(clip), track: clip.track })

/** 片段的速度：成片里的 1 毫秒用掉素材的几毫秒。组件或块的片段是 1。 */
export const rateOf = (clip: FilmClip): number => (isMediaClip(clip) ? clip.playbackRate : 1)

/**
 * 裁 `edge` 这一端时，这一端能到的范围（成片的毫秒）：不压到同一行的邻居，片段不短于最短长度；
 * 开头往前不早于入点 0，结尾往后不超出素材剩下的长度（音频开着循环也一样）。素材按片段的速度用，
 * 照参照的工作台：剩下的素材在成片里能放（素材长 − 入点）÷ 速度。
 * `sourceMs` 是视频片段、音频片段素材的总长，还不知道时结尾不许往外拉；组件或块的片段不看它，结尾不设上限。
 */
export const trimBounds = (
  clip: FilmClip,
  edge: Edge,
  clips: readonly FilmClip[],
  sourceMs: number | undefined,
): { min: number; max: number } => {
  const row = clips.filter((other) => onRow(other, rowKeyOf(clip)) && other.id !== clip.id)
  const { mediaStart } = timingOf(clip)
  const rate = rateOf(clip)
  if (edge === 'start') {
    const previousEnd = Math.max(0, ...row.filter((other) => endOf(other) <= clip.start).map(endOf))
    return {
      min: Math.max(previousEnd, Math.ceil(clip.start - mediaStart / rate)),
      max: endOf(clip) - MIN_CLIP_MS,
    }
  }
  // 后面没有片段时是无穷大：只受素材长度限制
  const nextStart = Math.min(
    ...row.filter((other) => other.start >= endOf(clip)).map((other) => other.start),
  )
  // 组件的长度属于组件自己的时间线，不拿来卡裁剪
  const sourceEnd = !isMediaClip(clip)
    ? Infinity
    : sourceMs === undefined
      ? endOf(clip)
      : Math.floor(clip.start + (sourceMs - mediaStart) / rate)
  return {
    min: clip.start + MIN_CLIP_MS,
    max: Math.max(endOf(clip), Math.min(nextStart, sourceEnd)),
  }
}

/**
 * 把 `edge` 这一端裁到 `timeMs`（先收进 `bounds`）之后，片段的起止和入点；裁开头时入点跟着动，
 * 动的是挪过的时间 × 速度（取整到毫秒，不小于 0）。
 */
export const trimmed = (
  clip: FilmClip,
  edge: Edge,
  timeMs: number,
  bounds: { min: number; max: number },
): Timing => {
  const at = Math.min(bounds.max, Math.max(bounds.min, timeMs))
  const { mediaStart } = timingOf(clip)
  if (edge === 'end') return { start: clip.start, duration: at - clip.start, mediaStart }
  const delta = at - clip.start
  return {
    start: at,
    duration: clip.duration - delta,
    mediaStart: Math.max(0, Math.round(mediaStart + delta * rateOf(clip))),
  }
}

const edgeOf = (clip: FilmClip, edge: Edge) => (edge === 'start' ? clip.start : endOf(clip))

/** 视频片段、音频片段素材的总长（毫秒）：还不知道时是 undefined。组件或块的片段不看它。 */
export type SourceLength = (clip: FilmClip) => number | undefined

/**
 * 几个片段一起裁 `edge` 这一端、挪同一个量时，这个量能取的范围（毫秒）：
 * 每个片段这一端按 `trimBounds` 能到哪里，取最受限的那个。
 */
export const groupTrimRange = (
  members: readonly FilmClip[],
  edge: Edge,
  clips: readonly FilmClip[],
  sourceMs: SourceLength,
): { min: number; max: number } => {
  const ranges = members.map((member) => {
    const bounds = trimBounds(member, edge, clips, sourceMs(member))
    return { min: bounds.min - edgeOf(member, edge), max: bounds.max - edgeOf(member, edge) }
  })
  return {
    min: Math.max(...ranges.map((range) => range.min)),
    max: Math.min(...ranges.map((range) => range.max)),
  }
}

/** 几个片段一起把 `edge` 这一端挪 `delta` 毫秒（先收进 `groupTrimRange`）之后，各自的起止和入点。 */
export const groupTrimmed = (
  members: readonly FilmClip[],
  edge: Edge,
  delta: number,
  clips: readonly FilmClip[],
  sourceMs: SourceLength,
): Map<string, Timing> => {
  const range = groupTrimRange(members, edge, clips, sourceMs)
  const shift = Math.min(range.max, Math.max(range.min, delta))
  return new Map(
    members.map((member) => [
      member.id,
      trimmed(
        member,
        edge,
        edgeOf(member, edge) + shift,
        trimBounds(member, edge, clips, sourceMs(member)),
      ),
    ]),
  )
}

/** 挪动的结果：一起挪的片段共用的时间差（毫秒），被抓的片段最后在它那个区的哪一行（null 是新开的一行）。 */
export type GroupShift = { delta: number; track: number | null }

/**
 * 挪动（一个片段也是一组）：`group` 里的片段（含被抓的 `grabbed`）挪同一个时间差，取离 `wantedDelta` 最近的，
 * 一样近取靠后的。被抓的片段去它那个区的 `track` 这一行（null 是新开的一行，上面没有别的片段），
 * 别的片段留在各自的行。整组不早于 0；每个片段都不和它那一行上没在挪的片段重叠，同组的片段互不挡路。
 * `track` 上有和被抓的片段时间重叠的同组片段（挪同一个时间差也分不开），或者在那里找不到时间差时，
 * 被抓的片段留在自己那一行重新找。
 */
export const groupShift = (
  grabbed: FilmClip,
  group: ReadonlySet<string>,
  clips: readonly FilmClip[],
  wantedDelta: number,
  track: number | null,
): GroupShift => {
  const members = clips.filter((clip) => group.has(clip.id))
  const zone = zoneOf(grabbed)
  // 按被抓的片段的起点算：整组能挪到的最早的位置
  const lowest = grabbed.start - Math.min(...members.map((member) => member.start))
  const wanted = Math.max(lowest, grabbed.start + wantedDelta)
  const shiftOn = (row: number | null): number => {
    // 某个片段压到它那一行上一个没在挪的片段时，被抓的片段的起点有一段不能去；
    // 把这些段当成一行上的片段，被抓的片段当成长度为 0 的片段，找离想要的位置最近的空处
    const busy = members.flatMap((member) => {
      const on: RowKey | null =
        member.id === grabbed.id ? (row === null ? null : { zone, track: row }) : rowKeyOf(member)
      const offset = member.start - grabbed.start
      return clips
        .filter((other) => on !== null && onRow(other, on) && !group.has(other.id))
        .map((other) => ({
          id: `${member.id}:${other.id}`,
          start: (other.start - offset - member.duration) / 1000,
          duration: (other.duration + member.duration) / 1000,
          track: 0,
        }))
    })
    const start = resolveNearestFreeStart(busy, 0, wanted / 1000, 0, null, lowest / 1000)
    return Math.round(start * 1000) - grabbed.start
  }
  const overlapsGrabbed = (member: FilmClip) =>
    member.start < endOf(grabbed) && grabbed.start < endOf(member)
  const blocked =
    track !== null &&
    track !== grabbed.track &&
    members.some(
      (member) =>
        member.id !== grabbed.id && onRow(member, { zone, track }) && overlapsGrabbed(member),
    )
  return blocked
    ? { delta: shiftOn(grabbed.track), track: grabbed.track }
    : { delta: shiftOn(track), track }
}

/** 合拢空档之后要挪的片段各自的新起点（毫秒）；没有可合拢的是空表。 */
export type GapClosing = {
  /** 只合拢指针所在的这一个空档：它后面这一行的片段都往前挪这个空档的宽度。 */
  one: ReadonlyMap<string, number>
  /** 合拢这一行所有的空档：片段从 0 起一个接一个。 */
  all: ReadonlyMap<string, number>
}

/** 在 `row` 这一行的 `timeMs` 处点右键时，两种合拢各自要挪哪些片段。 */
export const gapClosing = (clips: readonly FilmClip[], row: RowKey, timeMs: number): GapClosing => {
  const members = clips
    .filter((clip) => onRow(clip, row))
    .map((clip) => ({
      id: clip.id,
      start: clip.start / 1000,
      duration: clip.duration / 1000,
      track: row.track,
    }))
  const starts = (shifts: readonly { key: string; newStart: number }[]) =>
    new Map(shifts.map((shift) => [shift.key, Math.round(shift.newStart * 1000)]))
  const gap = resolveTrackGapAt(members, timeMs / 1000)
  return {
    one: starts(gap === null ? [] : resolveCloseGapShifts(members, gap)),
    all: starts(resolveAllTrackGaps(members)),
  }
}

/**
 * 开着波纹编辑时删掉 `removed` 这些片段之后，主轨（画面区最上面那一行）里剩下的片段各自往前挪到哪里：
 * 每个片段挪的是它前面被删掉的主轨上的片段的总长。别的行不动。
 */
export const rippleStarts = (
  clips: readonly FilmClip[],
  removed: ReadonlySet<string>,
): Map<string, number> => {
  const main = clips.filter((clip) => onRow(clip, { zone: 'visual', track: topTrack(clips) }))
  const gone = main.filter((clip) => removed.has(clip.id))
  const starts = new Map<string, number>()
  for (const clip of main) {
    if (removed.has(clip.id)) continue
    const shift = gone
      .filter((deleted) => deleted.start < clip.start)
      .reduce((sum, deleted) => sum + deleted.duration, 0)
    if (shift > 0) starts.set(clip.id, clip.start - shift)
  }
  return starts
}

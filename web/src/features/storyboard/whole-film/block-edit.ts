import type { Edge } from '../editing/timeline-drag'
import { MAX_FILM_MS, MIN_BLOCK_MS, type PictureBlock } from './composition/film'
import { landingOn } from './placement'
import {
  resolveAllTrackGaps,
  resolveCloseGapShifts,
  resolveTrackGapAt,
} from './vendor/hyperframes-studio/player/components/timelineGaps'

/** 一个块在成片里的起止和它从素材的哪里开始放（毫秒）。 */
export type Timing = Pick<PictureBlock, 'start' | 'duration' | 'mediaStart'>

// 开着波纹编辑时只有这一行删了块会往前补
const MAIN_TRACK = 0

const endOf = (block: Pick<PictureBlock, 'start' | 'duration'>) => block.start + block.duration

/**
 * 裁 `edge` 这一端时，这一端能到的范围（成片的毫秒）：不压到同一行的邻居，不超出素材本身，
 * 块不短于最短长度。`sourceMs` 是素材片的总长，还不知道时结尾不许往外拉。
 */
export const trimBounds = (
  block: PictureBlock,
  edge: Edge,
  pictures: readonly PictureBlock[],
  sourceMs: number | undefined,
): { min: number; max: number } => {
  const row = pictures.filter((other) => other.track === block.track && other.id !== block.id)
  if (edge === 'start') {
    const previousEnd = Math.max(
      0,
      ...row.filter((other) => endOf(other) <= block.start).map(endOf),
    )
    return {
      min: Math.max(previousEnd, block.start - block.mediaStart),
      max: endOf(block) - MIN_BLOCK_MS,
    }
  }
  const nextStart = Math.min(
    MAX_FILM_MS,
    ...row.filter((other) => other.start >= endOf(block)).map((other) => other.start),
  )
  const sourceEnd =
    sourceMs === undefined ? endOf(block) : block.start + sourceMs - block.mediaStart
  return {
    min: block.start + MIN_BLOCK_MS,
    max: Math.max(endOf(block), Math.min(nextStart, sourceEnd)),
  }
}

/** 把 `edge` 这一端裁到 `timeMs`（先收进 `bounds`）之后，块的起止和入点。 */
export const trimmed = (
  block: PictureBlock,
  edge: Edge,
  timeMs: number,
  bounds: { min: number; max: number },
): Timing => {
  const at = Math.min(bounds.max, Math.max(bounds.min, timeMs))
  if (edge === 'end')
    return { start: block.start, duration: at - block.start, mediaStart: block.mediaStart }
  const delta = at - block.start
  return { start: at, duration: block.duration - delta, mediaStart: block.mediaStart + delta }
}

/**
 * 把块挪到 `track` 这一行（不给就是它现在这一行）的 `startMs` 附近：
 * 不和那一行的块重叠，也不超出成片最长的长度。
 */
export const movedStart = (
  block: PictureBlock,
  pictures: readonly PictureBlock[],
  startMs: number,
  track = block.track,
): number =>
  landingOn(
    pictures.filter((other) => other.id !== block.id),
    track,
    Math.min(startMs, MAX_FILM_MS - block.duration),
    block.duration,
  ).start

/** 合拢空档之后要挪的块各自的新起点（毫秒）；没有可合拢的是空表。 */
export type GapClosing = {
  /** 只合拢指针所在的这一个空档：它后面这一行的块都往前挪这个空档的宽度。 */
  one: ReadonlyMap<string, number>
  /** 合拢这一行所有的空档：块从 0 起一个接一个。 */
  all: ReadonlyMap<string, number>
}

/** 在 `track` 这一行的 `timeMs` 处点右键时，两种合拢各自要挪哪些块。 */
export const gapClosing = (
  pictures: readonly PictureBlock[],
  track: number,
  timeMs: number,
): GapClosing => {
  const row = pictures
    .filter((block) => block.track === track)
    .map((block) => ({
      id: block.id,
      start: block.start / 1000,
      duration: block.duration / 1000,
      track,
    }))
  const starts = (shifts: readonly { key: string; newStart: number }[]) =>
    new Map(shifts.map((shift) => [shift.key, Math.round(shift.newStart * 1000)]))
  const gap = resolveTrackGapAt(row, timeMs / 1000)
  return {
    one: starts(gap === null ? [] : resolveCloseGapShifts(row, gap)),
    all: starts(resolveAllTrackGaps(row)),
  }
}

/**
 * 开着波纹编辑时删掉 `removed` 这些块之后，第一行里剩下的块各自往前挪到哪里：
 * 每个块挪的是它前面被删掉的第一行的块的总长。别的行不动。
 */
export const rippleStarts = (
  pictures: readonly PictureBlock[],
  removed: ReadonlySet<string>,
): Map<string, number> => {
  const main = pictures.filter((block) => block.track === MAIN_TRACK)
  const gone = main.filter((block) => removed.has(block.id))
  const starts = new Map<string, number>()
  for (const block of main) {
    if (removed.has(block.id)) continue
    const shift = gone
      .filter((deleted) => deleted.start < block.start)
      .reduce((sum, deleted) => sum + deleted.duration, 0)
    if (shift > 0) starts.set(block.id, block.start - shift)
  }
  return starts
}

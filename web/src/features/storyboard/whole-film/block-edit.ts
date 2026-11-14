import type { Edge } from '../editing/timeline-drag'
import { isMediaBlock, MIN_BLOCK_MS, type FilmBlock } from './composition/film'
import { onRow, topTrack, zoneOf, type RowKey } from './placement'
import { resolveNearestFreeStart } from './vendor/hyperframes-studio/player/components/timelineCollision'
import {
  resolveAllTrackGaps,
  resolveCloseGapShifts,
  resolveTrackGapAt,
} from './vendor/hyperframes-studio/player/components/timelineGaps'

/**
 * 一个块在成片里的起止和它的入点（毫秒）。入点是从素材的哪里开始放，
 * 组件块是从组件自己的第几毫秒开始播（`playbackStart`）。
 */
export type Timing = { start: number; duration: number; mediaStart: number }

export const timingOf = (block: FilmBlock): Timing => ({
  start: block.start,
  duration: block.duration,
  mediaStart: isMediaBlock(block) ? block.mediaStart : block.playbackStart,
})

const endOf = (block: Pick<FilmBlock, 'start' | 'duration'>) => block.start + block.duration

const rowKeyOf = (block: FilmBlock): RowKey => ({ zone: zoneOf(block), track: block.track })

/** 块的速度：成片里的 1 毫秒用掉素材的几毫秒。组件块是 1。 */
export const rateOf = (block: FilmBlock): number => (isMediaBlock(block) ? block.playbackRate : 1)

/**
 * 裁 `edge` 这一端时，这一端能到的范围（成片的毫秒）：不压到同一行的邻居，块不短于最短长度；
 * 开头往前不早于入点 0，结尾往后不超出素材剩下的长度（音频开着循环也一样）。素材按块的速度用，
 * 照参照的工作台：剩下的素材在成片里能放（素材长 − 入点）÷ 速度。
 * `sourceMs` 是画面块、音频块素材的总长，还不知道时结尾不许往外拉；组件块不看它，结尾不设上限。
 */
export const trimBounds = (
  block: FilmBlock,
  edge: Edge,
  blocks: readonly FilmBlock[],
  sourceMs: number | undefined,
): { min: number; max: number } => {
  const row = blocks.filter((other) => onRow(other, rowKeyOf(block)) && other.id !== block.id)
  const { mediaStart } = timingOf(block)
  const rate = rateOf(block)
  if (edge === 'start') {
    const previousEnd = Math.max(
      0,
      ...row.filter((other) => endOf(other) <= block.start).map(endOf),
    )
    return {
      min: Math.max(previousEnd, Math.ceil(block.start - mediaStart / rate)),
      max: endOf(block) - MIN_BLOCK_MS,
    }
  }
  // 后面没有块时是无穷大：只受素材长度限制
  const nextStart = Math.min(
    ...row.filter((other) => other.start >= endOf(block)).map((other) => other.start),
  )
  // 组件的长度属于组件自己的时间线，不拿来卡裁剪
  const sourceEnd = !isMediaBlock(block)
    ? Infinity
    : sourceMs === undefined
      ? endOf(block)
      : Math.floor(block.start + (sourceMs - mediaStart) / rate)
  return {
    min: block.start + MIN_BLOCK_MS,
    max: Math.max(endOf(block), Math.min(nextStart, sourceEnd)),
  }
}

/**
 * 把 `edge` 这一端裁到 `timeMs`（先收进 `bounds`）之后，块的起止和入点；裁开头时入点跟着动，
 * 动的是挪过的时间 × 速度（取整到毫秒，不小于 0）。
 */
export const trimmed = (
  block: FilmBlock,
  edge: Edge,
  timeMs: number,
  bounds: { min: number; max: number },
): Timing => {
  const at = Math.min(bounds.max, Math.max(bounds.min, timeMs))
  const { mediaStart } = timingOf(block)
  if (edge === 'end') return { start: block.start, duration: at - block.start, mediaStart }
  const delta = at - block.start
  return {
    start: at,
    duration: block.duration - delta,
    mediaStart: Math.max(0, Math.round(mediaStart + delta * rateOf(block))),
  }
}

const edgeOf = (block: FilmBlock, edge: Edge) => (edge === 'start' ? block.start : endOf(block))

/** 画面块、音频块素材的总长（毫秒）：还不知道时是 undefined。组件块不看它。 */
export type SourceLength = (block: FilmBlock) => number | undefined

/**
 * 几个块一起裁 `edge` 这一端、挪同一个量时，这个量能取的范围（毫秒）：
 * 每个块这一端按 `trimBounds` 能到哪里，取最受限的那个。
 */
export const groupTrimRange = (
  members: readonly FilmBlock[],
  edge: Edge,
  blocks: readonly FilmBlock[],
  sourceMs: SourceLength,
): { min: number; max: number } => {
  const ranges = members.map((member) => {
    const bounds = trimBounds(member, edge, blocks, sourceMs(member))
    return { min: bounds.min - edgeOf(member, edge), max: bounds.max - edgeOf(member, edge) }
  })
  return {
    min: Math.max(...ranges.map((range) => range.min)),
    max: Math.min(...ranges.map((range) => range.max)),
  }
}

/** 几个块一起把 `edge` 这一端挪 `delta` 毫秒（先收进 `groupTrimRange`）之后，各自的起止和入点。 */
export const groupTrimmed = (
  members: readonly FilmBlock[],
  edge: Edge,
  delta: number,
  blocks: readonly FilmBlock[],
  sourceMs: SourceLength,
): Map<string, Timing> => {
  const range = groupTrimRange(members, edge, blocks, sourceMs)
  const shift = Math.min(range.max, Math.max(range.min, delta))
  return new Map(
    members.map((member) => [
      member.id,
      trimmed(
        member,
        edge,
        edgeOf(member, edge) + shift,
        trimBounds(member, edge, blocks, sourceMs(member)),
      ),
    ]),
  )
}

/** 挪动的结果：一起挪的块共用的时间差（毫秒），被抓的块最后在它那个区的哪一行（null 是新开的一行）。 */
export type GroupShift = { delta: number; track: number | null }

/**
 * 挪动（一个块也是一组）：`group` 里的块（含被抓的 `grabbed`）挪同一个时间差，取离 `wantedDelta` 最近的，
 * 一样近取靠后的。被抓的块去它那个区的 `track` 这一行（null 是新开的一行，上面没有别的块），
 * 别的块留在各自的行。整组不早于 0；每个块都不和它那一行上没在挪的块重叠，同组的块互不挡路。
 * `track` 上有和被抓的块时间重叠的同组块（挪同一个时间差也分不开），或者在那里找不到时间差时，
 * 被抓的块留在自己那一行重新找。
 */
export const groupShift = (
  grabbed: FilmBlock,
  group: ReadonlySet<string>,
  blocks: readonly FilmBlock[],
  wantedDelta: number,
  track: number | null,
): GroupShift => {
  const members = blocks.filter((block) => group.has(block.id))
  const zone = zoneOf(grabbed)
  // 按被抓的块的起点算：整组能挪到的最早的位置
  const lowest = grabbed.start - Math.min(...members.map((member) => member.start))
  const wanted = Math.max(lowest, grabbed.start + wantedDelta)
  const shiftOn = (row: number | null): number => {
    // 某个块压到它那一行上一个没在挪的块时，被抓的块的起点有一段不能去；
    // 把这些段当成一行上的块，被抓的块当成长度为 0 的块，找离想要的位置最近的空处
    const busy = members.flatMap((member) => {
      const on: RowKey | null =
        member.id === grabbed.id ? (row === null ? null : { zone, track: row }) : rowKeyOf(member)
      const offset = member.start - grabbed.start
      return blocks
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
  const overlapsGrabbed = (member: FilmBlock) =>
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

/** 合拢空档之后要挪的块各自的新起点（毫秒）；没有可合拢的是空表。 */
export type GapClosing = {
  /** 只合拢指针所在的这一个空档：它后面这一行的块都往前挪这个空档的宽度。 */
  one: ReadonlyMap<string, number>
  /** 合拢这一行所有的空档：块从 0 起一个接一个。 */
  all: ReadonlyMap<string, number>
}

/** 在 `row` 这一行的 `timeMs` 处点右键时，两种合拢各自要挪哪些块。 */
export const gapClosing = (
  blocks: readonly FilmBlock[],
  row: RowKey,
  timeMs: number,
): GapClosing => {
  const members = blocks
    .filter((block) => onRow(block, row))
    .map((block) => ({
      id: block.id,
      start: block.start / 1000,
      duration: block.duration / 1000,
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
 * 开着波纹编辑时删掉 `removed` 这些块之后，主轨（画面区最上面那一行）里剩下的块各自往前挪到哪里：
 * 每个块挪的是它前面被删掉的主轨上的块的总长。别的行不动。
 */
export const rippleStarts = (
  blocks: readonly FilmBlock[],
  removed: ReadonlySet<string>,
): Map<string, number> => {
  const main = blocks.filter((block) => onRow(block, { zone: 'visual', track: topTrack(blocks) }))
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

import type { PictureBlock } from './composition/film'
import { resolveNearestFreeStart } from './vendor/hyperframes-studio/player/components/timelineCollision'

export type Row = { track: number; blocks: readonly PictureBlock[] }

/** 按行分好的块：行号小的在上面，行里按开始时间排。 */
export const rowsOf = (pictures: readonly PictureBlock[]): Row[] => {
  const rows = new Map<number, PictureBlock[]>()
  for (const block of pictures) rows.set(block.track, [...(rows.get(block.track) ?? []), block])
  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([track, blocks]) => ({
      track,
      blocks: blocks.toSorted((left, right) => left.start - right.start),
    }))
}

/** 第一行（时间线最上面那一行）的行号：行号不一定从 0 开始；还没有块时是 0。 */
export const topTrack = (pictures: readonly PictureBlock[]): number =>
  pictures.length === 0 ? 0 : Math.min(...pictures.map((block) => block.track))

/** 这一行是不是隐藏着：行里有块，而且每个块都隐藏了。 */
export const rowHidden = (pictures: readonly PictureBlock[], track: number): boolean => {
  const row = pictures.filter((block) => block.track === track)
  return row.length > 0 && row.every((block) => block.hidden)
}

/** 新开一行时别的块要换成的行号；行号没变的不列。 */
export type Renumbering = ReadonlyMap<string, number>

/**
 * 在时间线上第 `insertAt` 行的位置新开一行（0 是最上面，等于现有行数是最下面）：
 * 新的一行是几号，别的块各自换成几号。行号从 0 起连着排，原来空着的号顺带补上。
 * `movedId` 是要搬进新行的那个块：它原来那一行只剩它时，那一行就不再算。
 */
export const rowOpening = (
  pictures: readonly PictureBlock[],
  insertAt: number,
  movedId?: string,
): { track: number; renumber: Renumbering } => {
  const kept = rowsOf(pictures).map((row) => row.blocks.filter((block) => block.id !== movedId))
  const track = kept.slice(0, Math.max(0, insertAt)).filter((blocks) => blocks.length > 0).length
  const renumber = new Map<string, number>()
  kept
    .filter((blocks) => blocks.length > 0)
    .forEach((blocks, index) => {
      const next = index < track ? index : index + 1
      for (const block of blocks) if (block.track !== next) renumber.set(block.id, next)
    })
  return { track, renumber }
}

export type Landing = { track: number; start: number }

/**
 * 一段长 `duration` 毫秒的素材拖到 `track` 这一行、指针在 `timeMs` 时放在哪：
 * 同一行的块不能重叠，放在离指针最近的空位；没有够长的空位时接在这一行最后一个块后面。
 */
export const landingOn = (
  pictures: readonly PictureBlock[],
  track: number,
  timeMs: number,
  duration: number,
): Landing => {
  const start = resolveNearestFreeStart(
    pictures.map((block) => ({
      id: block.id,
      start: block.start / 1000,
      duration: block.duration / 1000,
      track: block.track,
    })),
    track,
    Math.max(0, timeMs) / 1000,
    duration / 1000,
    null,
  )
  return { track, start: Math.round(start * 1000) }
}

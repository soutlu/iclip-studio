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

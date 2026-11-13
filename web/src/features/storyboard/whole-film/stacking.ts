import type { FilmBlock } from './composition/film'
import { rowsOf, type RowTarget } from './placement'
import {
  computeStackingPatches,
  type StackingDirection,
} from './vendor/hyperframes-studio/player/components/timelineStackingSync'

/**
 * 新加的块的叠放顺序：叠在最上面。`existing` 是加之前文件里所有的块（三种都算），
 * `placed` 是这一次已经放下的块数。
 */
export const newBlockZ = (existing: readonly FilmBlock[], placed: number): number =>
  Math.max(1, existing.length + placed + 1)

/**
 * 把块 `id` 换到 `row` 时它往上还是往下挪：`row` 是已有的一行，或在时间线上第几行的位置新开一行
 * （0 是最上面）。都按挪之前时间线上的第几行比；在自己这一行的位置新开（紧挨着这一行的上面）时
 * 返回 null，不调叠放顺序。
 */
export const rowMoveDirection = (
  blocks: readonly FilmBlock[],
  id: string,
  row: RowTarget,
): StackingDirection | null => {
  const rows = rowsOf(blocks)
  const current = rows.findIndex((lane) => lane.blocks.some((block) => block.id === id))
  const aimed =
    'insertAt' in row
      ? row.insertAt
      : rows.findIndex((lane) => lane.zone === row.zone && lane.track === row.track)
  return aimed < current ? 'up' : aimed > current ? 'down' : null
}

/**
 * 换行以后被挪的块 `id` 的叠放顺序；不用改时返回 undefined。别的块一律不动。
 *
 * `blocks` 是文件里所有的块，按文件里的先后，行号和起止都是换完之后的。
 * 往上挪：抬到它现在压着的、时间上重叠的块之上；往下挪：降到盖着它的、时间上重叠的块之下，
 * 但不低于 0。音频块不参与。
 */
export const restackedZ = (
  blocks: readonly FilmBlock[],
  id: string,
  direction: StackingDirection,
): number | undefined => {
  const elements = blocks.map((block, domIndex) => ({
    key: block.id,
    start: block.start / 1000,
    duration: block.duration / 1000,
    track: block.track,
    zIndex: block.kind === 'audio' ? 0 : block.z,
    isAudio: block.kind === 'audio',
    domIndex,
  }))
  return computeStackingPatches(elements, [id], direction)[0]?.zIndex
}

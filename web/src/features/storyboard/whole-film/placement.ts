import type { FilmBlock } from './composition/film'
import {
  resolveNearestFreeStart,
  resolveZoneDropPlacement,
} from './vendor/hyperframes-studio/player/components/timelineCollision'

/** 时间线上的区：画面区（画面块和组件块）在上，声音区（音频块）在下。 */
export type Zone = 'visual' | 'audio'

export const zoneOf = (block: Pick<FilmBlock, 'kind'>): Zone =>
  block.kind === 'audio' ? 'audio' : 'visual'

/** 一行：哪个区的第几号。两个区的行号各算各的。 */
export type RowKey = { zone: Zone; track: number }

export type Row = RowKey & { blocks: readonly FilmBlock[] }

export const onRow = (block: FilmBlock, row: RowKey): boolean =>
  zoneOf(block) === row.zone && block.track === row.track

/**
 * 块要去的行：已有的一行，或者在时间线上第 `insertAt` 行的位置为 `zone` 新开一行
 * （0 是最上面，等于现有行数是最下面那条空行）。
 */
export type RowTarget = RowKey | { zone: Zone; insertAt: number }

export const sameRow = (left: RowTarget, right: RowTarget): boolean =>
  left.zone === right.zone &&
  ('track' in left && 'track' in right
    ? left.track === right.track
    : 'insertAt' in left && 'insertAt' in right && left.insertAt === right.insertAt)

/** 按行分好的块，按时间线上从上往下：画面区各行、声音区各行，区里行号小的在上面；行里按开始时间排。 */
export const rowsOf = (blocks: readonly FilmBlock[]): Row[] =>
  (['visual', 'audio'] as const).flatMap((zone) => {
    const rows = new Map<number, FilmBlock[]>()
    for (const block of blocks)
      if (zoneOf(block) === zone) rows.set(block.track, [...(rows.get(block.track) ?? []), block])
    return [...rows.entries()]
      .sort(([left], [right]) => left - right)
      .map(([track, row]) => ({
        zone,
        track,
        blocks: row.toSorted((left, right) => left.start - right.start),
      }))
  })

/**
 * 主轨的行号：画面区最上面那一行（行号不一定从 0 开始）；画面区还没有块时是 0。
 * 波纹编辑补位、没给落点的镜头接在末尾，都认它。
 */
export const topTrack = (blocks: readonly FilmBlock[]): number => {
  const tracks = blocks.filter((block) => zoneOf(block) === 'visual').map((block) => block.track)
  return tracks.length === 0 ? 0 : Math.min(...tracks)
}

/** 这一行是不是隐藏着（声音区的行就是静音）：行里有块，而且每个块都隐藏了。 */
export const rowHidden = (blocks: readonly FilmBlock[], row: RowKey): boolean => {
  const members = blocks.filter((block) => onRow(block, row))
  return members.length > 0 && members.every((block) => block.hidden)
}

/** 新开一行时别的块要换成的行号；行号没变的不列。 */
export type Renumbering = ReadonlyMap<string, number>

/**
 * 在时间线上第 `insertAt` 行的位置为 `zone` 新开一行（0 是最上面，等于现有行数是最下面）：
 * 新的一行在这个区里是几号，这个区里别的块各自换成几号；别的区不动。
 * 区里的行号从 0 起连着排，原来空着的号顺带补上。
 * `movedId` 是要搬进新行的那个块：它原来那一行只剩它时，那一行就不再算。
 */
export const rowOpening = (
  blocks: readonly FilmBlock[],
  zone: Zone,
  insertAt: number,
  movedId?: string,
): { track: number; renumber: Renumbering } => {
  const kept = rowsOf(blocks)
    .map((row, at) => ({ ...row, at, blocks: row.blocks.filter((block) => block.id !== movedId) }))
    .filter((row) => row.zone === zone && row.blocks.length > 0)
  const track = kept.filter((row) => row.at < insertAt).length
  const renumber = new Map<string, number>()
  kept.forEach((row, index) => {
    const next = index < track ? index : index + 1
    for (const block of row.blocks) if (block.track !== next) renumber.set(block.id, next)
  })
  return { track, renumber }
}

/**
 * 指针对着的地方：时间线上第 `at` 行（从上往下数，0 起），或者第 `insertAt` 行的位置
 * （0 是最上面，等于现有行数是最下面那条空行）。
 */
export type Aim = { at: number } | { insertAt: number }

/**
 * `zone` 区的块对着 `aim` 时落在哪一行：块只待在自己的区里。
 * 对着别的区的行、或者在别的区里新开一行时，落在自己的区里挨着的那一行；
 * 对着最上面、最下面而那里不归自己的区时，在自己的区的边上新开一行。
 */
export const targetIn = (rows: readonly RowKey[], aim: Aim, zone: Zone): RowTarget => {
  // 参照的算法只认一串行号：这里用的是时间线上的第几行，各区的行号不进去
  const order = rows.map((_, at) => at)
  const audioRows = new Set(order.filter((at) => rows[at]?.zone === 'audio'))
  const placed = resolveZoneDropPlacement({
    order,
    audioTracks: audioRows,
    elements: [],
    // 对着最上面、最下面那条空行时，和参照的做法一样给一个在各行之外的号
    desiredTrack: 'at' in aim ? aim.at : aim.insertAt === 0 ? -1 : aim.insertAt,
    deliberateInsertRow: 'insertAt' in aim ? aim.insertAt : null,
    start: 0,
    duration: 0,
    dragKey: '',
    isAudio: zone === 'audio',
  })
  const row = rows[placed.track]
  return placed.insertRow !== null || row === undefined
    ? { zone, insertAt: placed.insertRow ?? rows.length }
    : { zone: row.zone, track: row.track }
}

export type Landing = { track: number; start: number }

/**
 * 一段长 `duration` 毫秒的块拖到 `row` 这一行、指针在 `timeMs` 时放在哪：
 * 同一行的块不能重叠，放在离指针最近的空位；没有够长的空位时接在这一行最后一个块后面。
 */
export const landingOn = (
  blocks: readonly FilmBlock[],
  row: RowKey,
  timeMs: number,
  duration: number,
): Landing => {
  const start = resolveNearestFreeStart(
    blocks
      .filter((block) => onRow(block, row))
      .map((block) => ({
        id: block.id,
        start: block.start / 1000,
        duration: block.duration / 1000,
        track: block.track,
      })),
    row.track,
    Math.max(0, timeMs) / 1000,
    duration / 1000,
    null,
  )
  return { track: row.track, start: Math.round(start * 1000) }
}

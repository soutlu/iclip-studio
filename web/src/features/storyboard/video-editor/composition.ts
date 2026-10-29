import { z } from 'zod'
import type { GenerationJob } from '../storyboard.api'
import { layoutPlay } from '../editing/play-layout'
import { contiguousRange } from '../editing/range-select'
import { spansOverlap, type EditBlock, type Shot } from './edit-blocks'

/** 比较时间用的容差（秒）：渲染与关键帧读数取到毫秒。 */
const EPSILON = 0.001
/** 合成里的编辑段起止与它的全长差在这以内算用了整段（秒），同编辑段对齐镜头的容差。 */
const WHOLE_TOLERANCE = 0.05

type ReadyBlock = EditBlock & { state: { kind: 'ready'; duration: number } }

const isReady = (block: EditBlock): block is ReadyBlock => block.state.kind === 'ready'

/** 选用了、且结果可用的编辑片段。 */
export const pickedBlocksOf = (blocks: readonly EditBlock[], picks: readonly string[]) =>
  blocks.filter(isReady).filter((block) => picks.includes(block.id))

/** 选用 `id`：与它重叠的已选用片段一并取消。 */
export const pickEdit = (
  picks: readonly string[],
  blocks: readonly EditBlock[],
  id: string,
): string[] => {
  const target = blocks.find((block) => block.id === id)
  if (target === undefined) return [...picks]
  return [
    ...picks.filter((other) => {
      const block = blocks.find((item) => item.id === other)
      return other !== id && block !== undefined && !spansOverlap(block, target)
    }),
    id,
  ]
}

/** 存着的或推出来的一组选用能不能用：每条都在轨上、结果可用，且彼此不重叠。 */
export const arePicksUsable = (picks: readonly string[], blocks: readonly EditBlock[]) => {
  const chosen = picks.map((id) => blocks.find((block) => block.id === id))
  return chosen.every(
    (block, at) =>
      block !== undefined &&
      isReady(block) &&
      chosen.slice(0, at).every((other) => other === undefined || !spansOverlap(other, block)),
  )
}

/** 原片轨上的选区单位：没被替换的镜头，或一条已选用的编辑片段（算它替换的整段），按原片时间排。 */
export type Unit =
  | { kind: 'shot'; id: string; start: number; end: number; shot: Shot }
  | { kind: 'edit'; id: string; start: number; end: number; block: ReadyBlock }

export const shotUnitId = (shot: Shot) => `shot-${shot.no}`

/** 替换了这个镜头的已选用片段。 */
export const coverOf = (shot: Shot, picked: readonly ReadyBlock[]) =>
  picked.find((block) => block.from <= shot.no && shot.no <= block.to)

export const unitsOf = (shots: readonly Shot[], picked: readonly ReadyBlock[]): Unit[] => {
  const units: Unit[] = []
  for (const shot of shots) {
    const cover = coverOf(shot, picked)
    if (cover === undefined)
      units.push({ kind: 'shot', id: shotUnitId(shot), start: shot.start, end: shot.end, shot })
    else if (units.at(-1)?.id !== cover.id)
      units.push({ kind: 'edit', id: cover.id, start: cover.start, end: cover.end, block: cover })
  }
  return units
}

/** 选区：原片轨上连续的几个单位，或编辑轨上的一条编辑片段。 */
export type Selection =
  | { kind: 'units'; ids: readonly string[] }
  | { kind: 'edit'; id: string; settling: boolean }
  | undefined

/** 选区落在当前单位上的那一串；单位换了（选用变了）对不上就是没选。 */
export const selectedUnits = (units: readonly Unit[], selection: Selection): Unit[] => {
  if (selection?.kind !== 'units') return []
  const range = contiguousRange(
    units.map((unit) => unit.id),
    selection.ids,
  )
  return range === undefined ? [] : units.slice(range.from, range.to + 1)
}

/**
 * 键盘挪选区：不按 Shift 选中相邻的那个；按 Shift 时焦点在选区一端，往外扩、往里收，另一端不动。
 * 返回新的焦点与选区；到头了原样返回。
 */
export const stepSelect = (
  order: readonly string[],
  selected: readonly string[],
  focusId: string,
  direction: -1 | 1,
  extend: boolean,
): { focus: string; selection: readonly string[] } => {
  const focus = order.indexOf(focusId)
  const target = order[focus + direction]
  if (focus < 0 || target === undefined) return { focus: focusId, selection: selected }
  if (!extend) return { focus: target, selection: [target] }
  const range = contiguousRange(order, selected)
  const anchor =
    range === undefined || (focus !== range.from && focus !== range.to)
      ? focus
      : focus === range.from
        ? range.to
        : range.from
  const next = focus + direction
  return {
    focus: target,
    selection: order.slice(Math.min(anchor, next), Math.max(anchor, next) + 1),
  }
}

/** 合成里的一段：出自原片或一条编辑片段的媒体时间 `start`–`end`，`a0`–`a1` 是它在原片时间轴上占的位置。 */
export type Piece = {
  kind: 'base' | 'edit'
  sourceJobId: string
  mediaUrl: string
  start: number
  end: number
  a0: number
  a1: number
}

export type PlacedPiece = Piece & { at: number; duration: number }

/** 合成内容：原片没被替换的部分（相连的并成一段）加选用的编辑片段整段，按原片时间排，再首尾相接。 */
export const compositionOf = (
  root: { id: string; mediaUrl: string },
  shots: readonly Shot[],
  picked: readonly ReadyBlock[],
): PlacedPiece[] => {
  const pieces: Piece[] = []
  for (const unit of unitsOf(shots, picked)) {
    const last = pieces.at(-1)
    if (unit.kind === 'edit') {
      const url = unit.block.job.outputUrl
      if (url === null) continue
      pieces.push({
        kind: 'edit',
        sourceJobId: unit.id,
        mediaUrl: url,
        start: 0,
        end: unit.block.state.duration,
        a0: unit.start,
        a1: unit.end,
      })
    } else if (last?.kind === 'base' && Math.abs(last.end - unit.start) < EPSILON) {
      last.end = unit.end
      last.a1 = unit.end
    } else {
      pieces.push({
        kind: 'base',
        sourceJobId: root.id,
        mediaUrl: root.mediaUrl,
        start: unit.start,
        end: unit.end,
        a0: unit.start,
        a1: unit.end,
      })
    }
  }
  return layoutPlay(pieces)
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** 合成里的时刻在原片时间轴上的位置：编辑片段里按比例落在它替换的那段上。 */
export const anchorOfClock = (pieces: readonly PlacedPiece[], clock: number): number => {
  const piece =
    pieces.find((item) => clock >= item.at && clock < item.at + item.duration) ?? pieces.at(-1)
  if (piece === undefined) return 0
  return piece.a0 + clamp01((clock - piece.at) / piece.duration) * (piece.a1 - piece.a0)
}

/** 原片时间轴上的位置在合成里的时刻，`anchorOfClock` 的反向。 */
export const clockOfAnchor = (pieces: readonly PlacedPiece[], anchor: number): number => {
  const piece = pieces.find((item) => anchor >= item.a0 && anchor < item.a1) ?? pieces.at(-1)
  if (piece === undefined) return 0
  return piece.at + clamp01((anchor - piece.a0) / (piece.a1 - piece.a0)) * piece.duration
}

/** 合成请求里的一段；`end` 为 null 是这一段的出处整条用到结尾。 */
export type Segment = { sourceJobId: string; start: number; end: number | null }

/** 合成请求的片段：原片按媒体时间，编辑片段用整段。 */
export const segmentsOf = (pieces: readonly PlacedPiece[]): Segment[] =>
  pieces.map((piece) =>
    piece.kind === 'base'
      ? { sourceJobId: piece.sourceJobId, start: piece.start, end: piece.end }
      : { sourceJobId: piece.sourceJobId, start: 0, end: null },
  )

const zCompositeRequest = z.object({
  segments: z
    .array(
      z.object({
        sourceJobId: z.string().min(1),
        start: z.number().nonnegative(),
        end: z.number().nullable().optional(),
      }),
    )
    .min(1),
})

/**
 * 一条合成用的片段，统一成可比较的样子：原片里相连的几段并成一段，用了整段的编辑段写成 0 到 null；
 * 请求读不懂时为 undefined。`durationOf` 给编辑段的全长（秒），不知道就按原样比。
 */
export const compositeSegmentsOf = (
  composite: GenerationJob,
  rootJobId: string,
  durationOf: (jobId: string) => number | undefined,
): Segment[] | undefined => {
  const parsed = zCompositeRequest.safeParse(composite.request)
  if (!parsed.success) return undefined
  const segments: Segment[] = []
  for (const { sourceJobId, start, end = null } of parsed.data.segments) {
    const last = segments.at(-1)
    if (sourceJobId === rootJobId) {
      if (
        last?.sourceJobId === rootJobId &&
        last.end !== null &&
        Math.abs(last.end - start) < EPSILON
      )
        last.end = end
      else segments.push({ sourceJobId, start, end })
      continue
    }
    const duration = durationOf(sourceJobId)
    const whole =
      start < EPSILON &&
      (end === null || (duration !== undefined && Math.abs(end - duration) <= WHOLE_TOLERANCE))
    segments.push(whole ? { sourceJobId, start: 0, end: null } : { sourceJobId, start, end })
  }
  return segments
}

/** 一组合成片段首尾相接有多长（秒）；有一段用到出处结尾、出处又不知道多长时为 undefined。 */
export const segmentsLength = (
  segments: readonly Segment[],
  lengthOf: (jobId: string) => number | undefined,
): number | undefined => {
  let total = 0
  for (const { sourceJobId, start, end } of segments) {
    const until = end ?? lengthOf(sourceJobId)
    if (until === undefined) return undefined
    total += until - start
  }
  return total
}

const sameTime = (left: number | null, right: number | null) =>
  left === null || right === null ? left === right : Math.abs(left - right) < EPSILON

export const sameSegments = (left: readonly Segment[], right: readonly Segment[]): boolean =>
  left.length === right.length &&
  left.every((segment, at) => {
    const other = right[at]
    return (
      other !== undefined &&
      segment.sourceJobId === other.sourceJobId &&
      sameTime(segment.start, other.start) &&
      sameTime(segment.end, other.end)
    )
  })

/**
 * 从最近一次合成推出选用：每条编辑段都用了整段且在轨上可用、原片的每段都是整几个镜头、编辑段彼此不重叠，
 * 选用就是这几条编辑段；有一处不符就是什么都不选。
 */
export const picksFromComposite = (
  segments: readonly Segment[] | undefined,
  rootJobId: string,
  shots: readonly Shot[],
  blocks: readonly EditBlock[],
): string[] => {
  if (segments === undefined) return []
  const near = (left: number, right: number) => Math.abs(left - right) <= WHOLE_TOLERANCE
  const lastEnd = shots.at(-1)?.end
  const picks: string[] = []
  for (const { sourceJobId, start, end } of segments) {
    if (sourceJobId !== rootJobId) {
      if (start !== 0 || end !== null) return []
      picks.push(sourceJobId)
      continue
    }
    const until = end ?? lastEnd
    const runOfShots =
      until !== undefined &&
      shots.some((shot) => near(shot.start, start)) &&
      shots.some((shot) => near(shot.end, until))
    if (!runOfShots) return []
  }
  return arePicksUsable(picks, blocks) ? picks : []
}

type ComposeCheck = {
  current: readonly Segment[]
  original: readonly Segment[]
  latest: readonly Segment[] | undefined
  composing: boolean
  busy: boolean
}

/** 能不能「合成新版本」：内容就是原片、和最近一次合成一样，或正在合成、正在提交时都不能。 */
export const canCompose = ({ current, original, latest, composing, busy }: ComposeCheck) =>
  !busy &&
  !composing &&
  !sameSegments(current, original) &&
  (latest === undefined || !sameSegments(current, latest))

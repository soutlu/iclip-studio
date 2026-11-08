import { roundToMs } from '../editing/clip'
import { keyframeRanges, type KeyframeIndex } from '../editing/keyframe-segments'
import {
  byCreation,
  isEditSegment,
  isFailedJob,
  type EditSegment,
} from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

const EPSILON = 0.001

export type Shot = { no: number; start: number; end: number }

export const shotsOf = (index: { keyframes: readonly number[]; duration: number }): Shot[] =>
  keyframeRanges(index).map((range, at) => ({
    no: at + 1,
    start: roundToMs(range.start),
    end: roundToMs(range.end),
  }))

export type ShotSpan = { from: number; to: number }

export const spanName = ({ from, to }: ShotSpan): string =>
  from === to ? `镜头 ${from}` : `镜头 ${from}–${to}`

const sameSpan = (left: ShotSpan, right: ShotSpan) =>
  left.from === right.from && left.to === right.to

type Span = { start: number; end: number }

const overlaps = (left: Span, right: Span) =>
  Math.min(left.end, right.end) - Math.max(left.start, right.start) > EPSILON

export const coveredSpan = (shots: readonly Shot[], { start, end }: Span): ShotSpan => {
  const from = shots.findLast((shot) => shot.start <= start + EPSILON)?.no ?? 1
  const to = shots.findLast((shot) => shot.start < end - EPSILON)?.no ?? from
  return { from, to: Math.max(from, to) }
}

export type CoveredEdit = ShotSpan & { job: EditSegment; start: number; end: number }

export type LaneEdit = CoveredEdit & {
  id: string
  row: number
  attempt: number | undefined
  name: string
}

export const editTitleOf = (edit: LaneEdit): string =>
  edit.attempt === undefined
    ? `${spanName(edit)} 的编辑片段`
    : `${spanName(edit)} 第 ${edit.attempt} 次生成的编辑片段`

const coveredEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): CoveredEdit[] =>
  jobs
    .filter(isEditSegment)
    .filter((job) => job.sourceJobId === rootJobId)
    .sort(byCreation)
    .map((job) => {
      const range = { start: job.rangeStartMs / 1000, end: job.rangeEndMs / 1000 }
      return { job, ...range, ...coveredSpan(shots, range) }
    })

export const laneEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): LaneEdit[] => {
  const edits = coveredEditsOf(rootJobId, jobs, shots).filter((edit) => !isFailedJob(edit.job))
  const rows: CoveredEdit[][] = []
  return edits.map((edit) => {
    let row = 0
    while (rows[row]?.some((other) => overlaps(other, edit)) === true) row += 1
    ;(rows[row] ??= []).push(edit)
    const same = edits.filter((other) => sameSpan(other, edit))
    const attempt = same.length > 1 ? same.indexOf(edit) + 1 : undefined
    const name = attempt === undefined ? spanName(edit) : `${spanName(edit)} · 第 ${attempt} 次`
    return { ...edit, id: edit.job.id, row, attempt, name }
  })
}

export const isRangeOf = (job: EditSegment, range: Span): boolean =>
  job.rangeStartMs === Math.round(range.start * 1000) &&
  job.rangeEndMs === Math.round(range.end * 1000)

export const failedEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): CoveredEdit[] => {
  const edits = coveredEditsOf(rootJobId, jobs, shots)
  return edits.filter(
    (edit) =>
      isFailedJob(edit.job) && edits.findLast((other) => isRangeOf(other.job, edit)) === edit,
  )
}

export const failureMessageOf = (job: GenerationJob): string =>
  job.errorMessage?.trim() || '未返回生成结果'

export type EditPart = { seg: number; b0: number; b1: number }

export type EditState =
  | { kind: 'running' }
  | { kind: 'measuring' }
  | { kind: 'unreadable' }
  | { kind: 'ready'; duration: number; parts: readonly EditPart[] }

export type EditBlock = LaneEdit & { state: EditState }

export type KeyframeRead = { data: KeyframeIndex | undefined; isError: boolean }

export const editStateOf = (job: GenerationJob, read: KeyframeRead | undefined): EditState => {
  if (isRunningStatus(job.status)) return { kind: 'running' }
  if (read?.isError === true) return { kind: 'unreadable' }
  const index = read?.data
  if (index === undefined) return { kind: 'measuring' }
  return {
    kind: 'ready',
    duration: index.duration,
    parts: keyframeRanges(index).map((range, at) => ({
      seg: at + 1,
      b0: roundToMs(range.start),
      b1: roundToMs(range.end),
    })),
  }
}

export type LanePart = {
  id: string
  block: EditBlock
  part: EditPart | undefined
  at: number
  len: number
}

export const partItemId = (editId: string, seg: number) => `${editId}#${seg}`

export const lanePartsOf = (blocks: readonly EditBlock[]): LanePart[] =>
  blocks.flatMap((block): LanePart[] => {
    const span = block.end - block.start
    if (block.state.kind !== 'ready')
      return [{ id: block.id, block, part: undefined, at: block.start, len: span }]
    const { duration, parts } = block.state
    return parts.map((part) => ({
      id: partItemId(block.id, part.seg),
      block,
      part,
      at: block.start + (part.b0 / duration) * span,
      len: ((part.b1 - part.b0) / duration) * span,
    }))
  })

export const editBlocksOf = (
  lane: readonly LaneEdit[],
  readOf: (url: string) => KeyframeRead | undefined,
): EditBlock[] =>
  lane.map((edit) => ({
    ...edit,
    state: editStateOf(
      edit.job,
      edit.job.outputUrl === null ? undefined : readOf(edit.job.outputUrl),
    ),
  }))

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

/** 比较时间用的容差（秒）：渲染与关键帧读数取到毫秒。 */
const EPSILON = 0.001

/** 原片的一个镜头：关键帧之间的一段，`no` 从 1 起。 */
export type Shot = { no: number; start: number; end: number }

export const shotsOf = (index: { keyframes: readonly number[]; duration: number }): Shot[] =>
  keyframeRanges(index).map((range, at) => ({
    no: at + 1,
    start: roundToMs(range.start),
    end: roundToMs(range.end),
  }))

/** 一串相连镜头，按镜头号首尾。 */
export type ShotSpan = { from: number; to: number }

export const spanName = ({ from, to }: ShotSpan): string =>
  from === to ? `镜头 ${from}` : `镜头 ${from}–${to}`

const sameSpan = (left: ShotSpan, right: ShotSpan) =>
  left.from === right.from && left.to === right.to

type Span = { start: number; end: number }

const overlaps = (left: Span, right: Span) =>
  Math.min(left.end, right.end) - Math.max(left.start, right.start) > EPSILON

/** 原片区间碰到的镜头，盖到一部分也算；区间落在原片之外时取离它最近的镜头。 */
export const coveredSpan = (shots: readonly Shot[], { start, end }: Span): ShotSpan => {
  const from = shots.findLast((shot) => shot.start <= start + EPSILON)?.no ?? 1
  const to = shots.findLast((shot) => shot.start < end - EPSILON)?.no ?? from
  return { from, to: Math.max(from, to) }
}

/** 直接基于原片的一条编辑段：区间按原片时间（秒），镜头是区间碰到的那几个。 */
export type CoveredEdit = ShotSpan & { job: EditSegment; start: number; end: number }

/** 编辑轨上的一条编辑片段。 */
export type LaneEdit = CoveredEdit & {
  id: string
  /** 编辑轨上的第几行，从 0 起；按生成先后定下，不随选用变。 */
  row: number
  /** 同样几个镜头在编辑轨上不止一条时是第几次，从 1 起；只有一条时为 undefined。 */
  attempt: number | undefined
  /** 「镜头 3–6」，有第几次时再加「· 第 N 次」。 */
  name: string
}

/** 「镜头 4–5 的编辑片段」，有第几次时是「镜头 4–5 第 2 次生成的编辑片段」。 */
export const editTitleOf = (edit: LaneEdit): string =>
  edit.attempt === undefined
    ? `${spanName(edit)} 的编辑片段`
    : `${spanName(edit)} 第 ${edit.attempt} 次生成的编辑片段`

/** 直接基于原片 `rootJobId` 的编辑段，按生成先后；基于合成做的不算。 */
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

/**
 * 编辑轨：没失败的编辑段，按生成先后。每条按它的区间放进第一个与已放的不重叠的行；
 * 同样几个镜头按生成先后编第几次，在跑的也算，失败的不算。
 */
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

/** 编辑段的生成区间正是原片上的 `range`（秒）：按提交时取整到的毫秒比较。 */
export const isRangeOf = (job: EditSegment, range: Span): boolean =>
  job.rangeStartMs === Math.round(range.start * 1000) &&
  job.rangeEndMs === Math.round(range.end * 1000)

/** 失败的编辑段，只取对这个区间最近的一次：之后对完全相同的区间又提交过生成，前面的失败就不算了。 */
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

/** 编辑段失败的原因；任务没给就说没出结果。 */
export const failureMessageOf = (job: GenerationJob): string =>
  job.errorMessage?.trim() || '未返回生成结果'

/** 编辑片段按它自己文件的关键帧切成的一段：`seg` 从 1 起，`b0`–`b1` 是编辑片段自己的时间（秒）。 */
export type EditPart = { seg: number; b0: number; b1: number }

/** 编辑轨上的编辑片段此刻的样子：在跑、关键帧读取中、读不出，或可以选用（带时长与各段）。 */
export type EditState =
  | { kind: 'running' }
  | { kind: 'measuring' }
  | { kind: 'unreadable' }
  | { kind: 'ready'; duration: number; parts: readonly EditPart[] }

export type EditBlock = LaneEdit & { state: EditState }

/** 一条结果的关键帧读到哪了：同 react-query 的结果，读好了有 `data`，读不出 `isError`。 */
export type KeyframeRead = { data: KeyframeIndex | undefined; isError: boolean }

export const editStateOf = (job: GenerationJob, read: KeyframeRead | undefined): EditState => {
  if (isRunningStatus(job.status)) return { kind: 'running' }
  // 失败的不在编辑轨上（见 laneEditsOf），走到这里的都有结果地址。
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

/**
 * 编辑轨上的一块：完成的编辑片段每段一块，按段长占它那条宽度里的一份；在跑、读取中、读不出的整条一块（`part` 为
 * undefined）。`at`、`len` 按原片时间（秒），是它在编辑轨上的横向位置。
 */
export type LanePart = {
  id: string
  block: EditBlock
  part: EditPart | undefined
  at: number
  len: number
}

/** 编辑段的标识：编辑轨上那一块与它在草稿里那块共用。 */
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

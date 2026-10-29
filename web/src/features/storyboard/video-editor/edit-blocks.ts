import { roundToMs } from '../editing/clip'
import { keyframeRanges } from '../editing/keyframe-segments'
import type { MediaDurations } from '../editing/use-media-durations'
import {
  byCreation,
  isEditSegment,
  isFailedJob,
  type EditSegment,
} from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

/** 编辑段的起止与镜头边界差在这以内就算对齐（秒）。 */
const ALIGN_TOLERANCE = 0.05

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

export const spansOverlap = (left: ShotSpan, right: ShotSpan): boolean =>
  left.from <= right.to && right.from <= left.to

const sameSpan = (left: ShotSpan, right: ShotSpan) =>
  left.from === right.from && left.to === right.to

/** 对齐到镜头边界的一条编辑段：替换原片上的几个镜头，起止是镜头边界（原片时间）。 */
export type AlignedEdit = ShotSpan & { job: EditSegment; start: number; end: number }

/** 编辑轨上的一条编辑片段。 */
export type LaneEdit = AlignedEdit & {
  id: string
  /** 编辑轨上的第几行，从 0 起；按生成先后定下，不随选用变。 */
  row: number
  /** 「镜头 3–6」，同样几个镜头生成过不止一次时再加「· 第 N 次」。 */
  name: string
}

const near = (left: number, right: number) => Math.abs(left - right) <= ALIGN_TOLERANCE

/** 直接基于原片 `rootJobId`、起止都对得上镜头边界的编辑段，按生成先后；对不上的、基于合成做的都不算。 */
const alignedEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): AlignedEdit[] =>
  jobs
    .filter(isEditSegment)
    .filter((job) => job.sourceJobId === rootJobId)
    .sort(byCreation)
    .flatMap((job) => {
      const first = shots.find((shot) => near(shot.start, job.rangeStartMs / 1000))
      const last = shots.find((shot) => near(shot.end, job.rangeEndMs / 1000))
      if (first === undefined || last === undefined || first.no > last.no) return []
      return [{ job, from: first.no, to: last.no, start: first.start, end: last.end }]
    })

/**
 * 编辑轨：对齐镜头的编辑段里没失败的，按生成先后。每条放进第一个跟已放的不重叠的行；
 * 同样几个镜头按生成先后编第几次，在跑的也算，失败的不算。
 */
export const laneEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): LaneEdit[] => {
  const aligned = alignedEditsOf(rootJobId, jobs, shots).filter((edit) => !isFailedJob(edit.job))
  const rows: ShotSpan[][] = []
  return aligned.map((edit) => {
    let row = 0
    while (rows[row]?.some((other) => spansOverlap(other, edit)) === true) row += 1
    ;(rows[row] ??= []).push(edit)
    const same = aligned.filter((other) => sameSpan(other, edit))
    const attempt = same.length > 1 ? ` · 第 ${same.indexOf(edit) + 1} 次` : ''
    return { ...edit, id: edit.job.id, row, name: `${spanName(edit)}${attempt}` }
  })
}

/** 失败的编辑段，只取对这几个镜头最近的一次：之后对同样几个镜头又提交过生成，前面的失败就不算了。 */
export const failedEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): AlignedEdit[] => {
  const aligned = alignedEditsOf(rootJobId, jobs, shots)
  return aligned.filter(
    (edit) => isFailedJob(edit.job) && aligned.findLast((other) => sameSpan(other, edit)) === edit,
  )
}

/** 编辑段失败的原因；任务没给就说没出结果。 */
export const failureMessageOf = (job: GenerationJob): string =>
  job.errorMessage?.trim() || '未返回生成结果'

/** 编辑轨上的编辑片段此刻的样子：在跑、读时长中、读不出时长，或可以选用（带实测时长，秒）。 */
export type BlockState =
  | { kind: 'running' }
  | { kind: 'measuring' }
  | { kind: 'unreadable' }
  | { kind: 'ready'; duration: number }

export type EditBlock = LaneEdit & { state: BlockState }

export const blockStateOf = (job: GenerationJob, durations: MediaDurations): BlockState => {
  if (isRunningStatus(job.status)) return { kind: 'running' }
  // 失败的不在编辑轨上（见 laneEditsOf），走到这里的都有结果地址。
  const duration = job.outputUrl === null ? null : durations[job.outputUrl]
  if (duration === null) return { kind: 'unreadable' }
  return duration === undefined ? { kind: 'measuring' } : { kind: 'ready', duration }
}

export const editBlocksOf = (lane: readonly LaneEdit[], durations: MediaDurations): EditBlock[] =>
  lane.map((edit) => ({ ...edit, state: blockStateOf(edit.job, durations) }))

/** 还没落定：在跑或时长还在读，结果出来前不能选用。 */
export const isSettling = (state: BlockState): boolean =>
  state.kind === 'running' || state.kind === 'measuring'

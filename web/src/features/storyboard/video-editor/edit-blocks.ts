import { roundToMs } from '../editing/clip'
import { keyframeRanges } from '../editing/keyframe-segments'
import type { MediaDurations } from '../editing/use-media-durations'
import { byCreation, isEditSegment, type EditSegment } from '../editing/version-lineage'
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

/** 编辑轨上的一条编辑片段：替换原片上对齐的那几个镜头，起止是镜头边界（原片时间）。 */
export type LaneEdit = ShotSpan & {
  id: string
  job: EditSegment
  start: number
  end: number
  /** 编辑轨上的第几行，从 0 起；按生成先后定下，不随选用变。 */
  row: number
  /** 「镜头 3–6」，同样几个镜头生成过不止一次时再加「· 第 N 次」。 */
  name: string
}

const near = (left: number, right: number) => Math.abs(left - right) <= ALIGN_TOLERANCE

/**
 * 编辑轨：直接基于原片 `rootJobId`、起止都对得上镜头边界的编辑段，按生成先后。对不上的、
 * 基于合成做的都不在轨上。每条放进第一个跟已放的不重叠的行；同样几个镜头按生成先后编第几次，
 * 在跑的和失败的也算。
 */
export const laneEditsOf = (
  rootJobId: string,
  jobs: readonly GenerationJob[],
  shots: readonly Shot[],
): LaneEdit[] => {
  const aligned = jobs
    .filter(isEditSegment)
    .filter((job) => job.sourceJobId === rootJobId)
    .sort(byCreation)
    .flatMap((job) => {
      const first = shots.find((shot) => near(shot.start, job.rangeStartMs / 1000))
      const last = shots.find((shot) => near(shot.end, job.rangeEndMs / 1000))
      if (first === undefined || last === undefined || first.no > last.no) return []
      return [{ job, from: first.no, to: last.no, start: first.start, end: last.end }]
    })
  const rows: ShotSpan[][] = []
  return aligned.map((edit) => {
    let row = 0
    while (rows[row]?.some((other) => spansOverlap(other, edit)) === true) row += 1
    ;(rows[row] ??= []).push(edit)
    const same = aligned.filter((other) => other.from === edit.from && other.to === edit.to)
    const attempt = same.length > 1 ? ` · 第 ${same.indexOf(edit) + 1} 次` : ''
    return { ...edit, id: edit.job.id, row, name: `${spanName(edit)}${attempt}` }
  })
}

/** 编辑片段此刻的样子：在跑、读时长中、失败、读不出时长，或可以选用（带实测时长，秒）。 */
export type BlockState =
  | { kind: 'running' }
  | { kind: 'measuring' }
  | { kind: 'failed'; message: string }
  | { kind: 'unreadable' }
  | { kind: 'ready'; duration: number }

export type EditBlock = LaneEdit & { state: BlockState }

export const blockStateOf = (job: GenerationJob, durations: MediaDurations): BlockState => {
  if (isRunningStatus(job.status)) return { kind: 'running' }
  const message = job.errorMessage ?? '未返回生成结果'
  if (job.status !== 'completed' || job.outputUrl === null) return { kind: 'failed', message }
  const duration = durations[job.outputUrl]
  if (duration === null) return { kind: 'unreadable' }
  return duration === undefined ? { kind: 'measuring' } : { kind: 'ready', duration }
}

export const editBlocksOf = (lane: readonly LaneEdit[], durations: MediaDurations): EditBlock[] =>
  lane.map((edit) => ({ ...edit, state: blockStateOf(edit.job, durations) }))

/** 还没落定：在跑或时长还在读，结果出来前不能选用。 */
export const isSettling = (state: BlockState): boolean =>
  state.kind === 'running' || state.kind === 'measuring'

import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

export type EditSegment = GenerationJob & {
  sourceJobId: string
  rangeStartMs: number
  rangeEndMs: number
}

export const isEditSegment = (job: GenerationJob): job is EditSegment =>
  job.kind === 'video' &&
  job.operation === 'generate' &&
  job.sourceJobId != null &&
  job.rangeStartMs != null &&
  job.rangeEndMs != null

export const isComposite = (job: GenerationJob): job is GenerationJob & { sourceJobId: string } =>
  job.kind === 'video' && job.operation === 'compose' && job.sourceJobId != null

/** 落定了却没有结果：不在跑，也没有完成出地址。 */
export const isFailedJob = (job: GenerationJob): boolean =>
  !isRunningStatus(job.status) && (job.status !== 'completed' || job.outputUrl === null)

export const byCreation = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)

export const finishedAt = (job: GenerationJob): number =>
  Date.parse(job.finishedAt ?? job.createdAt)

export const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  finishedAt(left) - finishedAt(right) || left.id.localeCompare(right.id)

export const ORIGINAL_LABEL = '原片'

export const versionLabel = (ordinal: number): string => `V${ordinal}`

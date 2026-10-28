import type { GenerationJob } from '../storyboard.api'
import type { SecondsRange } from './clip'

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

export const byCreation = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)

export const finishedAt = (job: GenerationJob): number =>
  Date.parse(job.finishedAt ?? job.createdAt)

export const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  finishedAt(left) - finishedAt(right) || left.id.localeCompare(right.id)

export const rangeKey = (baseJobId: string, range: SecondsRange): string =>
  `${baseJobId}@${Math.round(range.start * 1000)}-${Math.round(range.end * 1000)}`

export const ORIGINAL_LABEL = '原片'

export const versionLabel = (ordinal: number): string => `V${ordinal}`

export const versionLabelAt = (index: number): string => versionLabel(index + 1)

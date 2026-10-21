import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { MediaDurations } from '../editing/use-media-durations'
import {
  byCreation,
  byFinish,
  isComposite,
  isEditSegment,
  ORIGINAL_LABEL,
  versionLabelAt,
} from '../editing/version-lineage'
import type { ClipVersionGroup } from './clip-versions'
import type { EditOutcome } from './draft'

export type ChainVersion = {
  jobId: string
  label: string
  mediaUrl: string
  sourceJobId: string | undefined
}

export const projectVersions = (
  root: GenerationJob,
  jobs: readonly GenerationJob[],
): ChainVersion[] => {
  if (root.outputUrl === null) return []
  const composites = jobs
    .filter(
      (job): job is GenerationJob & { sourceJobId: string; outputUrl: string } =>
        isComposite(job) && job.status === 'completed' && job.outputUrl !== null,
    )
    .sort(byFinish)
  return [
    { jobId: root.id, label: ORIGINAL_LABEL, mediaUrl: root.outputUrl, sourceJobId: undefined },
    ...composites.map((job, at) => ({
      jobId: job.id,
      label: versionLabelAt(at),
      mediaUrl: job.outputUrl,
      sourceJobId: job.sourceJobId,
    })),
  ]
}

export const unfinishedComposites = (
  versions: readonly ChainVersion[],
  jobs: readonly GenerationJob[],
): { job: GenerationJob; label: string }[] => {
  const completed = versions.length - 1
  return jobs
    .filter((job) => isComposite(job) && job.status !== 'completed')
    .sort(byCreation)
    .map((job, at) => ({ job, label: versionLabelAt(completed + at) }))
}

export const nextCompositeLabel = (
  versions: readonly ChainVersion[],
  jobs: readonly GenerationJob[],
): string => versionLabelAt(versions.length - 1 + unfinishedComposites(versions, jobs).length)

export const editLabelAt = (group: ClipVersionGroup, editJobId: string): string | undefined => {
  const at = group.edits.findIndex((edit) => edit.id === editJobId)
  return at < 0 ? undefined : versionLabelAt(at)
}

export const nextEditLabel = (group: ClipVersionGroup): string => versionLabelAt(group.edits.length)

export type EditStatus =
  | { kind: 'running' }
  | { kind: 'failed'; message: string }
  | { kind: 'no-result'; message: string }
  | { kind: 'unreadable' }
  | { kind: 'measuring' }
  | { kind: 'ready'; duration: number }

export const editStatusOf = (edit: GenerationJob, durations: MediaDurations): EditStatus => {
  if (isRunningStatus(edit.status)) return { kind: 'running' }
  const message = edit.errorMessage ?? '未返回生成结果'
  if (edit.status === 'failed') return { kind: 'failed', message }
  if (edit.status !== 'completed' || edit.outputUrl === null) return { kind: 'no-result', message }
  const duration = durations[edit.outputUrl]
  if (duration === null) return { kind: 'unreadable' }
  return duration === undefined ? { kind: 'measuring' } : { kind: 'ready', duration }
}

export const editOutcomeOf = (status: EditStatus): EditOutcome => {
  switch (status.kind) {
    case 'running':
    case 'measuring':
      return { kind: 'running' }
    case 'failed':
    case 'no-result':
      return { kind: 'failed', message: status.message }
    case 'unreadable':
      return { kind: 'failed', message: '结果时长读取失败' }
    case 'ready':
      return { kind: 'done', duration: status.duration }
  }
}

export const composingOf = (
  jobs: readonly GenerationJob[],
  versionJobId: string,
): GenerationJob | undefined =>
  jobs
    .filter(
      (job) => isComposite(job) && job.sourceJobId === versionJobId && isRunningStatus(job.status),
    )
    .sort(byCreation)
    .at(-1)

export const editCountsByRoot = (jobs: readonly GenerationJob[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    if (!isEditSegment(job) || job.status !== 'completed' || job.rootJobId === null) continue
    counts.set(job.rootJobId, (counts.get(job.rootJobId) ?? 0) + 1)
  }
  return counts
}

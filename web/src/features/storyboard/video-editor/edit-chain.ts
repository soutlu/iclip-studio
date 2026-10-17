import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  byCreation,
  byFinish,
  isComposite,
  isEditSegment,
  ORIGINAL_LABEL,
  versionLabel,
} from '../editing/version-lineage'

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
      label: versionLabel(at + 1),
      mediaUrl: job.outputUrl,
      sourceJobId: job.sourceJobId,
    })),
  ]
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

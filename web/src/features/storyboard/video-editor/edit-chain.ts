import {
  groupConversationVideos,
  versionNameOf,
  type ConversationVideoGroup,
} from '../conversation-videos/video-groups'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  byCreation,
  byFinish,
  isComposite,
  isEditSegment,
  isFailedJob,
} from '../editing/version-lineage'

export type ChainVersion = {
  jobId: string
  label: string
  mediaUrl: string
}

export const rootVersionGroup = (
  root: GenerationJob,
  chainJobs: readonly GenerationJob[],
  conversationJobs: readonly GenerationJob[],
): ConversationVideoGroup | undefined => {
  const others = conversationJobs.filter((job) => job.id !== root.id && job.rootJobId !== root.id)
  return groupConversationVideos([root, ...chainJobs, ...others]).find((group) =>
    group.videos.some((video) => video.id === root.id),
  )
}

export const projectVersions = (
  root: GenerationJob,
  group: ConversationVideoGroup | undefined,
): ChainVersion[] =>
  (group?.videos ?? [])
    .filter((video) => video.id === root.id || video.rootJobId === root.id)
    .map((video) => ({
      jobId: video.id,
      label: versionNameOf(video),
      mediaUrl: video.outputUrl,
    }))

const rootComposites = (jobs: readonly GenerationJob[], rootJobId: string) =>
  jobs.filter((job) => isComposite(job) && job.sourceJobId === rootJobId)

export const latestCompositeOf = (
  jobs: readonly GenerationJob[],
  rootJobId: string,
): GenerationJob | undefined =>
  rootComposites(jobs, rootJobId)
    .filter((job) => job.status === 'completed' && job.outputUrl !== null)
    .sort(byFinish)
    .at(-1)

export const composingOf = (
  jobs: readonly GenerationJob[],
  rootJobId: string,
): GenerationJob | undefined =>
  rootComposites(jobs, rootJobId)
    .filter((job) => isRunningStatus(job.status))
    .sort(byCreation)
    .at(-1)

export const failedCompositeOf = (
  jobs: readonly GenerationJob[],
  rootJobId: string,
): GenerationJob | undefined => {
  const last = rootComposites(jobs, rootJobId).sort(byCreation).at(-1)
  return last !== undefined && isFailedJob(last) ? last : undefined
}

export const editCountsByRoot = (jobs: readonly GenerationJob[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    if (!isEditSegment(job) || job.status !== 'completed' || job.rootJobId === null) continue
    counts.set(job.rootJobId, (counts.get(job.rootJobId) ?? 0) + 1)
  }
  return counts
}

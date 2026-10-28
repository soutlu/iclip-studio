import {
  groupConversationVideos,
  versionNameOf,
  type ConversationVideoGroup,
} from '../conversation-videos/video-groups'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import { byCreation, byFinish, isComposite, isEditSegment } from '../editing/version-lineage'

export type ChainVersion = {
  jobId: string
  label: string
  mediaUrl: string
}

/**
 * 原作 root 所在的版本组。这条原作的合成以编辑链 chainJobs 为准（提交后立刻写进、刷新最及时），
 * 组里其余原作与合成取本对话视频记录 conversationJobs；root 没出片时为 undefined。
 */
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

/** 整条的各版：这条原作与它完成的合成，按完成先后，名字沿用版本组的编号，所以编号可以不连续。 */
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

/** 直接基于原片 rootJobId 的合成：只有它们能推出选用、能跟现在的合成内容比。 */
const rootComposites = (jobs: readonly GenerationJob[], rootJobId: string) =>
  jobs.filter((job) => isComposite(job) && job.sourceJobId === rootJobId)

/** 基于原片最近完成的那次合成。 */
export const latestCompositeOf = (
  jobs: readonly GenerationJob[],
  rootJobId: string,
): GenerationJob | undefined =>
  rootComposites(jobs, rootJobId)
    .filter((job) => job.status === 'completed' && job.outputUrl !== null)
    .sort(byFinish)
    .at(-1)

/** 基于原片、还在合成的那次（取最近提交的）。 */
export const composingOf = (
  jobs: readonly GenerationJob[],
  rootJobId: string,
): GenerationJob | undefined =>
  rootComposites(jobs, rootJobId)
    .filter((job) => isRunningStatus(job.status))
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

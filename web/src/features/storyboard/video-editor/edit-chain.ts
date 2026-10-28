import {
  groupConversationVideos,
  versionNameOf,
  type ConversationVideoGroup,
} from '../conversation-videos/video-groups'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { MediaDurations } from '../editing/use-media-durations'
import {
  byCreation,
  isComposite,
  isEditSegment,
  versionLabel,
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
      sourceJobId: video.sourceJobId ?? undefined,
    }))

/** 这条原作还没完成的合成，按提交先后预先接在版本组已有版本之后编号。 */
export const unfinishedComposites = (
  group: ConversationVideoGroup | undefined,
  jobs: readonly GenerationJob[],
): { job: GenerationJob; label: string }[] => {
  const completed = group?.videos.length ?? 0
  return jobs
    .filter((job) => isComposite(job) && job.status !== 'completed')
    .sort(byCreation)
    .map((job, at) => ({ job, label: versionLabel(completed + at + 1) }))
}

/** 再合成一版时它预计拿到的版本名：排在版本组已有版本与未完成的合成之后。 */
export const nextCompositeLabel = (
  group: ConversationVideoGroup | undefined,
  jobs: readonly GenerationJob[],
): string =>
  versionLabel((group?.videos.length ?? 0) + unfinishedComposites(group, jobs).length + 1)

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

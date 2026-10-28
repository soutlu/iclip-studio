import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { VersionStripEntry } from '../editing/editor-version-strip'
import { byCreation, isComposite } from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { ChainVersion } from './edit-chain'

export const posterOf = (url: string) => videoSnapshotUrl(url, 320)

/**
 * 整条的版本条，新的在上：原片与完成的合成按版本组编号；没完成的合成（在跑、失败）排在后面，
 * 不预先编号，在跑的不能点，失败的点了在舞台上看原因。
 */
export const wholeStripEntries = (
  root: GenerationJob,
  versions: readonly ChainVersion[],
  chainJobs: readonly GenerationJob[],
): VersionStripEntry[] => {
  const unfinished = chainJobs
    .filter((job) => isComposite(job) && job.rootJobId === root.id && job.status !== 'completed')
    .sort(byCreation)
  const poster = root.outputUrl === null ? undefined : posterOf(root.outputUrl)
  return [
    ...versions.map((version): VersionStripEntry => ({
      key: version.jobId,
      label: version.label,
      name: version.label,
      poster: posterOf(version.mediaUrl),
      running: undefined,
      unseen: false,
    })),
    ...unfinished.map((job): VersionStripEntry => {
      const running = isRunningStatus(job.status)
      return {
        key: job.id,
        label: undefined,
        name: running ? '合成中' : '合成失败',
        poster,
        running: running ? { since: job.createdAt, label: '合成中' } : undefined,
        failed: !running,
        disabled: running,
        unseen: false,
      }
    }),
  ].reverse()
}

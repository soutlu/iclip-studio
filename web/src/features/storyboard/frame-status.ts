import { mediaStatusLabel, type MediaBadgeStatus } from '@/shared/ui/status-badge'
import { readStoryboardMetadata } from './generation-metadata'
import type { Shot } from './shot-document'
import { phaseOfStatus } from './shots'
import type { GenerationJob } from './storyboard.api'

export type FrameBadge =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'result'; jobId: string }

export const frameBadgeText = (badge: FrameBadge): string =>
  badge.kind === 'result' ? '有新结果' : mediaStatusLabel(badge.kind)

export const frameBadgeStatus = (badge: FrameBadge): MediaBadgeStatus =>
  badge.kind === 'result' ? 'completed' : badge.kind

export const frameJobKey = (shotIndex: number, frameNumber: number) => `${shotIndex}:${frameNumber}`

export const isAppliedResult = (job: GenerationJob, currentUrl: string): boolean =>
  job.outputUrl !== null && job.outputUrl === currentUrl

export const latestFrameJobs = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs) {
    const at = readStoryboardMetadata(job)
    if (job.kind !== 'image' || at === undefined || at.frame === undefined) continue
    const key = frameJobKey(at.shot, at.frame)
    if (!latest.has(key)) latest.set(key, job)
  }
  return latest
}

export const frameBadgeOf = (
  job: GenerationJob | undefined,
  url: string,
  seen: ReadonlySet<string>,
): FrameBadge | undefined => {
  if (job === undefined) return undefined
  const phase = phaseOfStatus(job.status)
  if (phase === 'queued' || phase === 'running') return { kind: phase }
  if (seen.has(job.id)) return undefined
  if (phase === 'failed') return { kind: 'failed', message: job.errorMessage }
  if (job.outputUrl !== null && !isAppliedResult(job, url)) return { kind: 'result', jobId: job.id }
  return undefined
}

export const frameBadges = (
  shot: Shot,
  latest: ReadonlyMap<string, GenerationJob>,
  seen: ReadonlySet<string>,
): ReadonlyMap<number, FrameBadge> => {
  const badges = new Map<number, FrameBadge>()
  shot.image_urls.forEach((url, position) => {
    const frameNumber = position + 1
    const badge = frameBadgeOf(latest.get(frameJobKey(shot.index, frameNumber)), url, seen)
    if (badge !== undefined) badges.set(frameNumber, badge)
  })
  return badges
}

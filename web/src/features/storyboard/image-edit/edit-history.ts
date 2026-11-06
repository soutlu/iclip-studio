import { formatDateTime } from '@/shared/lib/date-time'
import { mediaStatusLabel } from '@/shared/ui/status-badge'
import { isAppliedResult } from '../frame-status'
import { phaseOfStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'

export type StripEntry =
  | { kind: 'current'; key: 'current'; url: string; job: GenerationJob | null }
  | { kind: 'image'; key: string; url: string; job: GenerationJob | null; createdAt: string }
  | { kind: 'pending'; key: string; job: GenerationJob }
  | { kind: 'failed'; key: string; job: GenerationJob }

export const CURRENT_KEY = 'current'

type Seed = { url: string; job: GenerationJob | null; createdAt: string }

export function frameImageEntries(
  jobs: readonly GenerationJob[],
  currentUrl: string | null,
): StripEntry[] {
  const running: StripEntry[] = []
  const seeds = new Map<string, Seed>()
  let currentJob: GenerationJob | null = null

  const remember = (url: string, job: GenerationJob | null, createdAt: string) => {
    const seen = seeds.get(url)
    if (seen === undefined) seeds.set(url, { url, job, createdAt })
    else if (seen.job === null && job !== null) seeds.set(url, { url, job, createdAt })
    else if (seen.job === null && createdAt < seen.createdAt) seeds.set(url, { ...seen, createdAt })
  }

  for (const job of jobs) {
    const phase = phaseOfStatus(job.status)
    if (phase === 'queued' || phase === 'running')
      running.push({ kind: 'pending', key: job.id, job })
    else if (phase === 'failed') running.push({ kind: 'failed', key: job.id, job })
    else if (currentUrl !== null && isAppliedResult(job, currentUrl)) currentJob ??= job
    else if (job.outputUrl !== null) remember(job.outputUrl, job, job.createdAt)

    const base = job.sourceUrl
    if (base != null && base !== currentUrl) remember(base, null, job.createdAt)
  }

  const images = [...seeds.values()].map((seed): StripEntry => ({
    kind: 'image',
    key: seed.job?.id ?? seed.url,
    url: seed.url,
    job: seed.job,
    createdAt: seed.createdAt,
  }))
  const rest = [...running, ...images].sort((left, right) =>
    entryTime(right).localeCompare(entryTime(left)),
  )
  if (currentUrl === null) return rest
  return [{ kind: 'current', key: CURRENT_KEY, url: currentUrl, job: currentJob }, ...rest]
}

const entryTime = (entry: StripEntry): string =>
  entry.kind === 'current' ? '' : entry.kind === 'image' ? entry.createdAt : entry.job.createdAt

export const entryBaseUrl = (entry: StripEntry, currentUrl: string): string =>
  entry.kind === 'current' || entry.kind === 'image'
    ? entry.url
    : (entry.job.sourceUrl ?? currentUrl)

export function entryLabel(entry: StripEntry, current: string): string {
  if (entry.kind === 'current') return current
  if (entry.kind === 'image') return entry.job === null ? '上一版' : '结果'
  const phase = phaseOfStatus(entry.job.status)
  return phase === 'completed' ? '结果' : mediaStatusLabel(phase)
}

export function entryName(entry: StripEntry, current: string): string {
  if (entry.kind === 'current') return entryLabel(entry, current)
  const createdAt = entry.kind === 'image' ? entry.createdAt : entry.job.createdAt
  return `${entryLabel(entry, current)} · ${formatDateTime(createdAt)}`
}

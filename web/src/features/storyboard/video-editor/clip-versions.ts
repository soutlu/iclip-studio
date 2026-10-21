import type { GenerationJob } from '../storyboard.api'
import { roundToMs, type Clip, type SecondsRange } from '../editing/clip'
import { byCreation, isEditSegment, rangeKey } from '../editing/version-lineage'

export type ClipVersionGroup = {
  readonly key: string
  readonly baseJobId: string
  readonly start: number
  readonly end: number
  readonly edits: readonly GenerationJob[]
}

export const groupsForBase = (
  baseJobId: string,
  jobs: readonly GenerationJob[],
): readonly ClipVersionGroup[] => {
  const groups = new Map<string, ClipVersionGroup & { edits: GenerationJob[] }>()
  const edits = jobs
    .filter(isEditSegment)
    .filter((job) => job.sourceJobId === baseJobId)
    .sort(byCreation)
  for (const edit of edits) {
    const range = { start: edit.rangeStartMs / 1000, end: edit.rangeEndMs / 1000 }
    const key = rangeKey(baseJobId, range)
    const group = groups.get(key)
    if (group !== undefined) {
      group.edits.push(edit)
    } else {
      groups.set(key, { key, baseJobId, ...range, edits: [edit] })
    }
  }
  return [...groups.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
}

export const groupForRange = (
  range: SecondsRange,
  baseJobId: string,
  jobs: readonly GenerationJob[],
): ClipVersionGroup | undefined => {
  const key = rangeKey(baseJobId, range)
  return groupsForBase(baseJobId, jobs).find((group) => group.key === key)
}

export const baseRangeForClip = (
  clip: Clip,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): { start: number; end: number } | undefined => {
  if (clip.sourceJobId === baseJobId)
    return { start: roundToMs(clip.start), end: roundToMs(clip.end) }
  const edit = jobs.find((job) => job.id === clip.sourceJobId)
  if (edit === undefined || !isEditSegment(edit) || edit.sourceJobId !== baseJobId) return undefined
  const duration =
    durationOf?.(edit) ?? (edit.durationMs === null ? undefined : edit.durationMs / 1000)
  if (duration === undefined || duration <= 0 || clip.end > duration + 0.001) return undefined
  const baseStart = edit.rangeStartMs / 1000
  const span = (edit.rangeEndMs - edit.rangeStartMs) / 1000
  const start = roundToMs(baseStart + (clip.start / duration) * span)
  const end = roundToMs(baseStart + (Math.min(clip.end, duration) / duration) * span)
  return end > start ? { start, end } : undefined
}

export const groupForClip = (
  clip: Clip,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): ClipVersionGroup | undefined => {
  const range = baseRangeForClip(clip, baseJobId, jobs, durationOf)
  return range === undefined ? undefined : groupForRange(range, baseJobId, jobs)
}

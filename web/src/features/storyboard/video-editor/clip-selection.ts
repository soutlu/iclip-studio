import type { GenerationJob } from '../storyboard.api'
import type { Clip } from '../editing/clip'
import { rangeKey } from '../editing/version-lineage'
import { baseRangeForClip, groupForRange, type ClipVersionGroup } from './clip-versions'
import { clipItem, selectedRange, type Draft, type Edit, type Selection } from './draft'

export const selectedClips = (draft: Draft, selection: Selection): readonly Clip[] | undefined => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return undefined
  const items = draft.slice(range.from, range.to + 1)
  return items.every((item) => item.kind === 'clip')
    ? items.map(({ sourceJobId, start, end }) => ({ sourceJobId, start, end }))
    : undefined
}

export const selectedSource = (draft: Draft, selection: Selection): Clip | undefined => {
  const clips = selectedClips(draft, selection)
  const first = clips?.[0]
  const last = clips?.at(-1)
  if (clips === undefined || first === undefined || last === undefined) return undefined
  if (
    clips.some(
      (clip, at) =>
        clip.sourceJobId !== first.sourceJobId || (at > 0 && clips[at - 1]?.end !== clip.start),
    )
  )
    return undefined
  return { sourceJobId: first.sourceJobId, start: first.start, end: last.end }
}

export const selectedGroup = (
  draft: Draft,
  selection: Selection,
  baseJobId: string,
  jobs: readonly GenerationJob[],
  durationOf?: (job: GenerationJob) => number | undefined,
): ClipVersionGroup | undefined => {
  const clips = selectedClips(draft, selection)
  if (clips === undefined) return undefined
  const ranges = clips.map((clip) => baseRangeForClip(clip, baseJobId, jobs, durationOf))
  const first = ranges[0]
  const last = ranges.at(-1)
  if (first === undefined || last === undefined) return undefined
  if (
    ranges.some(
      (range, at) => range === undefined || (at > 0 && ranges[at - 1]?.end !== range.start),
    )
  )
    return undefined
  const range = { start: first.start, end: last.end }
  return (
    groupForRange(range, baseJobId, jobs) ?? {
      key: rangeKey(baseJobId, range),
      baseJobId,
      ...range,
      edits: [],
    }
  )
}

export const chooseClipVersion = (
  draft: Draft,
  selection: Selection,
  source: Clip,
): Edit | undefined => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return undefined
  const clip = clipItem(source)
  return {
    draft: [...draft.slice(0, range.from), clip, ...draft.slice(range.to + 1)],
    selection: [clip.id],
  }
}

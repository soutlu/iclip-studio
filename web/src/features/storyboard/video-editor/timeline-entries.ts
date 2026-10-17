import type { GenerationJob } from '../storyboard.api'
import type { PlaySegment } from '../editing/play-layout'
import { groupForClip, type ClipVersionGroup } from './clip-versions'
import { layoutDraft, type Draft, type DraftClip, type DraftItem } from './draft'
import { editLabelAt } from './edit-chain'
import type { TimelineEntry } from './editor-timeline'

export const versionTimelineEntries = (
  segments: readonly DraftClip[],
  mediaUrl: string,
): TimelineEntry[] =>
  layoutDraft(segments).map(({ item, at, duration }) => ({
    id: item.id,
    at,
    duration,
    parts: item.kind === 'clip' ? [{ mediaUrl, start: item.start, end: item.end }] : [],
    clip: item.kind === 'clip' ? item : undefined,
    changed: false,
    runningSince: undefined,
    versionLabel: undefined,
  }))

type DraftTimelineInput = {
  draft: Draft
  partsOf: (item: DraftItem) => PlaySegment[]
  groups: readonly ClipVersionGroup[]
  baseJobId: string
  jobs: readonly GenerationJob[]
  durationOf: (job: GenerationJob) => number | undefined
}

export const draftTimelineEntries = ({
  draft,
  partsOf,
  groups,
  baseJobId,
  jobs,
  durationOf,
}: DraftTimelineInput): TimelineEntry[] =>
  layoutDraft(draft).map(({ item, at, duration }) => {
    const clip = item.kind === 'clip' ? item : undefined
    const group =
      clip === undefined
        ? undefined
        : (groups.find((candidate) =>
            candidate.edits.some((edit) => edit.id === clip.sourceJobId),
          ) ?? groupForClip(clip, baseJobId, jobs, durationOf))
    return {
      id: item.id,
      at,
      duration,
      parts: partsOf(item),
      clip,
      changed: group !== undefined,
      runningSince: undefined,
      versionLabel:
        group === undefined || clip === undefined
          ? undefined
          : editLabelAt(group, clip.sourceJobId),
    }
  })

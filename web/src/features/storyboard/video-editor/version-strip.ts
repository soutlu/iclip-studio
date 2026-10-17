import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { Clip } from '../editing/clip'
import type { VersionStripEntry } from '../editing/editor-version-strip'
import type { PlaySegment } from '../editing/play-layout'
import { ORIGINAL_LABEL, versionLabelAt } from '../editing/version-lineage'
import type { ClipVersionGroup } from './clip-versions'
import type { ChainVersion, EditStatus } from './edit-chain'

export const CURRENT_SELECTION_KEY = 'current-selection'
const SUBMISSION_KEY = 'submitting'

export const posterOf = (url: string) => videoSnapshotUrl(url, 320)

export type Submission = {
  kind: 'edit' | 'compose'
  targetKey: string
  since: string
  label: string
}

type WholeStripInput = {
  versions: readonly ChainVersion[]
  unfinished: readonly { job: GenerationJob; label: string }[]
  baseMediaUrl: string
}

const wholeEntries = ({
  versions,
  unfinished,
  baseMediaUrl,
}: WholeStripInput): VersionStripEntry[] => [
  ...versions.map((item) => ({
    key: item.jobId,
    label: item.label,
    name: item.label,
    poster: posterOf(item.mediaUrl),
    running: undefined,
    unseen: false,
  })),
  ...unfinished.map(({ job, label }) => ({
    key: job.id,
    label,
    name: `${label} · ${job.status === 'failed' ? '合成失败' : '合成中'}`,
    poster: posterOf(baseMediaUrl),
    running: isRunningStatus(job.status) ? { since: job.createdAt, label: '合成中' } : undefined,
    failed: job.status === 'failed',
    disabled: true,
    unseen: false,
  })),
]

const EDIT_STATUS_NOTE: Partial<Record<EditStatus['kind'], string>> = {
  running: '生成中',
  failed: '失败',
  unreadable: '结果时长读取失败',
}

type ClipStripInput = {
  group: ClipVersionGroup
  baseMediaUrl: string
  statusOf: (edit: GenerationJob) => EditStatus
  isUnseen: (jobId: string) => boolean
}

const clipEntries = ({
  group,
  baseMediaUrl,
  statusOf,
  isUnseen,
}: ClipStripInput): VersionStripEntry[] => [
  {
    key: group.key,
    label: ORIGINAL_LABEL,
    name: ORIGINAL_LABEL,
    poster: videoSnapshotUrl(baseMediaUrl, 320, group.start),
    running: undefined,
    unseen: false,
  },
  ...group.edits.map((edit, at): VersionStripEntry => {
    const label = versionLabelAt(at)
    const status = statusOf(edit)
    const isNewResult = status.kind === 'ready' && isUnseen(edit.id)
    const note = EDIT_STATUS_NOTE[status.kind] ?? (isNewResult ? '新结果' : undefined)
    return {
      key: edit.id,
      label,
      name: note === undefined ? label : `${label} · ${note}`,
      poster: posterOf(edit.outputUrl ?? edit.sourceUrl ?? baseMediaUrl),
      running: status.kind === 'running' ? { since: edit.createdAt, label: '生成中' } : undefined,
      failed: status.kind === 'failed' || status.kind === 'unreadable',
      disabled: status.kind !== 'ready' && status.kind !== 'unreadable',
      unseen: isNewResult,
    }
  }),
]

type VersionStripInput = {
  view: 'whole' | 'clips' | 'version'
  changed: boolean
  baseJobId: string
  baseMediaUrl: string
  versions: readonly ChainVersion[]
  unfinishedComposites: readonly { job: GenerationJob; label: string }[]
  viewedJobId: string
  group: ClipVersionGroup | undefined
  source: Clip | undefined
  firstReference: PlaySegment | undefined
  statusOf: (edit: GenerationJob) => EditStatus
  isUnseen: (jobId: string) => boolean
  submission: Submission | undefined
}

export const projectVersionStrip = ({
  view,
  changed,
  baseJobId,
  baseMediaUrl,
  versions,
  unfinishedComposites,
  viewedJobId,
  group,
  source,
  firstReference,
  statusOf,
  isUnseen,
  submission,
}: VersionStripInput): { entries: VersionStripEntry[]; selectedKey: string } => {
  const viewingClips = view === 'clips'
  const hasCurrentCandidate =
    source !== undefined &&
    (source.sourceJobId === baseJobId ||
      group?.edits.some((edit) => edit.id === source.sourceJobId) === true)
  const entries = viewingClips
    ? group === undefined
      ? []
      : clipEntries({ group, baseMediaUrl, statusOf, isUnseen })
    : wholeEntries({ versions, unfinished: unfinishedComposites, baseMediaUrl })
  if (viewingClips && group !== undefined && !hasCurrentCandidate)
    entries.push({
      key: CURRENT_SELECTION_KEY,
      label: '当前',
      name: '当前选用',
      poster:
        firstReference === undefined
          ? undefined
          : videoSnapshotUrl(firstReference.mediaUrl, 320, firstReference.start),
      running: undefined,
      unseen: false,
    })
  const showsSubmission =
    submission !== undefined &&
    (viewingClips
      ? submission.kind === 'edit' && submission.targetKey === group?.key
      : submission.kind === 'compose')
  if (showsSubmission)
    entries.push({
      key: SUBMISSION_KEY,
      label: submission.label,
      name: `${submission.label} · 提交中`,
      poster: posterOf(firstReference?.mediaUrl ?? baseMediaUrl),
      running: { since: submission.since, label: '提交中' },
      disabled: true,
      unseen: false,
    })
  entries.reverse()

  const selectedKey = viewingClips
    ? !hasCurrentCandidate
      ? CURRENT_SELECTION_KEY
      : source?.sourceJobId === baseJobId
        ? (group?.key ?? '')
        : (source?.sourceJobId ?? '')
    : view === 'version'
      ? viewedJobId
      : changed
        ? ''
        : baseJobId
  return { entries, selectedKey }
}

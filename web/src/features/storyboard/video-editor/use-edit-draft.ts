import { useEffect, useEffectEvent, useState } from 'react'
import { readStored } from '../editing/browser-storage'
import { commit, redo, undo } from '../editing/edit-history'
import type { EditSegment } from '../editing/version-lineage'
import type { GenerationJob } from '../storyboard.api'
import { groupsForBase } from './clip-versions'
import {
  draftSources,
  isUnchanged,
  mergeSelection,
  parseStoredDraft,
  rebuildDraft,
  reselect,
  resolveHistory,
  serializeDraft,
  startDraftHistory,
  type Draft,
  type DraftClip,
  type DraftHistory,
  type Edit,
  type EditOutcome,
  type Selection,
} from './draft'
import type { ChainVersion } from './edit-chain'

type Entry = {
  segments: readonly DraftClip[]
  history: DraftHistory
  composite: string | undefined
}

export const draftStorageKey = (conversationId: string, versionJobId: string) =>
  `video-editor-draft:${conversationId}:${versionJobId}`

const UNREADABLE = '剪辑选择读取失败，已恢复原片；生成结果仍可在片段版本中选择'

const writeStored = (key: string, entry: Entry) => {
  const { draft } = entry.history.present
  window.localStorage.setItem(key, serializeDraft({ draft, composite: entry.composite }))
}

const compositeVerdict = (
  jobs: readonly GenerationJob[],
  compositeId: string,
  label?: string,
): { kind: 'waiting' } | { kind: 'done'; jobId: string } | { kind: 'dropped'; message: string } => {
  const job = jobs.find((item) => item.id === compositeId)
  if (job === undefined)
    return {
      kind: 'dropped',
      message: `未找到${label === undefined ? '' : ` ${label} `}上次提交的合成，可重新合成`,
    }
  if (job.status === 'completed' && job.outputUrl !== null) return { kind: 'done', jobId: job.id }
  if (job.status === 'completed' || job.status === 'failed')
    return {
      kind: 'dropped',
      message: `${label === undefined ? '' : `${label} `}合成失败：${job.errorMessage ?? '未返回生成结果'}`,
    }
  return { kind: 'waiting' }
}

const loadEntry = (
  key: string,
  version: ChainVersion,
  segments: readonly DraftClip[],
  jobs: readonly GenerationJob[],
  edits: readonly EditSegment[],
): { entry: Entry; notice: string | undefined } => {
  const fresh = (draft: Draft, composite?: string): Entry => ({
    segments,
    history: startDraftHistory(draft),
    composite,
  })
  const rebuilt = () =>
    fresh(
      rebuildDraft(
        segments,
        groupsForBase(version.jobId, jobs).flatMap((group) => {
          const latest =
            group.edits.filter((edit) => edit.status !== 'failed').at(-1) ?? group.edits.at(-1)
          return latest === undefined
            ? []
            : [
                {
                  id: latest.id,
                  rangeStartMs: Math.round(group.start * 1000),
                  rangeEndMs: Math.round(group.end * 1000),
                  createdAt: latest.createdAt,
                  failed: latest.status === 'failed',
                },
              ]
        }),
      ),
    )
  const raw = readStored(key)
  if (raw === null) return { entry: rebuilt(), notice: undefined }
  const stored = parseStoredDraft(raw)
  const known = new Set([version.jobId, ...edits.map((edit) => edit.id)])
  if (stored === undefined || [...draftSources(stored.draft)].some((id) => !known.has(id)))
    return { entry: rebuilt(), notice: UNREADABLE }
  return { entry: fresh(stored.draft, stored.composite), notice: undefined }
}

type Args = {
  conversationId: string
  version: ChainVersion
  versions: readonly ChainVersion[]
  segments: readonly DraftClip[] | undefined
  jobs: readonly GenerationJob[] | undefined
  edits: readonly EditSegment[]
  outcomeOf: (editJobId: string) => EditOutcome | undefined
  onNotice: (message: string) => void
  onStorageFailure: () => void
  onComposed: (compositeJobId: string) => void
}

export type EditDraft = {
  draft: Draft
  selection: Selection
  segments: readonly DraftClip[]
  changed: boolean
  canUndo: boolean
  canRedo: boolean
  composite: string | undefined
  apply: (edit: Edit) => void
  select: (selection: Selection) => void
  undo: () => void
  redo: () => void
  submitted: () => void
  composing: (compositeJobId: string) => void
}

export function useEditDraft({
  conversationId,
  version,
  versions,
  segments,
  jobs,
  edits,
  outcomeOf,
  onNotice,
  onStorageFailure,
  onComposed,
}: Args): EditDraft | undefined {
  const [entries, setEntries] = useState<Readonly<Record<string, Entry>>>({})
  const versionJobId = version.jobId
  const putAt = (jobId: string, entry: Entry) =>
    setEntries((current) => ({ ...current, [jobId]: entry }))
  const put = (entry: Entry) => putAt(versionJobId, entry)

  let entry = entries[versionJobId]
  if (entry === undefined && segments !== undefined && jobs !== undefined) {
    const loaded = loadEntry(
      draftStorageKey(conversationId, versionJobId),
      version,
      segments,
      jobs,
      edits,
    )
    entry = loaded.entry
    put(entry)
    if (loaded.notice !== undefined) onNotice(loaded.notice)
  }
  if (entry !== undefined && jobs !== undefined) {
    const settled = resolveHistory(entry.history, outcomeOf)
    if (settled.history !== entry.history) {
      entry = { ...entry, history: settled.history }
      put(entry)
      for (const message of settled.failures) onNotice(`AI 修改失败：${message}，已恢复原来的段`)
    }
  }
  if (jobs !== undefined) {
    const waiting = { ...entries, ...(entry === undefined ? {} : { [versionJobId]: entry }) }
    for (const [jobId, waited] of Object.entries(waiting)) {
      if (waited.composite === undefined) continue
      const viewing = jobId === versionJobId
      const label = viewing ? undefined : versions.find((item) => item.jobId === jobId)?.label
      const verdict = compositeVerdict(jobs, waited.composite, label)
      if (verdict.kind === 'waiting') continue
      const next: Entry = { ...waited, composite: undefined }
      putAt(jobId, next)
      if (viewing) entry = next
      if (verdict.kind === 'dropped') onNotice(verdict.message)
      else if (viewing) onComposed(verdict.jobId)
    }
  }

  const reportStorageFailure = useEffectEvent(onStorageFailure)
  useEffect(() => {
    try {
      for (const [jobId, stored] of Object.entries(entries))
        writeStored(draftStorageKey(conversationId, jobId), stored)
    } catch {
      reportStorageFailure()
    }
  }, [entries, conversationId])

  if (entry === undefined) return undefined
  const { history, composite } = entry
  const change = (next: (current: Entry) => Entry) =>
    setEntries((current) => {
      const found = current[versionJobId]
      return found === undefined ? current : { ...current, [versionJobId]: next(found) }
    })
  const changeHistory = (next: (current: DraftHistory) => DraftHistory) =>
    change((current) => ({ ...current, history: next(current.history) }))
  return {
    draft: history.present.draft,
    selection: history.present.selection,
    segments: entry.segments,
    changed: !isUnchanged(history.present.draft, entry.segments),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    composite,
    apply: (edit) => changeHistory((current) => commit(current, edit)),
    select: (selection) => changeHistory((current) => reselect(current, selection)),
    undo: () => changeHistory(undo),
    redo: () => changeHistory(redo),
    submitted: () =>
      changeHistory((current) => {
        const grouped = mergeSelection(current.present.draft, current.present.selection)
        return grouped.draft === current.present.draft ? current : commit(current, grouped)
      }),
    composing: (compositeJobId) => change((current) => ({ ...current, composite: compositeJobId })),
  }
}

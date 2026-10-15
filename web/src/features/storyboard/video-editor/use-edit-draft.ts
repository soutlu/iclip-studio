/** 基底上的剪辑选择与撤销栈，按（对话，基底）存进浏览器。
 * 生成结果只作为候选；已有占位与合成的结论由服务端记录推出来。 */

import { useEffect, useEffectEvent, useState } from 'react'
import { commit, redo, undo } from '../edit-history'
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
import type { ChainVersion, EditSegment } from './edit-chain'

type Entry = {
  /** 这一版的关键帧分段：草稿等于它就是没改动。 */
  segments: readonly DraftClip[]
  history: DraftHistory
  /** 草稿已提交合成，等的是哪条；等着的时候不能再剪。 */
  composite: string | undefined
}

export const draftStorageKey = (conversationId: string, versionJobId: string) =>
  `video-editor-draft:${conversationId}:${versionJobId}`

const UNREADABLE = '剪辑选择读取失败，已恢复原片；生成结果仍可在片段版本中选择'

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 显式选回 V1 也要存，不能根据内容与原片相同就丢掉用户的选择。 */
const writeStored = (key: string, entry: Entry) => {
  const { draft } = entry.history.present
  window.localStorage.setItem(key, serializeDraft({ draft, composite: entry.composite }))
}

/** 合成有了结论就去掉等待，保留剪辑选择；失败与找不到时说出原因。
 * 不是正看着的那一版时给 `label`（V1、V2……），那句话说出是哪一版。 */
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

/** 优先恢复已保存的选择；没有时根据已有编辑区间组织原片，所有区间仍使用 V1。
 * 引用了基底编辑链之外的记录时恢复原片并提示；存着的合成等待交给装载后的落定。 */
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
  /** 全部版本：不在看的那一版合成有了结论时，提示里说出它是哪一版。 */
  versions: readonly ChainVersion[]
  /** 这一版的关键帧分段；还没读到时没有。 */
  segments: readonly DraftClip[] | undefined
  /** 编辑链上的记录；还没读到时没有。 */
  jobs: readonly GenerationJob[] | undefined
  /** 直接基于这一版的编辑段，包括使用先前结果作为参考生成的新候选。 */
  edits: readonly EditSegment[]
  /** 一条编辑段此刻的结论；完成了却还不知道结果多长时仍算在跑。 */
  outcomeOf: (editJobId: string) => EditOutcome | undefined
  /** 要让人看到的一句话：剪辑选择恢复、AI 修改失败、合成失败。 */
  onNotice: (message: string) => void
  /** 浏览器拒绝写入草稿；每次写失败都调，说几次由调用方定。 */
  onStorageFailure: () => void
  /** 正看着的这一版的草稿合成完成，成了新的一版；不在看的那一版合成完成时不调。 */
  onComposed: (compositeJobId: string) => void
}

export type EditDraft = {
  draft: Draft
  selection: Selection
  segments: readonly DraftClip[]
  /** 草稿与这一版不同。 */
  changed: boolean
  canUndo: boolean
  canRedo: boolean
  /** 等着的那次合成。 */
  composite: string | undefined
  apply: (edit: Edit) => void
  select: (selection: Selection) => void
  undo: () => void
  redo: () => void
  /** AI 已受理：同来源连续选区可归成一段；混合来源保留多段与选中，不代选结果。 */
  submitted: () => void
  /** 草稿提交了合成。 */
  composing: (compositeJobId: string) => void
}

/** 所看那一版的草稿；分段或编辑链还没读到时返回 `undefined`。 */
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

  // 装载与落定都在渲染里做：结论来自轮询的数据，就地对齐，不绕一轮 effect。
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
  // 等待中的合成逐一落定，保留时间线和选区；预览哪版由主组件决定。
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

  // 合成完成后仍写回原有选择，查看历史成片不会改变它。
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
  // 都按提交那一刻的最新状态改：提交 AI 改或合成要等网络，其间占位可能已经落定。
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

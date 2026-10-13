/** 每一版各自的剪辑草稿与撤销栈。草稿存进浏览器，按（对话，那一版）各一份；
 * 等于初始分段时不存。占位与合成的结论由服务端记录推出来，每次渲染落定一次。 */

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { GenerationJob } from '../storyboard.api'
import {
  commit,
  draftSources,
  isUnchanged,
  parseStoredDraft,
  rebuildDraft,
  redo,
  replaceWithPending,
  reselect,
  resolveHistory,
  serializeDraft,
  startHistory,
  undo,
  type Draft,
  type DraftClip,
  type DraftHistory,
  type Edit,
  type EditOutcome,
  type Selection,
} from './draft'
import { rebuildCandidates, type ChainVersion, type EditSegment } from './edit-chain'

type Entry = {
  /** 这一版的关键帧分段：草稿等于它就是没改动。 */
  segments: readonly DraftClip[]
  history: DraftHistory
  /** 草稿已提交合成，等的是哪条；等着的时候不能再剪。 */
  composite: string | undefined
}

export const draftStorageKey = (conversationId: string, versionJobId: string) =>
  `video-editor-draft:${conversationId}:${versionJobId}`

const UNREADABLE = '草稿读取失败，已根据 AI 生成结果重建'

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 没改动且没在等合成就不存（存过的删掉）；读写都可能被浏览器拒绝，由调用方说出来。 */
const writeStored = (key: string, entry: Entry) => {
  const { draft } = entry.history.present
  if (isUnchanged(draft, entry.segments) && entry.composite === undefined)
    window.localStorage.removeItem(key)
  else window.localStorage.setItem(key, serializeDraft({ draft, composite: entry.composite }))
}

/** 合成有了结论该怎么办：完成就清掉草稿，失败与找不到就留着草稿、去掉等待，并说一句为什么。 */
const compositeVerdict = (
  jobs: readonly GenerationJob[],
  compositeId: string,
): { kind: 'waiting' } | { kind: 'done'; jobId: string } | { kind: 'dropped'; message: string } => {
  const job = jobs.find((item) => item.id === compositeId)
  if (job === undefined) return { kind: 'dropped', message: '未找到上次提交的合成，可重新合成' }
  if (job.status === 'completed' && job.outputUrl !== null) return { kind: 'done', jobId: job.id }
  if (job.status === 'completed' || job.status === 'failed')
    return { kind: 'dropped', message: `合成失败：${job.errorMessage ?? '未返回生成结果'}` }
  return { kind: 'waiting' }
}

/** 第一次看某一版时装进它的草稿：读存着的；没有就按服务端重建；读不出或引用了这一版不认识的
 * 记录，也重建并说一声。存着的合成已经完成，草稿当场作废。 */
const loadEntry = (
  key: string,
  version: ChainVersion,
  segments: readonly DraftClip[],
  jobs: readonly GenerationJob[],
  edits: readonly EditSegment[],
): { entry: Entry; notice: string | undefined } => {
  const fresh = (draft: Draft, composite?: string): Entry => ({
    segments,
    history: startHistory(draft),
    composite,
  })
  const rebuilt = () =>
    fresh(
      rebuildDraft(
        segments,
        rebuildCandidates(jobs, version.jobId).map((edit) => ({
          ...edit,
          failed: edit.status === 'failed',
        })),
      ),
    )
  const raw = readStored(key)
  if (raw === null) return { entry: rebuilt(), notice: undefined }
  const stored = parseStoredDraft(raw)
  const known = new Set([version.jobId, ...edits.map((edit) => edit.id)])
  if (stored === undefined || [...draftSources(stored.draft)].some((id) => !known.has(id)))
    return { entry: rebuilt(), notice: UNREADABLE }
  if (stored.composite === undefined) return { entry: fresh(stored.draft), notice: undefined }
  const verdict = compositeVerdict(jobs, stored.composite)
  if (verdict.kind === 'done') return { entry: fresh(segments), notice: undefined }
  return verdict.kind === 'waiting'
    ? { entry: fresh(stored.draft, stored.composite), notice: undefined }
    : { entry: fresh(stored.draft), notice: verdict.message }
}

type Args = {
  conversationId: string
  version: ChainVersion
  /** 这一版的关键帧分段；还没读到时没有。 */
  segments: readonly DraftClip[] | undefined
  /** 编辑链上的记录；还没读到时没有。 */
  jobs: readonly GenerationJob[] | undefined
  /** 基于这一版的编辑段。 */
  edits: readonly EditSegment[]
  /** 一条编辑段此刻的结论；完成了却还不知道结果多长时仍算在跑。 */
  outcomeOf: (editJobId: string) => EditOutcome | undefined
  /** 要让人看到的一句话：草稿重建、AI 修改失败、合成失败、浏览器无法保存草稿。 */
  onNotice: (message: string) => void
  /** 这一版的草稿合成完成，成了新的一版。 */
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
  /** 选中的段交给了 AI：换成占位，撤销栈从这里重新起算（提交不能撤销）。 */
  submitted: (editJobId: string) => void
  /** 草稿提交了合成。 */
  composing: (compositeJobId: string) => void
}

/** 所看那一版的草稿；分段或编辑链还没读到时返回 `undefined`。 */
export function useEditDraft({
  conversationId,
  version,
  segments,
  jobs,
  edits,
  outcomeOf,
  onNotice,
  onComposed,
}: Args): EditDraft | undefined {
  const [entries, setEntries] = useState<Readonly<Record<string, Entry>>>({})
  const versionJobId = version.jobId
  const put = (entry: Entry) => setEntries((current) => ({ ...current, [versionJobId]: entry }))

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
    if (entry.composite !== undefined) {
      const verdict = compositeVerdict(jobs, entry.composite)
      if (verdict.kind === 'done') {
        entry = {
          segments: entry.segments,
          history: startHistory(entry.segments),
          composite: undefined,
        }
        put(entry)
        onComposed(verdict.jobId)
      } else if (verdict.kind === 'dropped') {
        entry = { ...entry, composite: undefined }
        put(entry)
        onNotice(verdict.message)
      }
    }
  }

  // 每一版的草稿都写回去，不只是正看着的那版：合成完成时已经换去看新的一版，基底那份要在这里清掉。
  const storageFailedRef = useRef(false)
  const noticeStorageFailure = useEffectEvent(() => {
    if (storageFailedRef.current) return
    storageFailedRef.current = true
    onNotice('当前浏览器无法保存草稿，关闭编辑器后剪辑内容将丢失')
  })
  useEffect(() => {
    try {
      for (const [jobId, stored] of Object.entries(entries))
        writeStored(draftStorageKey(conversationId, jobId), stored)
    } catch {
      noticeStorageFailure()
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
    submitted: (editJobId) =>
      changeHistory(({ present }) =>
        startHistory(replaceWithPending(present.draft, present.selection, editJobId)),
      ),
    composing: (compositeJobId) => change((current) => ({ ...current, composite: compositeJobId })),
  }
}

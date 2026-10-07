/** 制作页改字的草稿：按段（`target`）记改动，停手 800ms 后一次写回；保存期间的新改动接着排下一次。
 *
 * `target` 只在读到的那一版文件里有效。写回撞上新版本（409）就重读：这段在新版本里还是改之前的样子，就按新版本
 * 再发；已经和我改的一样，就不用发了；别的情况算冲突，交给人选留谁的。不合规矩（422）保留草稿，说明原因。 */

import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { FilmTextEditIn } from '@/shared/api/generated/types.gen'
import { editFilmText, filmQueryKey, type FilmView } from './film.api'

const SAVE_DELAY_MS = 800

/** 一段字的内容：全局设定是整段文字；镜头是台词前后的几段文字与每句台词的字。 */
export type FilmSegmentValue =
  | { kind: 'text'; text: string }
  | { kind: 'shot'; parts: readonly string[]; lines: readonly string[] }

/** 冲突的一段：`theirs` 是新版本里它的样子，新版本里没有这段了为 undefined。 */
export type FilmConflict = { target: string; label: string; theirs: FilmSegmentValue | undefined }

export type FilmSaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  | { kind: 'conflict'; conflicts: readonly FilmConflict[] }

/** 改动：`base` 是改之前文件里的样子，用来认出别人有没有也改了这段。 */
type FilmEdit = { label: string; base: FilmSegmentValue; value: FilmSegmentValue }

const sameValue = (left: FilmSegmentValue | undefined, right: FilmSegmentValue | undefined) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** 一版文件里每段能改的字，按 `target` 认；同一段出现在几组里时内容相同，取哪组都一样。 */
const segmentValues = (view: FilmView): Map<string, FilmSegmentValue> => {
  const values = new Map<string, FilmSegmentValue>()
  for (const group of view.groups) {
    for (const setting of group.settings) {
      if (setting.target !== null) values.set(setting.target, { kind: 'text', text: setting.text })
    }
    for (const shot of group.shots) {
      if (shot.target !== null)
        values.set(shot.target, {
          kind: 'shot',
          lines: shot.lines.map((line) => line.text),
          parts: shot.parts,
        })
    }
  }
  return values
}

/** 把草稿叠到文件上，页面看到的是叠完的样子。 */
const withEdits = (view: FilmView, edits: ReadonlyMap<string, FilmEdit>): FilmView => {
  if (edits.size === 0) return view
  return {
    ...view,
    groups: view.groups.map((group) => ({
      ...group,
      settings: group.settings.map((setting) => {
        const value = setting.target === null ? undefined : edits.get(setting.target)?.value
        return value?.kind === 'text' ? { ...setting, text: value.text } : setting
      }),
      shots: group.shots.map((shot) => {
        const value = shot.target === null ? undefined : edits.get(shot.target)?.value
        if (value?.kind !== 'shot') return shot
        return {
          ...shot,
          lines: shot.lines.map((line, index) => ({ ...line, text: value.lines[index] ?? '' })),
          parts: [...value.parts],
        }
      }),
    })),
  }
}

/** 发给后端的一段：镜头带上每句台词原来的 `target`，按原来的先后。 */
const editIn = (view: FilmView, target: string, value: FilmSegmentValue): FilmTextEditIn => {
  if (value.kind === 'text') return { target, text: value.text }
  const shot = view.groups.flatMap((group) => group.shots).find((item) => item.target === target)
  return {
    lines: (shot?.lines ?? []).map((line, index) => ({
      target: line.target,
      text: value.lines[index] ?? '',
    })),
    parts: [...value.parts],
    target,
  }
}

const readView = (queryClient: ReturnType<typeof useQueryClient>, conversationId: string) =>
  queryClient.getQueryData<{ film: FilmView }>(filmQueryKey(conversationId))?.film

export const useFilmDraft = (conversationId: string, server: FilmView | undefined) => {
  const queryClient = useQueryClient()
  const [edits, setEdits] = useState<ReadonlyMap<string, FilmEdit>>(() => new Map())
  const [state, setState] = useState<FilmSaveState>({ kind: 'idle' })
  const bookRef = useRef({
    edits: new Map<string, FilmEdit>(),
    conflicts: null as readonly FilmConflict[] | null,
    inFlight: null as Promise<void> | null,
    timer: null as ReturnType<typeof setTimeout> | null,
  })

  const publish = useCallback(() => setEdits(new Map(bookRef.current.edits)), [])
  const clearTimer = useCallback(() => {
    const book = bookRef.current
    if (book.timer !== null) clearTimeout(book.timer)
    book.timer = null
  }, [])

  /** 撞上新版本后对账，返回冲突的段；不冲突的留着按新版本再发。 */
  const reconcile = useCallback(
    (latest: FilmView): FilmConflict[] => {
      const book = bookRef.current
      const values = segmentValues(latest)
      const conflicts: FilmConflict[] = []
      for (const [target, edit] of book.edits) {
        const theirs = values.get(target)
        if (theirs !== undefined && sameValue(theirs, edit.value)) book.edits.delete(target)
        else if (theirs === undefined || !sameValue(theirs, edit.base))
          conflicts.push({ label: edit.label, target, theirs })
      }
      publish()
      return conflicts
    },
    [publish],
  )

  const saveNow = useCallback((): Promise<void> => {
    const book = bookRef.current
    clearTimer()
    if (book.inFlight !== null) return book.inFlight
    if (book.conflicts !== null || book.edits.size === 0) return Promise.resolve()

    const run = async () => {
      let rebased = false
      while (book.edits.size > 0) {
        const view = readView(queryClient, conversationId)
        if (view === undefined) return
        const sending = [...book.edits]
        setState({ kind: 'saving' })
        try {
          const saved = await editFilmText(
            conversationId,
            view.filmVersion,
            sending.map(([target, edit]) => editIn(view, target, edit.value)),
          )
          // 发出去的这一版已经落盘；保存期间又改了的，以落盘的为底接着改。
          for (const [target, edit] of sending) {
            const current = book.edits.get(target)
            if (current === undefined) continue
            if (sameValue(current.value, edit.value)) book.edits.delete(target)
            else book.edits.set(target, { ...current, base: edit.value })
          }
          publish()
          queryClient.setQueryData(filmQueryKey(conversationId), { film: saved })
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409 || rebased) throw error
          await queryClient.refetchQueries({ exact: true, queryKey: filmQueryKey(conversationId) })
          const latest = readView(queryClient, conversationId)
          if (latest === undefined) throw error
          const conflicts = reconcile(latest)
          if (conflicts.length > 0) {
            book.conflicts = conflicts
            setState({ conflicts, kind: 'conflict' })
            return
          }
          rebased = true
        }
      }
      setState({ kind: 'saved' })
    }

    book.inFlight = run()
      .catch((error: unknown) => {
        setState({ kind: 'error', message: errorMessageOf(error, '保存失败') })
      })
      .finally(() => {
        book.inFlight = null
      })
    return book.inFlight
  }, [clearTimer, conversationId, publish, queryClient, reconcile])

  /** 记下一段的新内容；改回原样就不算改动。冲突没处理完之前只记不存。 */
  const update = useCallback(
    (target: string, label: string, value: FilmSegmentValue) => {
      const book = bookRef.current
      const view = readView(queryClient, conversationId)
      const existing = book.edits.get(target)
      const base =
        existing?.base ?? (view === undefined ? undefined : segmentValues(view).get(target))
      if (base === undefined) {
        setState({ kind: 'error', message: '这段字找不到了，刷新后再改' })
        return
      }
      if (sameValue(base, value)) book.edits.delete(target)
      else book.edits.set(target, { base, label, value })
      publish()
      clearTimer()
      if (book.conflicts !== null) return
      setState(book.inFlight === null ? { kind: 'idle' } : { kind: 'saving' })
      if (book.edits.size > 0) book.timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    },
    [clearTimer, conversationId, publish, queryClient, saveNow],
  )

  /** 留我的：还在的段以新版本为底再发，新版本里没有了的只能放弃；用最新的：放弃冲突的段。 */
  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      const book = bookRef.current
      for (const conflict of book.conflicts ?? []) {
        const edit = book.edits.get(conflict.target)
        if (choice === 'mine' && edit !== undefined && conflict.theirs !== undefined)
          book.edits.set(conflict.target, { ...edit, base: conflict.theirs })
        else book.edits.delete(conflict.target)
      }
      book.conflicts = null
      publish()
      setState({ kind: 'idle' })
      if (book.edits.size > 0) void saveNow()
    },
    [publish, saveNow],
  )

  // 离开页面时还没到点的那次立刻存。
  useEffect(
    () => () => {
      if (bookRef.current.timer !== null) void saveNow()
    },
    [saveNow],
  )

  const view = useMemo(
    () => (server === undefined ? undefined : withEdits(server, edits)),
    [edits, server],
  )

  return {
    hasUnsavedChanges: edits.size > 0,
    resolveConflict,
    saveNow,
    state,
    update,
    view,
  }
}

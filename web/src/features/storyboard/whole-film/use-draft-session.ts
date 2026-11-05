import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { redo, startHistory, undo, type History } from '../editing/edit-history'
import { emptyDraft, type WholeFilmDraft } from './editing/draft'
import { commitEdit } from './editing/history'
import type { EditResult } from './editing/result'
import { REFUSAL_TEXT } from './refusal-text'
import { readWholeFilmDraft, saveWholeFilmDraft } from './whole-film.api'

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

const STALE_NOTICE = '成片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃'

type Options = {
  debounceMs?: number
  onNotice: (message: string) => void
}

export function useDraftSession(
  conversationId: string,
  initial: WholeFilmDraftOut,
  { debounceMs = 800, onNotice }: Options,
) {
  const [history, setHistory] = useState<History<WholeFilmDraft>>(() =>
    startHistory(initial.document ?? emptyDraft()),
  )
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const revisionRef = useRef(initial.revision)
  const savedRef = useRef(history.present)
  const presentRef = useRef(history.present)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const noticeRef = useRef(onNotice)
  useLayoutEffect(() => {
    presentRef.current = history.present
    noticeRef.current = onNotice
  })

  const reloadServerCopy = useCallback(async () => {
    const server = await readWholeFilmDraft(conversationId)
    const document = server.document ?? emptyDraft()
    revisionRef.current = server.revision
    savedRef.current = document
    presentRef.current = document
    setHistory(startHistory(document))
    noticeRef.current(STALE_NOTICE)
  }, [conversationId])

  const saveNow = useCallback(async (): Promise<'saved' | 'clean' | 'reloaded' | 'failed'> => {
    while (inFlightRef.current !== null) await inFlightRef.current
    const document = presentRef.current
    if (document === savedRef.current) return 'clean'
    const run = (async () => {
      setSave({ kind: 'saving' })
      try {
        const saved = await saveWholeFilmDraft(conversationId, {
          revision: revisionRef.current,
          document,
        })
        revisionRef.current = saved.revision
        savedRef.current = document
        setSave({ kind: 'idle' })
        return 'saved' as const
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            await reloadServerCopy()
            setSave({ kind: 'idle' })
            return 'reloaded' as const
          } catch (reloadError) {
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, '成片草稿读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, '成片草稿保存失败') })
        return 'failed' as const
      }
    })()
    inFlightRef.current = run.then(() => undefined)
    try {
      return await run
    } finally {
      inFlightRef.current = null
    }
  }, [conversationId, reloadServerCopy])

  useEffect(() => {
    if (history.present === savedRef.current) return
    const timer = setTimeout(() => void saveNow(), debounceMs)
    return () => clearTimeout(timer)
  }, [history.present, debounceMs, saveNow])

  useEffect(
    () => () => {
      if (presentRef.current !== savedRef.current) void saveNow()
    },
    [saveNow],
  )

  const apply = useCallback((result: EditResult): boolean => {
    if (!result.ok) {
      noticeRef.current(REFUSAL_TEXT[result.refusal])
      return false
    }
    setHistory((current) => commitEdit(current, result))
    return true
  }, [])

  return {
    draft: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
    apply,
    save,
    flush: () => void saveNow(),
    settle: async (): Promise<number | undefined> => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean' ? revisionRef.current : undefined
    },
  }
}

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

const STALE_NOTICE = '整片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃'

type Options = {
  /** 停下多久后保存 */
  debounceMs?: number
  onNotice: (message: string) => void
}

/**
 * 一段对话的整片草稿：编辑历史（一次编辑一步撤销）与自动保存。
 *
 * 停止编辑 `debounceMs` 后整份保存，同一时刻只有一次保存在途，后面的改动等它回来再存。
 * 服务端已有更新的一版（409）时换成那一版、清空历史，并用一句话告诉用户。加载后不主动保存；
 * 卸载时还有没存的改动就立刻存一次。
 */
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

  /** 存一次手上的这一版；结果：存好了、本来就存好了、换成了别处的新版、保存失败 */
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
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, '整片草稿读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, '整片草稿保存失败') })
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

  /** 记一步编辑；被拒时说明原因并返回 false */
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
    /** 立刻保存（关闭编辑器、重试保存时用） */
    flush: () => void saveNow(),
    /**
     * 立刻保存并给出服务端存着的那一版的 revision（导出按它）；保存失败或换成了别处的新版时为
     * undefined，原因已经显示给用户。
     */
    settle: async (): Promise<number | undefined> => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean' ? revisionRef.current : undefined
    },
  }
}

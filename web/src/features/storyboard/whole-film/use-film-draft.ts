// 未合成的整片只存在浏览器里，见 ADR-0003。

import { useEffect, useEffectEvent, useState } from 'react'
import { readStored } from '../editing/browser-storage'
import { amend, commit, redo, startHistory, undo, type History } from '../editing/edit-history'
import {
  EMPTY_FILM,
  keepKnownSources,
  parseStoredFilm,
  serializeStoredFilm,
  type FilmState,
  type MaterialLane,
  type StoredFilm,
} from './film-draft'

export const filmDraftStorageKey = (conversationId: string) => `whole-film-draft:${conversationId}`

const UNREADABLE = '整片草稿读取失败，已从空白开始'

type Loaded = {
  history: History<FilmState>
  lanes: readonly MaterialLane[]
  typing: string | undefined
}

export type DraftSeed =
  | { kind: 'records-loading' }
  | { kind: 'blank' }
  | { kind: 'version'; label: string; stored: StoredFilm | undefined }

const droppedNotice = (dropped: number) => `有 ${dropped} 段的来源视频已无法读取，已从成片轨移除`

const load = (
  key: string,
  known: ReadonlyMap<string, { takeId: string }>,
  seed: () => DraftSeed,
): { loaded: Loaded; notice: string | undefined } | undefined => {
  const fresh = (film: FilmState, lanes: readonly MaterialLane[]): Loaded => ({
    history: startHistory(film),
    lanes,
    typing: undefined,
  })
  const kept = (parsed: StoredFilm, notice: (dropped: number) => string | undefined) => {
    const { stored, dropped } = keepKnownSources(parsed, new Set(known.keys()))
    return { loaded: fresh(stored.film, stored.lanes), notice: notice(dropped) }
  }
  const raw = readStored(key)
  if (raw === null) {
    const seeded = seed()
    if (seeded.kind === 'records-loading') return undefined
    if (seeded.kind === 'blank') return { loaded: fresh(EMPTY_FILM, []), notice: undefined }
    if (seeded.stored === undefined)
      return {
        loaded: fresh(EMPTY_FILM, []),
        notice: `${seeded.label} 的剪辑读取失败，已从空白开始`,
      }
    return kept(seeded.stored, (dropped) =>
      dropped === 0
        ? `已按 ${seeded.label} 恢复剪辑`
        : `已按 ${seeded.label} 恢复剪辑；${droppedNotice(dropped)}`,
    )
  }
  const parsed = parseStoredFilm(raw, (jobId) => known.get(jobId)?.takeId)
  if (parsed === undefined) return { loaded: fresh(EMPTY_FILM, []), notice: UNREADABLE }
  return kept(parsed, (dropped) => (dropped === 0 ? undefined : droppedNotice(dropped)))
}

export type FilmDraft = {
  film: FilmState
  lanes: readonly MaterialLane[]
  canUndo: boolean
  canRedo: boolean
  apply: (next: FilmState | ((present: FilmState) => FilmState), typing?: string) => void
  setLanes: (lanes: readonly MaterialLane[]) => void
  undo: () => void
  redo: () => void
}

export function useFilmDraft({
  conversationId,
  known,
  seed,
  onNotice,
  onStorageFailure,
}: {
  conversationId: string
  known: ReadonlyMap<string, { takeId: string }> | undefined
  seed: () => DraftSeed
  onNotice: (message: string) => void
  onStorageFailure: () => void
}): FilmDraft | undefined {
  const key = filmDraftStorageKey(conversationId)
  const [loaded, setLoaded] = useState<Loaded>()
  let current = loaded
  if (current === undefined && known !== undefined) {
    const result = load(key, known, seed)
    if (result !== undefined) {
      current = result.loaded
      setLoaded(current)
      if (result.notice !== undefined) onNotice(result.notice)
    }
  }

  const reportStorageFailure = useEffectEvent(onStorageFailure)
  const film = loaded?.history.present
  const lanes = loaded?.lanes
  useEffect(() => {
    if (film === undefined || lanes === undefined) return
    try {
      if (
        film.segments.length === 0 &&
        film.music === null &&
        film.intro == null &&
        film.outro == null &&
        film.font == null &&
        lanes.length === 0
      )
        window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, serializeStoredFilm({ film, lanes }))
    } catch {
      reportStorageFailure()
    }
  }, [key, film, lanes])

  if (current === undefined) return undefined
  const change = (next: (state: Loaded) => Loaded) =>
    setLoaded((state) => (state === undefined ? state : next(state)))
  return {
    film: current.history.present,
    lanes: current.lanes,
    canUndo: current.history.past.length > 0,
    canRedo: current.history.future.length > 0,
    apply: (next, typing) =>
      change((state) => {
        const film = typeof next === 'function' ? next(state.history.present) : next
        if (film === state.history.present) return state
        return {
          ...state,
          history:
            typing !== undefined && typing === state.typing
              ? amend(state.history, film)
              : commit(state.history, film),
          typing,
        }
      }),
    setLanes: (next) => change((state) => ({ ...state, lanes: next })),
    undo: () => change((state) => ({ ...state, history: undo(state.history), typing: undefined })),
    redo: () => change((state) => ({ ...state, history: redo(state.history), typing: undefined })),
  }
}

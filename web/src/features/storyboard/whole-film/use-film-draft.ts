/** 整片草稿与它的撤销栈：按对话一份，存在浏览器里（ADR-0003：没有合成的编辑只存在浏览器里）。
 * 素材轨（哪几组、各用哪一版）跟着草稿存，但不进撤销栈：换版本只影响之后挑的段，不是对成片的改动。 */

import { useEffect, useEffectEvent, useState } from 'react'
import { commit, amend, redo, startHistory, undo, type History } from '../edit-history'
import {
  EMPTY_FILM,
  keepKnownSources,
  parseStoredFilm,
  serializeStoredFilm,
  type FilmState,
  type MaterialLane,
} from './film-draft'

export const filmDraftStorageKey = (conversationId: string) => `whole-film-draft:${conversationId}`

const UNREADABLE = '整片草稿读取失败，已从空白开始'

type Loaded = {
  history: History<FilmState>
  lanes: readonly MaterialLane[]
  /** 上一步是哪一处在连续改字：同一处接着改并进同一步，撤销时一次退回改字之前。 */
  typing: string | undefined
}

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 读存着的草稿；读不出就从空白开始并说一声，来源读不到的段去掉并说去掉了几段。 */
const load = (
  key: string,
  known: ReadonlySet<string>,
): { loaded: Loaded; notice: string | undefined } => {
  const fresh = (film: FilmState, lanes: readonly MaterialLane[]): Loaded => ({
    history: startHistory(film),
    lanes,
    typing: undefined,
  })
  const raw = readStored(key)
  if (raw === null) return { loaded: fresh(EMPTY_FILM, []), notice: undefined }
  const parsed = parseStoredFilm(raw)
  if (parsed === undefined) return { loaded: fresh(EMPTY_FILM, []), notice: UNREADABLE }
  const { stored, dropped } = keepKnownSources(parsed, known)
  return {
    loaded: fresh(stored.film, stored.lanes),
    notice: dropped === 0 ? undefined : `有 ${dropped} 段的来源视频已无法读取，已从成片轨移除`,
  }
}

export type FilmDraft = {
  film: FilmState
  lanes: readonly MaterialLane[]
  canUndo: boolean
  canRedo: boolean
  /** 改了一步。`typing` 给出正在改字的那一处：同一处连续改并进同一步。 */
  apply: (next: FilmState, typing?: string) => void
  setLanes: (lanes: readonly MaterialLane[]) => void
  undo: () => void
  redo: () => void
}

/** 这段对话的整片草稿；素材（成片）还没读到时返回 `undefined`，读到后才装载，好去掉来源已读不到的段。 */
export function useFilmDraft({
  conversationId,
  known,
  onNotice,
  onStorageFailure,
}: {
  conversationId: string
  /** 读得到的成片 id；还没读到时没有。 */
  known: ReadonlySet<string> | undefined
  /** 要让人看到的一句话：草稿读不出、有段被去掉。 */
  onNotice: (message: string) => void
  /** 浏览器拒绝写入草稿；每次写失败都调，说几次由调用方定。 */
  onStorageFailure: () => void
}): FilmDraft | undefined {
  const key = filmDraftStorageKey(conversationId)
  const [loaded, setLoaded] = useState<Loaded>()
  // 装载在渲染里做：素材一到就对齐，不绕一轮 effect。
  let current = loaded
  if (current === undefined && known !== undefined) {
    const result = load(key, known)
    current = result.loaded
    setLoaded(current)
    if (result.notice !== undefined) onNotice(result.notice)
  }

  const reportStorageFailure = useEffectEvent(onStorageFailure)
  const film = loaded?.history.present
  const lanes = loaded?.lanes
  useEffect(() => {
    if (film === undefined || lanes === undefined) return
    try {
      if (film.segments.length === 0 && film.manual.length === 0 && lanes.length === 0)
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
      change((state) => ({
        ...state,
        history:
          typing !== undefined && typing === state.typing
            ? amend(state.history, next)
            : commit(state.history, next),
        typing,
      })),
    setLanes: (next) => change((state) => ({ ...state, lanes: next })),
    undo: () => change((state) => ({ ...state, history: undo(state.history), typing: undefined })),
    redo: () => change((state) => ({ ...state, history: redo(state.history), typing: undefined })),
  }
}

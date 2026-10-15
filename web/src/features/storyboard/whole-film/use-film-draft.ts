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
  type StoredFilm,
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

/** 浏览器里没有草稿时从哪起步：`undefined` 是重建要用的记录还在读（先不装载）；`null` 是没有合成过的版本，从空白起步；
 * 否则按最新一版（`label`）重建，`stored` 为 undefined 是那一版的请求读不出来。 */
export type DraftSeed = { label: string; stored: StoredFilm | undefined } | null | undefined

const droppedNotice = (dropped: number) => `有 ${dropped} 段的来源视频已无法读取，已从成片轨移除`

/** 读存着的草稿；读不出就从空白开始并说一声，来源读不到的段去掉并说去掉了几段。浏览器里没有草稿时按 `seed` 起步，
 * 它还没准备好时返回 `undefined`。 */
const load = (
  key: string,
  known: ReadonlySet<string>,
  seed: () => DraftSeed,
): { loaded: Loaded; notice: string | undefined } | undefined => {
  const fresh = (film: FilmState, lanes: readonly MaterialLane[]): Loaded => ({
    history: startHistory(film),
    lanes,
    typing: undefined,
  })
  const kept = (parsed: StoredFilm, notice: (dropped: number) => string | undefined) => {
    const { stored, dropped } = keepKnownSources(parsed, known)
    return { loaded: fresh(stored.film, stored.lanes), notice: notice(dropped) }
  }
  const raw = readStored(key)
  if (raw === null) {
    const seeded = seed()
    if (seeded === undefined) return undefined
    if (seeded === null) return { loaded: fresh(EMPTY_FILM, []), notice: undefined }
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
  const parsed = parseStoredFilm(raw)
  if (parsed === undefined) return { loaded: fresh(EMPTY_FILM, []), notice: UNREADABLE }
  return kept(parsed, (dropped) => (dropped === 0 ? undefined : droppedNotice(dropped)))
}

export type FilmDraft = {
  film: FilmState
  lanes: readonly MaterialLane[]
  canUndo: boolean
  canRedo: boolean
  /** 改了一步。`typing` 给出正在改字的那一处：同一处连续改并进同一步。上传、提交完成后才落的改动给函数，
   * 按那一刻的草稿算，不盖掉等待期间的剪辑。 */
  apply: (next: FilmState | ((present: FilmState) => FilmState), typing?: string) => void
  setLanes: (lanes: readonly MaterialLane[]) => void
  undo: () => void
  redo: () => void
}

/** 这段对话的整片草稿；素材（成片）还没读到时返回 `undefined`，读到后才装载，好去掉来源已读不到的段。浏览器里没有草稿时
 * 按 `seed` 起步，它说还在读时也先返回 `undefined`。 */
export function useFilmDraft({
  conversationId,
  known,
  seed,
  onNotice,
  onStorageFailure,
}: {
  conversationId: string
  /** 读得到的成片 id；还没读到时没有。 */
  known: ReadonlySet<string> | undefined
  /** 浏览器里没有草稿时从哪起步；只在那时调用。 */
  seed: () => DraftSeed
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
        film.manual.length === 0 &&
        film.music === null &&
        film.intro == null &&
        film.outro == null &&
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

import { shiftSelect } from '../editing/range-select'
import type { Layer0Clip } from './editing/draft'

/**
 * 编辑器里选中的东西。画面轨上可以选连着的几段，ids 按画面轨先后、至少一个，单选就是只有一个；
 * 特效块、音乐各自只选一个；字幕只能在画面上点选，记它的 captionKey。
 */
export type Selection =
  | { kind: 'clip'; ids: readonly [string, ...string[]] }
  | { kind: 'overlay'; id: string }
  | { kind: 'music' }
  | { kind: 'caption'; key: string }
  | null

/** 选中的画面轨段的 id；没选画面轨时为空 */
export const clipIdsOf = (selection: Selection): readonly string[] =>
  selection?.kind === 'clip' ? selection.ids : []

/** 画面轨上选中这几段；为空时什么也不选 */
export const clipSelection = (ids: readonly string[]): Selection => {
  const [first, ...rest] = ids
  return first === undefined ? null : { kind: 'clip', ids: [first, ...rest] }
}

/** 点画面轨上的一段：不按 Shift 只选它；按着 Shift 按 {@link shiftSelect} 扩选或去掉一端 */
export const clickClip = (
  layer0: readonly Layer0Clip[],
  selection: Selection,
  clipId: string,
  extend: boolean,
): Selection =>
  clipSelection(
    extend
      ? shiftSelect(
          layer0.map((clip) => clip.id),
          clipIdsOf(selection),
          clipId,
        )
      : [clipId],
  )

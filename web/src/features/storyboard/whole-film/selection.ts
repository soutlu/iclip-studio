import { shiftSelect } from '../editing/range-select'
import type { Layer0Clip } from './editing/draft'

export type Selection =
  | { kind: 'clip'; ids: readonly [string, ...string[]] }
  | { kind: 'overlay'; id: string }
  | { kind: 'music' }
  | { kind: 'caption'; key: string }
  | null

export const clipIdsOf = (selection: Selection): readonly string[] =>
  selection?.kind === 'clip' ? selection.ids : []

export const clipSelection = (ids: readonly string[]): Selection => {
  const [first, ...rest] = ids
  return first === undefined ? null : { kind: 'clip', ids: [first, ...rest] }
}

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

import { commit, type History } from '../../editing/edit-history'
import type { WholeFilmDraft } from './draft'
import type { EditResult } from './result'

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined }

const jsonEqual = (a: Json | undefined, b: Json | undefined): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEqual(item, b[i]))
    )
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((key) => jsonEqual(a[key], b[key]))
}

/** 一次编辑记一步撤销；被拒或没有改动的编辑不进历史 */
export const commitEdit = (
  history: History<WholeFilmDraft>,
  result: EditResult,
): History<WholeFilmDraft> =>
  result.ok && !jsonEqual(result.draft, history.present) ? commit(history, result.draft) : history

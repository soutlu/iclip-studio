import type { KeyboardEvent } from 'react'
import { isTextEntry } from './shortcut-target'

export type UndoHistory = {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
}

export const handleUndoShortcut = (
  event: KeyboardEvent<HTMLElement>,
  history: UndoHistory | undefined,
  beforeChange?: () => void,
) => {
  // 输入框里的 ⌘Z 是浏览器撤销打字
  if (isTextEntry(event.target) || !(event.metaKey || event.ctrlKey)) return
  if (event.key.toLowerCase() !== 'z' || history === undefined) return
  event.preventDefault()
  beforeChange?.()
  if (event.shiftKey) {
    if (history.canRedo) history.redo()
  } else if (history.canUndo) history.undo()
}

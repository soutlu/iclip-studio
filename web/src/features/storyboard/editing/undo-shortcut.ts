import type { KeyboardEvent } from 'react'

export type UndoHistory = {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
}

// 输入框里的 ⌘Z 是浏览器撤销打字；range 滑块没有文字可撤销。
const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

export const handleUndoShortcut = (
  event: KeyboardEvent<HTMLElement>,
  history: UndoHistory | undefined,
  beforeChange?: () => void,
) => {
  if (isTextEntry(event.target) || !(event.metaKey || event.ctrlKey)) return
  if (event.key.toLowerCase() !== 'z' || history === undefined) return
  event.preventDefault()
  beforeChange?.()
  if (event.shiftKey) {
    if (history.canRedo) history.redo()
  } else if (history.canUndo) history.undo()
}

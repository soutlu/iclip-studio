import { isTextEntry } from './shortcut-target'

export type UndoHistory = {
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
}

export const handleUndoShortcut = (
  event: Pick<
    KeyboardEvent,
    'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey' | 'target'
  >,
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

import type { JsonPatchOp } from '@hyperframes/sdk'

/** 引擎报的一次改动：`patches` 是怎么改的，`inversePatches` 是怎么改回去（引擎已按应用的顺序排好）。 */
export type PatchChange = {
  readonly patches: readonly JsonPatchOp[]
  readonly inversePatches: readonly JsonPatchOp[]
}

/** 一步撤销：一个编辑动作里的所有改动，按发生的先后。 */
export type UndoStep = readonly PatchChange[]

/** 最多记多少步，照 SDK 自带撤销的默认值。 */
export const UNDO_LIMIT = 100

export type UndoHistory = {
  /** 记下一步（空的不记），清空重做栈；超过上限时丢掉最老的一步。 */
  record: (step: UndoStep) => void
  /** 撤销最近的一步：返回要依次应用 `patches` 的改动（已倒过来、换成反向补丁）；没有可撤销的时是 undefined。 */
  undo: () => UndoStep | undefined
  /** 重做最近撤销的一步：返回要依次应用 `patches` 的改动；没有可重做的时是 undefined。 */
  redo: () => UndoStep | undefined
  clear: () => void
  canUndo: () => boolean
  canRedo: () => boolean
}

const inverted = (step: UndoStep): UndoStep =>
  step.toReversed().map((change) => ({
    ...change,
    patches: change.inversePatches,
    inversePatches: change.patches,
  }))

/** 编辑器自己管的撤销重做：每个编辑动作恰好一步，不按时间合并。 */
export function createUndoHistory(limit = UNDO_LIMIT): UndoHistory {
  const undoStack: UndoStep[] = []
  let redoStack: UndoStep[] = []
  return {
    record: (step) => {
      if (step.length === 0) return
      undoStack.push(step)
      if (undoStack.length > limit) undoStack.shift()
      redoStack = []
    },
    undo: () => {
      const step = undoStack.pop()
      if (step === undefined) return undefined
      redoStack.push(step)
      return inverted(step)
    },
    redo: () => {
      const step = redoStack.pop()
      if (step === undefined) return undefined
      undoStack.push(step)
      return step
    },
    clear: () => {
      undoStack.length = 0
      redoStack = []
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  }
}

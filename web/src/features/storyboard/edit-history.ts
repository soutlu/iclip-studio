/** 撤销栈：编辑器每一步改动的快照，视频编辑器的剪辑草稿与整片草稿共用。纯函数，不持有状态。 */

export type History<T> = {
  past: readonly T[]
  present: T
  future: readonly T[]
}

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] })

/** 一次编辑进栈，清掉重做。 */
export const commit = <T>(history: History<T>, next: T): History<T> => ({
  past: [...history.past, history.present],
  present: next,
  future: [],
})

/** 改当前这一步而不进栈：只改选中，或连续打字并进同一步。 */
export const amend = <T>(history: History<T>, next: T): History<T> => ({
  ...history,
  present: next,
})

export const undo = <T>(history: History<T>): History<T> => {
  const previous = history.past.at(-1)
  return previous === undefined
    ? history
    : {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
}

export const redo = <T>(history: History<T>): History<T> => {
  const next = history.future[0]
  return next === undefined
    ? history
    : { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
}

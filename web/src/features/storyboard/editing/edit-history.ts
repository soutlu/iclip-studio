export type History<T> = {
  past: readonly T[]
  present: T
  future: readonly T[]
}

export const startHistory = <T>(present: T): History<T> => ({ past: [], present, future: [] })

export const commit = <T>(history: History<T>, next: T): History<T> => ({
  past: [...history.past, history.present],
  present: next,
  future: [],
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

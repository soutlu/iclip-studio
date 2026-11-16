import { describe, expect, it } from 'vitest'
import { createUndoHistory, type PatchChange } from './undo-history'

/** 把 `/x` 从 `from` 改成 `to` 的一次改动。 */
const change = (from: string, to: string, path = '/x'): PatchChange => ({
  patches: [{ op: 'replace', path, value: to }],
  inversePatches: [{ op: 'replace', path, value: from }],
})

describe('撤销重做', () => {
  it('记下的步按后进先出撤销，撤销的步按后进先出重做', () => {
    const history = createUndoHistory()
    expect([history.canUndo(), history.canRedo()]).toEqual([false, false])
    expect(history.undo()).toBeUndefined()
    expect(history.redo()).toBeUndefined()

    history.record([change('a', 'b')])
    history.record([change('b', 'c')])
    expect([history.canUndo(), history.canRedo()]).toEqual([true, false])

    expect(history.undo()).toEqual([change('c', 'b')])
    expect(history.undo()).toEqual([change('b', 'a')])
    expect([history.canUndo(), history.canRedo()]).toEqual([false, true])

    expect(history.redo()).toEqual([change('a', 'b')])
    expect(history.redo()).toEqual([change('b', 'c')])
    expect([history.canUndo(), history.canRedo()]).toEqual([true, false])
  })

  it('一步里的几次改动：撤销时倒着、各自换成反向补丁，重做时照原来的先后', () => {
    const history = createUndoHistory()
    const first = change('a', 'b', '/x')
    const second = change('1', '2', '/y')
    history.record([first, second])
    expect(history.undo()).toEqual([change('2', '1', '/y'), change('b', 'a', '/x')])
    expect(history.redo()).toEqual([first, second])
  })

  it('有新的一步时清空重做栈；空的一步不记，也不清重做栈', () => {
    const history = createUndoHistory()
    history.record([change('a', 'b')])
    history.record([change('b', 'c')])
    history.undo()
    history.record([])
    expect([history.canUndo(), history.canRedo()]).toEqual([true, true])

    history.record([change('b', 'd')])
    expect(history.canRedo()).toBe(false)
    expect(history.undo()).toEqual([change('d', 'b')])
    expect(history.undo()).toEqual([change('b', 'a')])
    expect(history.canUndo()).toBe(false)
  })

  it('超过上限时丢掉最老的一步', () => {
    const history = createUndoHistory(2)
    history.record([change('a', 'b')])
    history.record([change('b', 'c')])
    history.record([change('c', 'd')])
    expect(history.undo()).toEqual([change('d', 'c')])
    expect(history.undo()).toEqual([change('c', 'b')])
    expect(history.undo()).toBeUndefined()
  })

  it('默认最多记 100 步', () => {
    const history = createUndoHistory()
    for (let index = 0; index < 101; index += 1)
      history.record([change(String(index), String(index + 1))])
    let undone = 0
    while (history.undo() !== undefined) undone += 1
    expect(undone).toBe(100)
  })

  it('清空以后撤销、重做都没有了', () => {
    const history = createUndoHistory()
    history.record([change('a', 'b')])
    history.record([change('b', 'c')])
    history.undo()
    history.clear()
    expect([history.canUndo(), history.canRedo()]).toEqual([false, false])
    expect(history.undo()).toBeUndefined()
    expect(history.redo()).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { contiguousRange, shiftSelect } from './range-select'

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('contiguousRange：选区在先后顺序里占哪一段', () => {
  it('连续的一串给出两端的位置', () => {
    expect(contiguousRange(ORDER, ['b', 'c', 'd'])).toEqual({ from: 1, to: 3 })
    expect(contiguousRange(ORDER, ['e'])).toEqual({ from: 4, to: 4 })
  })

  it.each([
    ['为空', []],
    ['有不在顺序里的', ['b', 'x']],
    ['不连续', ['a', 'c']],
    ['顺序反了', ['c', 'b']],
  ])('%s时没有', (_, selected) => {
    expect(contiguousRange(ORDER, selected)).toBeUndefined()
  })
})

describe('shiftSelect：Shift 点选', () => {
  it.each([
    ['点右边紧挨的扩选', ['b'], 'c', ['b', 'c']],
    ['点左边紧挨的扩选', ['b', 'c'], 'a', ['a', 'b', 'c']],
    ['点最左那项去掉它', ['b', 'c', 'd'], 'b', ['c', 'd']],
    ['点最右那项去掉它', ['b', 'c', 'd'], 'd', ['b', 'c']],
    ['只剩一项时点它全部取消', ['c'], 'c', []],
    ['点中间那项只选它', ['b', 'c', 'd'], 'c', ['c']],
    ['点不相邻的只选它', ['a', 'b'], 'e', ['e']],
    ['没有选区时只选它', [], 'd', ['d']],
    ['选区不连续时只选它', ['a', 'c'], 'd', ['d']],
  ])('%s', (_, selected, clicked, expected) => {
    expect(shiftSelect(ORDER, selected, clicked)).toEqual(expected)
  })

  it('点的不在顺序里：选区不变', () => {
    expect(shiftSelect(ORDER, ['b'], 'x')).toEqual(['b'])
  })
})

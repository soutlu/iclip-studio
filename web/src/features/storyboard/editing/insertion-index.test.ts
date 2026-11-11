import { describe, expect, it } from 'vitest'
import { insertionIndex } from './insertion-index'

describe('落点在第几块前面', () => {
  const blocks = [1000, 2000, 1000]

  it('指针过了一块的中点才排到它后面，过了最后一块的中点排到末尾', () => {
    expect(insertionIndex(blocks, 400, undefined)).toBe(0)
    expect(insertionIndex(blocks, 600, undefined)).toBe(1)
    expect(insertionIndex(blocks, 1900, undefined)).toBe(1)
    expect(insertionIndex(blocks, 2100, undefined)).toBe(2)
    expect(insertionIndex(blocks, 3600, undefined)).toBe(3)
  })

  it('已经让出空位时，指针还在空位里就不动，出了空位按让位后的位置算', () => {
    const gap = { index: 1, lengthMs: 1500 }
    expect(insertionIndex(blocks, 1000, gap)).toBe(1)
    expect(insertionIndex(blocks, 2500, gap)).toBe(1)
    expect(insertionIndex(blocks, 2560, gap)).toBe(1)
    expect(insertionIndex(blocks, 3400, gap)).toBe(1)
    expect(insertionIndex(blocks, 3600, gap)).toBe(2)
    expect(insertionIndex(blocks, 400, gap)).toBe(0)
  })
})

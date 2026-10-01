import { describe, expect, it } from 'vitest'
import { shotAccentOf } from './shot-accent'

describe('shotAccentOf', () => {
  it('前 8 个镜头各取一色，互不相同', () => {
    const accents = Array.from({ length: 8 }, (_, index) => shotAccentOf(index))
    expect(new Set(accents).size).toBe(8)
  })

  it.each([0, 3, 7, 12])('第 %i 个镜头与 8 个之后那个同色', (index) => {
    expect(shotAccentOf(index + 8)).toBe(shotAccentOf(index))
  })
})

import { describe, expect, it } from 'vitest'
import { aspectOf, aspectValueOf } from './aspect-ratio'

describe('aspectOf', () => {
  it.each([
    ['9:16', { h: 16, w: 9 }],
    ['16:9', { h: 9, w: 16 }],
    ['2.39:1', { h: 1, w: 2.39 }],
    ['adaptive', { h: 16, w: 9 }],
    [null, { h: 16, w: 9 }],
    ['0:1', { h: 16, w: 9 }],
  ])('%s', (ratio, expected) => {
    expect(aspectOf(ratio)).toEqual(expected)
  })
})

describe('aspectValueOf', () => {
  it('宽除以高，读不出来时按 9:16', () => {
    expect(aspectValueOf('16:9')).toBeCloseTo(16 / 9)
    expect(aspectValueOf('adaptive')).toBeCloseTo(9 / 16)
  })
})

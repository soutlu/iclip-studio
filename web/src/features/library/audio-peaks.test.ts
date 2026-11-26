import { describe, expect, it } from 'vitest'
import { peaksOf } from './audio-peaks'

describe('peaksOf', () => {
  it('各声道平均成单声道，每段取绝对值最大，按最响的一段归一、保留 3 位小数', () => {
    const left = Float32Array.from([0.1, -0.4, 0.2, 0.3, -0.9, 0.05])
    const right = Float32Array.from([0.1, -0.4, 0.2, 0.3, -0.3, 0.05])
    expect(peaksOf([left, right], 3)).toEqual([0.667, 0.5, 1])
  })

  it('全程静音时全是 0', () => {
    expect(peaksOf([new Float32Array(8)], 4)).toEqual([0, 0, 0, 0])
  })
})

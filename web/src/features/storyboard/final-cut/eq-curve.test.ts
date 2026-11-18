import { describe, expect, it } from 'vitest'
import { eqCurvePath } from './eq-curve'

const BOX = { width: 76, height: 18, rangeDb: 12, inset: 2.5 }

const bands = (bass: number, mid: number, treble: number) => [
  { frequency: 200, gain: bass },
  { frequency: 1000, gain: mid },
  { frequency: 4000, gain: treble },
]

/** 路径上的点：[x, y]。 */
const points = (d: string) =>
  d.split(/\s*[ML]/).flatMap((part) => {
    const [x, y] = part.trim().split(' ').map(Number)
    return x === undefined || y === undefined || Number.isNaN(x) ? [] : [[x, y] as const]
  })

const yAt = (d: string, x: number) => points(d).find(([at]) => at === x)?.[1]

describe('三段均衡的频响小图', () => {
  it('三段都是 0：一条从左到右、在正中的平线', () => {
    const line = points(eqCurvePath(bands(0, 0, 0), BOX))
    expect(line[0]).toEqual([0, 9])
    expect(line.at(-1)).toEqual([76, 9])
    expect(line.every(([, y]) => y === 9)).toBe(true)
  })

  it('低频加、高频减：左边往上鼓、右边往下凹，中间离正中不远', () => {
    const d = eqCurvePath(bands(12, 0, -12), BOX)
    const left = yAt(d, 18) ?? 9
    const right = yAt(d, 58) ?? 9
    expect(left).toBeLessThan(5)
    expect(right).toBeGreaterThan(13)
  })

  it('几段叠起来超出范围时顶到上下边留的那一点为止', () => {
    const d = eqCurvePath(bands(12, 12, 12), BOX)
    expect(Math.min(...points(d).map(([, y]) => y))).toBe(2.5)
  })
})

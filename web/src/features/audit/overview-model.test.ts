import { describe, expect, it } from 'vitest'
import { attemptSummary, relativeDelta } from './overview-model'

describe('环比', () => {
  it.each([
    {
      current: 12,
      previous: 10,
      better: 'up',
      expected: { direction: 'up', text: '20%', tone: 'good' },
    },
    {
      current: 12,
      previous: 10,
      better: 'down',
      expected: { direction: 'up', text: '20%', tone: 'bad' },
    },
    {
      current: 101,
      previous: 100,
      better: 'up',
      expected: { direction: null, text: '持平', tone: 'flat' },
    },
    {
      current: 5,
      previous: 0,
      better: 'up',
      expected: { direction: null, text: '上期暂无数据', tone: 'flat' },
    },
    {
      current: null,
      previous: 3,
      better: 'up',
      expected: { direction: null, text: '上期暂无数据', tone: 'flat' },
    },
  ] as const)(
    '$previous → $current（越 $better 越好）',
    ({ current, previous, better, expected }) => {
      expect(relativeDelta(current, previous, better)).toEqual(expected)
    },
  )
})

describe('出片次数分档', () => {
  it('五次及以上并成一档，出了 3 次及以上的镜单算占比', () => {
    // 1 次 × 6 镜、2 次 × 2 镜、3 次 × 1 镜、7 次 × 1 镜：共 10 镜、20 次。
    const summary = attemptSummary([
      { attempts: 1, shots: 6 },
      { attempts: 2, shots: 2 },
      { attempts: 3, shots: 1 },
      { attempts: 7, shots: 1 },
    ])

    expect(summary.shots).toEqual([6, 2, 1, 0, 1])
    expect(summary.totalShots).toBe(10)
    expect(summary.heavy).toEqual({ attemptShare: 0.5, shotShare: 0.2 })
  })

  it('没有出到 3 次的镜就没有那一句', () => {
    expect(attemptSummary([{ attempts: 2, shots: 4 }]).heavy).toBeNull()
  })
})

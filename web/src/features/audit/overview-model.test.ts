import { describe, expect, it } from 'vitest'
import { overviewFixture } from '@/testing/mocks/audit-overview'
import { attemptSummary, chartModel, relativeDelta } from './overview-model'

describe('趋势图每一格', () => {
  it('样本不够的格子不画当天的点，悬停照实给数', () => {
    const overview = overviewFixture({
      points: [
        { metrics: { attemptsPerShot: 2, shots: 2 } },
        { metrics: { attemptsPerShot: 1.5, shots: 3 } },
      ],
    })

    const [thin, enough] = chartModel(overview, 'attempts').points
    expect(thin?.value).toBeNull()
    expect(thin?.rows[0]?.value).toBe('2.0 次')
    expect(enough?.value).toBe(1.5)
  })

  it('按周没有均线，折线就是原始值', () => {
    const model = chartModel(overviewFixture({ bucket: 'week' }), 'attempts')

    expect(model.hasLine).toBe(false)
    expect(model.hasSlow).toBe(false)
    expect(model.points.every((point) => point.line === null && point.slow === null)).toBe(true)
  })

  it('按小时件数柱不配均线，比率照画', () => {
    const overview = overviewFixture({ bucket: 'hour' })

    expect(chartModel(overview, 'deliveries').hasLine).toBe(false)
    expect(chartModel(overview, 'attempts').hasLine).toBe(true)
  })

  it('有均线的折线按均线定纵轴，冒尖的当天值落在轴外画成小三角', () => {
    // fixture 的均线都是 1；当天有一格冲到 5 次。
    const model = chartModel(
      overviewFixture({ points: [{ metrics: { attemptsPerShot: 5, shots: 10 } }, {}] }),
      'attempts',
    )

    expect(model.dayMarks).toBe(true)
    expect(model.points[0]?.value).toBe(5)
    expect(model.yTicks.at(-1)).toBeLessThan(5)
  })

  it('非活跃日的那一格带上标记', () => {
    const model = chartModel(overviewFixture({ points: [{ inactive: true }, {}] }), 'deliveries')

    expect(model.points.map((point) => point.inactive)).toEqual([true, false])
    expect(model.points[0]?.rows[0]?.name).toMatch(/非活跃日$/)
  })
})

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

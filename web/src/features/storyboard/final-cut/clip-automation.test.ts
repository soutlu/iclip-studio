import {
  parseAutomation,
  sampleAutomationLane,
  serializeAutomation,
  type HfAutomationLane,
} from '@hyperframes/core/audio-automation'
import { serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { describe, expect, it } from 'vitest'
import { splitAutomation } from './clip-automation'

const text = (lanes: HfAutomationLane[]) => serializeAutomation({ version: 1, lanes })
const lanesOf = (written: string | undefined) => parseAutomation(written ?? '').lanes
const chain = serializeAudioFxChain({
  version: 1,
  nodes: [{ type: 'gain', id: 'n1', enabled: true, params: { gain: 0 } }],
})

describe('切开片段时曲线分成两半', () => {
  const duck = {
    target: 'fx.n1.gain',
    points: [
      { t: 0, v: 0 },
      { t: 1, v: -6 },
      { t: 3, v: -6 },
      { t: 4, v: 0 },
    ],
  }

  it('前半段只留切点之前的，切点上补一个点；后半段去掉切点之前的，时间从 0 开始', () => {
    const halves = splitAutomation(text([duck]), chain, 2.5)
    expect(lanesOf(halves?.first)).toEqual([
      {
        target: 'fx.n1.gain',
        points: [
          { t: 0, v: 0 },
          { t: 1, v: -6 },
          { t: 2.5, v: -6 },
        ],
      },
    ])
    expect(lanesOf(halves?.second)).toEqual([
      {
        target: 'fx.n1.gain',
        points: [
          { t: 0, v: -6 },
          { t: 0.5, v: -6 },
          { t: 1.5, v: 0 },
        ],
      },
    ])
  })

  it('切在两点中间：切点上的值按原曲线取，两半接得上', () => {
    const halves = splitAutomation(text([duck]), chain, 0.5)
    const [first] = lanesOf(halves?.first)
    const [second] = lanesOf(halves?.second)
    expect(first?.points.at(-1)).toEqual({ t: 0.5, v: -3 })
    expect(second?.points[0]).toEqual({ t: 0, v: -3 })
    // 后半段第 t 秒的值和原曲线第 0.5 + t 秒一样
    for (const t of [0.25, 1, 2.75, 3.5])
      expect(sampleAutomationLane(second ?? duck, t)).toBeCloseTo(
        sampleAutomationLane(duck, 0.5 + t),
        6,
      )
  })

  it('每条曲线各切各的；弯曲的一段被切开时两边按原曲线重采，值不变', () => {
    const bent = {
      target: 'volume',
      points: [
        { t: 0, v: 1, curve: 0.6 },
        { t: 2, v: 0.2 },
      ],
    }
    const halves = splitAutomation(text([duck, bent]), chain, 1.2)
    const [, first] = lanesOf(halves?.first)
    const [, second] = lanesOf(halves?.second)
    expect(lanesOf(halves?.first).map((lane) => lane.target)).toEqual(['fx.n1.gain', 'volume'])
    for (const t of [0.3, 0.9])
      expect(sampleAutomationLane(first ?? bent, t)).toBeCloseTo(sampleAutomationLane(bent, t), 2)
    for (const t of [0.2, 0.6])
      expect(sampleAutomationLane(second ?? bent, t)).toBeCloseTo(
        sampleAutomationLane(bent, 1.2 + t),
        2,
      )
  })

  it('没有曲线、读不出时不动', () => {
    expect(splitAutomation(undefined, chain, 1)).toBeNull()
    expect(splitAutomation('{oops', chain, 1)).toBeNull()
  })
})

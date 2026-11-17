import { serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { serializeAutomation, type HfAutomation } from '@hyperframes/core/audio-automation'
import { MAX_AUDIO_GAIN } from '@hyperframes/core/audio-gain'
import { describe, expect, it } from 'vitest'
import { audio } from '@/testing/final-cut'
import {
  clipLevel,
  envelopeHeight,
  envelopeLine,
  flatPoints,
  gainAtHeight,
  insertPoint,
  movePoint,
  nudgedGain,
  removePoint,
  valueAt,
  volumePointsOf,
  withEnvelope,
  withFlatEnvelope,
  withVolumePoints,
} from './volume-envelope'

const duck: HfAutomation['lanes'][number] = {
  target: 'fx.n1.gain',
  points: [
    { t: 0, v: 0 },
    { t: 2, v: -6 },
  ],
}
const withDuck: HfAutomation = { version: 1, lanes: [duck] }
const dipped = [
  { t: 0, v: 1 },
  { t: 1, v: 0.5 },
  { t: 3, v: 0.5 },
  { t: 4, v: 1 },
]

describe('开关和重置', () => {
  it('打开：没有音量曲线时加平的一条，两头各一个原音量的点；压低的曲线留着', () => {
    const on = withEnvelope(withDuck, true, 4)
    expect(on.lanes).toEqual([
      duck,
      {
        target: 'volume',
        points: [
          { t: 0, v: 1 },
          { t: 4, v: 1 },
        ],
      },
    ])
    expect(volumePointsOf(serializeAutomation(on))).toEqual(flatPoints(4))
  })

  it('已经有音量曲线时打开不动它；关掉是去掉音量曲线，别的曲线不动', () => {
    const shaped = withVolumePoints(withDuck, dipped)
    expect(withEnvelope(shaped, true, 4)).toEqual(shaped)
    expect(withEnvelope(shaped, false, 4).lanes).toEqual([duck])
    expect(volumePointsOf(serializeAutomation(withEnvelope(shaped, false, 4)))).toBeNull()
  })

  it('重置：音量曲线换回平的一条，次序不变', () => {
    const shaped: HfAutomation = { version: 1, lanes: [{ target: 'volume', points: dipped }, duck] }
    expect(withFlatEnvelope(shaped, 4).lanes).toEqual([
      { target: 'volume', points: flatPoints(4) },
      duck,
    ])
  })

  it('读不出的曲线当没有', () => {
    expect(volumePointsOf(null)).toBeNull()
    expect(volumePointsOf('{oops')).toBeNull()
  })
})

describe('改点', () => {
  it('加点：值取曲线在那里原来的值，排进相邻两个点中间；离已有的点太近时不加', () => {
    const added = insertPoint(dipped, 0.5)
    expect(added).toEqual({
      index: 1,
      points: [{ t: 0, v: 1 }, { t: 0.5, v: 0.75 }, ...dipped.slice(1)],
    })
    expect(insertPoint(dipped, 1.01)).toBeNull()
    expect(insertPoint(dipped, 0.005)).toBeNull()
  })

  it('挪点：中间的点上下左右都能挪，但不越过相邻的点', () => {
    expect(movePoint(dipped, 1, 2, 0.25)[1]).toEqual({ t: 2, v: 0.25 })
    expect(movePoint(dipped, 1, 3.5, 0.5)[1]?.t).toBe(2.999)
    expect(movePoint(dipped, 1, -1, 0.5)[1]?.t).toBe(0.001)
  })

  it('挪点：两头的点只能上下挪；值收在 0 到 +12 dB 之间', () => {
    expect(movePoint(dipped, 0, 2, 0.3)[0]).toEqual({ t: 0, v: 0.3 })
    expect(movePoint(dipped, 3, 1, 9)[3]).toEqual({ t: 4, v: Number(MAX_AUDIO_GAIN.toFixed(6)) })
    expect(movePoint(dipped, 3, 1, -1)[3]).toEqual({ t: 4, v: 0 })
  })

  it('删点：只删中间的点，两头的不删', () => {
    expect(removePoint(dipped, 1)).toEqual([dipped[0], dipped[2], dipped[3]])
    expect(removePoint(dipped, 0)).toEqual(dipped)
    expect(removePoint(dipped, 3)).toEqual(dipped)
  })

  it('方向键一格是推子上的一格：原音量往下一格比原来小，最低是没有声音', () => {
    expect(nudgedGain(1, -1)).toBeLessThan(1)
    expect(nudgedGain(1, 1)).toBeGreaterThan(1)
    expect(nudgedGain(0, -10)).toBe(0)
  })
})

describe('画线和波形高低', () => {
  it('高低按 dB 均匀：原音量在 3/4 高，压低 12 dB 低 1/4，+12 dB 在顶上，没有声音在底下，能换回来', () => {
    expect(envelopeHeight(1)).toBeCloseTo(0.75)
    expect(envelopeHeight(0.25)).toBeCloseTo(0.75 - 12.04 / 48, 2)
    expect(envelopeHeight(MAX_AUDIO_GAIN)).toBeCloseTo(1)
    expect(envelopeHeight(0)).toBe(0)
    expect(gainAtHeight(0)).toBe(0)
    expect(gainAtHeight(envelopeHeight(0.5))).toBeCloseTo(0.5)
  })

  it('斜着的一段多取几处，画出来的线每一处都是放出来的值；平的一段只连两头', () => {
    const line = envelopeLine(dipped, 4)
    const mid = line.find((point) => point.t === 0.5)
    expect(mid?.v).toBeCloseTo(valueAt(dipped, 0.5))
    expect(mid?.v).toBeCloseTo(0.75)
    expect(line.filter((point) => point.t > 1 && point.t < 3)).toEqual([])
    expect(line.at(0)).toEqual({ t: 0, v: 1 })
    expect(line.at(-1)).toEqual({ t: 4, v: 1 })
  })

  it('片段裁短以后外面的点不画，结尾按曲线在那里的值接上', () => {
    const line = envelopeLine(dipped, 2)
    expect(line.every((point) => point.t <= 2)).toBe(true)
    expect(line.at(-1)).toEqual({ t: 2, v: 0.5 })
  })

  it('波形高低 = 片段音量 × 音量曲线 × 淡入淡出 × 压低的增益', () => {
    const chain = serializeAudioFxChain({
      version: 1,
      nodes: [{ type: 'gain', id: 'n1', enabled: true, fromCarve: true, params: { gain: 0 } }],
    })
    const clip = audio({
      duration: 4000,
      volume: 0.5,
      fadeIn: 1000,
      fxChain: chain,
      automation: serializeAutomation(withVolumePoints(withDuck, dipped)),
    })
    const level = clipLevel(clip, 4, volumePointsOf(clip.automation))
    // 第 0.5 秒：音量 0.5 × 曲线 0.75 × 淡入一半 × 压低 -1.5 dB
    expect(level(0.5)).toBeCloseTo(0.5 * 0.75 * 0.5 * 10 ** (-1.5 / 20))
    // 第 3.5 秒：没有淡入，压低在 -6 dB 停住
    expect(level(3.5)).toBeCloseTo(0.5 * 0.75 * 10 ** (-6 / 20))
  })

  it('没有音量曲线时按片段音量算；拖动中给的点优先', () => {
    const clip = audio({ duration: 4000, volume: 2 })
    expect(clipLevel(clip, 4, null)(1)).toBeCloseTo(2)
    expect(clipLevel(clip, 4, dipped)(2)).toBeCloseTo(1)
  })
})

import { parseAudioFxChain, serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { parseAutomation, serializeAutomation } from '@hyperframes/core/audio-automation'
import { describe, expect, it } from 'vitest'
import { audio } from '@/testing/final-cut'
import { CARVE_SAMPLE_RATE, carveAttributes, type CarveDecode } from './carve'
import { isLevelled, levellerAttributes, measureLevelling } from './leveller'

/** 前 `quiet` 秒很轻、后面很响的声音，共 `seconds` 秒。 */
const uneven = (seconds: number, quiet: number) =>
  Float32Array.from(
    { length: seconds * CARVE_SAMPLE_RATE },
    (_, i) => Math.sin(i / 7) * (i < quiet * CARVE_SAMPLE_RATE ? 0.02 : 0.5),
  )

const lanesOf = (text: string | null) => parseAutomation(text ?? '').lanes

describe('开没开平稳音量', () => {
  it('看效果链里有没有平稳音量的节点；没写、读不出的效果链算没开', () => {
    const written = levellerAttributes(undefined, undefined, { samples: uneven(4, 2), rate: 1 })
    expect(isLevelled(audio({ fxChain: written?.chain ?? null }))).toBe(true)
    const own = serializeAudioFxChain({
      version: 1,
      nodes: [{ type: 'gain', id: 'mine', enabled: true, params: { gain: 3 } }],
    })
    expect(isLevelled(audio({ fxChain: own }))).toBe(false)
    expect(isLevelled(audio())).toBe(false)
    expect(isLevelled(audio({ fxChain: '{oops' }))).toBe(false)
  })
})

describe('平稳音量写进效果链和曲线', () => {
  const volume = { target: 'volume', points: [{ t: 0, v: 1 }] }

  it('轻的地方抬起来：加一个平稳音量的增益节点和推它的曲线，手加的曲线留着', () => {
    const written = levellerAttributes(
      undefined,
      serializeAutomation({ version: 1, lanes: [volume] }),
      { samples: uneven(6, 2), rate: 1 },
    )
    const [node] = parseAudioFxChain(written?.chain ?? '').nodes
    expect(node).toMatchObject({ type: 'gain', fromLeveller: true })
    const lanes = lanesOf(written?.automation ?? null)
    expect(lanes[0]).toEqual(volume)
    const lane = lanes.find((candidate) => candidate.target === `fx.${node?.id ?? ''}.gain`)
    // 前两秒轻：抬起来；后面响：回到不动
    expect(lane?.points.find((point) => point.t > 0.5 && point.t < 1.5)?.v).toBeGreaterThan(3)
    expect(lane?.points.at(-1)?.v).toBeLessThan(1)
  })

  it('曲线的时间换到片段的时钟上：2 倍速时素材第 2 秒在片段第 1 秒', () => {
    const at = (rate: number) => {
      const written = levellerAttributes(undefined, undefined, { samples: uneven(4, 2), rate })
      return lanesOf(written?.automation ?? null)[0]?.points.at(-1)?.t ?? 0
    }
    expect(at(2)).toBeCloseTo(at(1) / 2, 2)
  })

  it('声音已经平稳：什么都不写', () => {
    const steady = Float32Array.from({ length: 4 * CARVE_SAMPLE_RATE }, (_, i) => Math.sin(i / 7))
    expect(levellerAttributes(undefined, undefined, { samples: steady, rate: 1 })).toBeNull()
  })

  it('重量时原位换掉；关掉时去掉节点和它的曲线，别的留着', () => {
    const own = { type: 'gain', id: 'mine', enabled: true, params: { gain: 3 } }
    const measured = { samples: uneven(4, 2), rate: 1 }
    const first = levellerAttributes(
      serializeAudioFxChain({ version: 1, nodes: [own] }),
      undefined,
      measured,
    )
    const again = levellerAttributes(
      first?.chain ?? undefined,
      first?.automation ?? undefined,
      measured,
    )
    expect(parseAudioFxChain(again?.chain ?? '').nodes).toHaveLength(2)
    expect(lanesOf(again?.automation ?? null)).toHaveLength(1)

    const off = levellerAttributes(again?.chain ?? undefined, again?.automation ?? undefined, null)
    expect(parseAudioFxChain(off?.chain ?? '').nodes).toEqual([own])
    expect(off?.automation).toBeNull()
  })

  it('压低和平稳音量写在同一条效果链上：重做一个不动另一个的节点和曲线', () => {
    const levelled = levellerAttributes(undefined, undefined, { samples: uneven(4, 2), rate: 1 })
    const measured = {
      bands: [{ freq: 1_000, gainDb: -6, q: 1.4 }],
      carved: {
        version: 1 as const,
        nodes: [{ type: 'peaking', enabled: true, params: { frequency: 1_000, gain: -6, q: 1.4 } }],
      },
      duck: [
        { t: 0, v: 0 },
        { t: 1, v: -6 },
      ],
      voiceMix: new Float32Array(CARVE_SAMPLE_RATE),
    }
    const carved = carveAttributes(
      levelled?.chain ?? undefined,
      levelled?.automation ?? undefined,
      measured,
    )
    const leveller = parseAudioFxChain(levelled?.chain ?? '').nodes[0]
    const target = `fx.${leveller?.id ?? ''}.gain`
    expect(parseAudioFxChain(carved.chain ?? '').nodes).toContainEqual(leveller)
    expect(lanesOf(carved.automation).map((lane) => lane.target)).toContain(target)

    const releveled = levellerAttributes(
      carved.chain ?? undefined,
      carved.automation ?? undefined,
      { samples: uneven(4, 3), rate: 1 },
    )
    const nodes = parseAudioFxChain(releveled?.chain ?? '').nodes
    expect(nodes.filter((node) => node.fromCarve === true)).toEqual(
      parseAudioFxChain(carved.chain ?? '').nodes.filter((node) => node.fromCarve === true),
    )
    expect(lanesOf(releveled?.automation ?? null)).toHaveLength(lanesOf(carved.automation).length)
  })
})

describe('量片段自己的声音', () => {
  it('按入点和时长截取素材', async () => {
    const source = Float32Array.from({ length: 10 * CARVE_SAMPLE_RATE }, (_, i) => i)
    const decode: CarveDecode = () => Promise.resolve(source)
    const clip = audio({ mediaStart: 2_000, duration: 3_000, playbackRate: 2 })
    const measured = await measureLevelling(clip, decode)
    expect(measured.samples.length).toBe(6 * CARVE_SAMPLE_RATE)
    expect(measured.samples[0]).toBe(2 * CARVE_SAMPLE_RATE)
    expect(measured.rate).toBe(2)
  })
})

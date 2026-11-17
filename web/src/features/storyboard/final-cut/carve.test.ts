import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import { parseAudioFxChain, serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { parseAutomation, serializeAutomation } from '@hyperframes/core/audio-automation'
import { describe, expect, it } from 'vitest'
import { audio, video } from '@/testing/final-cut'
import {
  CARVE_SAMPLE_RATE,
  carveAttributes,
  carveOf,
  carveOffered,
  carveVoices,
  measureCarve,
  nextCarve,
  switchedCarve,
  type CarveDecode,
} from './carve'
import type { AudioClip } from './composition/film'

const BED = audio({ id: 'bed', start: 0, duration: 4_000, src: 'https://media.test/bed.mp3' })

const withCarve = (settings: object): AudioClip => ({ ...BED, fxCarve: JSON.stringify(settings) })

const original = audio({ id: 'orig', syncOrigin: 'lk-1', link: 'lk-1', duration: 2_000 })
const dubEn = audio({
  id: 'dub-en',
  start: 1_000,
  duration: 1_000,
  dub: { locale: 'en', caption: 'cap-1', trimmed: false },
})

describe('谁是人声', () => {
  it('没关原声的视频、分离出来的原声、所有语言的配音算；关了原声的视频、配乐不算', () => {
    const clips = [
      BED,
      video({ id: 'loud', duration: 2_000 }),
      video({ id: 'mute', duration: 2_000, muted: true }),
      original,
      dubEn,
      audio({ id: 'dub-de', dub: { locale: 'de', caption: 'cap-1', trimmed: false } }),
      audio({ id: 'other-music', duration: 4_000 }),
    ]
    expect(carveVoices(BED, clips).map((clip) => clip.id)).toEqual([
      'loud',
      'orig',
      'dub-en',
      'dub-de',
    ])
  })

  it('时间上和配乐不重叠的、隐藏的不算', () => {
    const clips = [
      BED,
      video({ id: 'after', start: 4_000, duration: 1_000 }),
      video({ id: 'hidden', duration: 1_000, hidden: true }),
      video({ id: 'edge', start: 3_900, duration: 1_000 }),
    ]
    expect(carveVoices(BED, clips).map((clip) => clip.id)).toEqual(['edge'])
  })
})

describe('不用用户动手时的设置', () => {
  const voices = [BED, video({ id: 'loud', duration: 2_000 }), dubEn]

  it('没设置过、有重叠的人声：默认开，压这些人声，强度用默认值', () => {
    expect(nextCarve(BED, voices)).toEqual({ ...DEFAULT_CARVE, sources: ['loud', 'dub-en'] })
    expect(carveOffered(BED, voices)).toBe(true)
  })

  it('没设置过、没有重叠的人声：不动，也不显示', () => {
    expect(nextCarve(BED, [BED])).toBeNull()
    expect(carveOffered(BED, [BED])).toBe(false)
  })

  it('用户关掉以后不再自动打开', () => {
    const off = switchedCarve(withCarve({ ...DEFAULT_CARVE, sources: ['loud'] }), voices, false)
    expect(off).toEqual({ ...DEFAULT_CARVE, enabled: false, sources: ['loud'] })
    expect(nextCarve(withCarve(off), voices)).toBeNull()
  })

  it('压的人声删了一个：去掉删了的；都删了：换成现在重叠的人声，没有就空着', () => {
    const bed = withCarve({ enabled: true, sources: ['loud', 'gone'], strength: 0.5 })
    expect(nextCarve(bed, voices)).toEqual({ enabled: true, sources: ['loud'], strength: 0.5 })
    const allGone = withCarve({ enabled: true, sources: ['gone'], strength: 0.5 })
    expect(nextCarve(allGone, voices)).toEqual({
      enabled: true,
      sources: ['loud', 'dub-en'],
      strength: 0.5,
    })
    expect(nextCarve(allGone, [allGone])).toEqual({ enabled: true, sources: [], strength: 0.5 })
  })

  it('压的人声都还在：不动（后来加的人声不自动加进去）', () => {
    const bed = withCarve({ enabled: true, sources: ['loud'], strength: 0.25 })
    expect(nextCarve(bed, voices)).toBeNull()
  })

  it('打开时压现在重叠的人声，强度留着之前的；写法不对的设置当作没设置过', () => {
    const off = withCarve({ enabled: false, sources: [], strength: 0.6 })
    expect(switchedCarve(off, voices, true)).toEqual({
      enabled: true,
      sources: ['loud', 'dub-en'],
      strength: 0.6,
    })
    expect(carveOf({ ...BED, fxCarve: '{oops' })).toBeNull()
  })
})

/** 一段声音：`seconds` 秒，`at(t)` 给出第 t 秒的值。 */
const signal = (seconds: number, at: (t: number) => number) =>
  Float32Array.from({ length: Math.round(seconds * CARVE_SAMPLE_RATE) }, (_, i) =>
    at(i / CARVE_SAMPLE_RATE),
  )

// 固定种子的噪声，每次一样
const noise = () => {
  let seed = 7
  return () => {
    seed = (seed * 16_807) % 2_147_483_647
    return (seed / 2_147_483_647) * 2 - 1
  }
}

describe('量配乐怎么让路', () => {
  const next = noise()
  const sounds = new Map([
    // 人声：前 1 秒 1 kHz 的声音，之后不出声
    [
      'https://media.test/voice.mp3',
      signal(2, (t) => (t < 1 ? 0.3 * Math.sin(2_000 * Math.PI * t) : 0)),
    ],
    ['https://media.test/bed.mp3', signal(4, () => 0.3 * next())],
  ])
  const decode: CarveDecode = (src) => {
    const samples = sounds.get(src)
    return samples === undefined ? Promise.reject(new Error(src)) : Promise.resolve(samples)
  }
  const voice = audio({
    id: 'orig',
    syncOrigin: 'lk-1',
    src: 'https://media.test/voice.mp3',
    start: 1_000,
    duration: 2_000,
  })

  it('人声按它在时间线上的位置叠到配乐上：说话时压，说话前、说完一阵以后不压', async () => {
    const measured = await measureCarve(BED, [voice], DEFAULT_CARVE.strength, decode)
    expect(measured?.bands.length).toBeGreaterThan(0)
    const duck = measured?.duck ?? []
    const at = (t: number) => duck.findLast((point) => point.t <= t)?.v ?? 0
    expect(at(0.9)).toBe(0)
    expect(at(1.6)).toBeLessThan(-1)
    expect(duck.at(-1)?.v).toBe(0)
  })

  it('读不出声音时把错误抛出去', async () => {
    const lost = { ...voice, src: 'https://media.test/lost.mp3' }
    await expect(measureCarve(BED, [lost], 0.25, decode)).rejects.toThrow('lost.mp3')
  })

  it('写回效果链和曲线：换掉上一次生成的，手加的效果和音量曲线留着；关掉时只去掉生成的', async () => {
    const measured = await measureCarve(BED, [voice], DEFAULT_CARVE.strength, decode)
    if (measured === null) throw new Error('没量出来')
    const own = { type: 'gain', id: 'mine', enabled: true, params: { gain: 3 } }
    const volume = {
      target: 'volume',
      points: [
        { t: 0, v: 1 },
        { t: 2, v: 0.5 },
      ],
    }
    const first = carveAttributes(
      serializeAudioFxChain({ version: 1, nodes: [own] }),
      serializeAutomation({ version: 1, lanes: [volume] }),
      measured,
    )
    const chain = parseAudioFxChain(first.chain ?? '')
    const generated = chain.nodes.filter((node) => node.fromCarve === true)
    expect(generated.map((node) => node.type)).toEqual([
      ...measured.bands.map(() => 'peaking'),
      'gain',
    ])
    expect(chain.nodes.at(-1)).toMatchObject({ id: 'mine' })
    const lanes = parseAutomation(first.automation ?? '').lanes
    expect(lanes[0]).toMatchObject({ target: 'volume' })
    expect(lanes.map((lane) => lane.target)).toContain(`fx.${generated.at(-1)?.id ?? ''}.gain`)

    const again = carveAttributes(first.chain ?? undefined, first.automation ?? undefined, measured)
    expect(parseAudioFxChain(again.chain ?? '').nodes).toHaveLength(chain.nodes.length)
    expect(parseAutomation(again.automation ?? '').lanes).toHaveLength(lanes.length)

    const off = carveAttributes(first.chain ?? undefined, first.automation ?? undefined, null)
    expect(parseAudioFxChain(off.chain ?? '').nodes).toEqual([chain.nodes.at(-1)])
    expect(parseAutomation(off.automation ?? '').lanes).toEqual([lanes[0]])
    expect(carveAttributes(undefined, undefined, null)).toEqual({ chain: null, automation: null })
  })
})

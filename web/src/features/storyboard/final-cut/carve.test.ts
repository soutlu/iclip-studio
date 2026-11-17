import { DEFAULT_CARVE } from '@hyperframes/core/audio-carve'
import { parseAudioFxChain, serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { parseAutomation, serializeAutomation } from '@hyperframes/core/audio-automation'
import { describe, expect, it } from 'vitest'
import { audio, video } from '@/testing/final-cut'
import { roleOf } from './audio-role'
import {
  CARVE_SAMPLE_RATE,
  carveAttributes,
  carveOf,
  carvePlan,
  carveVoices,
  measureCarve,
  nextCarve,
  switchedCarve,
  type CarveDecode,
} from './carve'
import type { MediaClip } from './composition/film'

const BED = audio({ id: 'bed', start: 0, duration: 4_000, src: 'https://media.test/bed.mp3' })

const withCarve = <T extends MediaClip>(clip: T, settings: object): T => ({
  ...clip,
  fxCarve: JSON.stringify(settings),
})
const ids = (clips: readonly MediaClip[]) => clips.map((clip) => clip.id)

const original = audio({ id: 'orig', syncOrigin: 'lk-1', link: 'lk-1', duration: 2_000 })
const dubEn = audio({
  id: 'dub-en',
  start: 1_000,
  duration: 1_000,
  dub: { locale: 'en', caption: 'cap-1', trimmed: false },
})

describe('声音角色', () => {
  it('没写角色组时按声音从哪来算：普通音频是配乐，视频、分离出来的原声、配音是人声', () => {
    expect([BED, video(), original, dubEn].map(roleOf)).toEqual([
      'music',
      'voice',
      'voice',
      'voice',
    ])
  })

  it('写了角色组的照组：配乐可以改成人声，视频可以改成音效；别的组名按声音从哪来算', () => {
    expect(roleOf(audio({ audioGroup: 'voice' }))).toBe('voice')
    expect(roleOf(video({ audioGroup: 'sfx' }))).toBe('sfx')
    expect(roleOf(audio({ audioGroup: 'narration' }))).toBe('music')
  })
})

describe('谁是人声', () => {
  it('角色是人声、有声音的算：没关原声的视频、分离出来的原声、所有语言的配音；关了原声的视频、配乐不算', () => {
    const clips = [
      BED,
      video({ id: 'loud', duration: 2_000 }),
      video({ id: 'mute', duration: 2_000, muted: true }),
      original,
      dubEn,
      audio({ id: 'dub-de', dub: { locale: 'de', caption: 'cap-1', trimmed: false } }),
      audio({ id: 'other-music', duration: 4_000 }),
    ]
    expect(ids(carveVoices(BED, clips))).toEqual(['loud', 'orig', 'dub-en', 'dub-de'])
  })

  it('改了角色就跟着变：配乐改成人声算，视频改成音效不算', () => {
    const clips = [
      BED,
      video({ id: 'sfx', duration: 2_000, audioGroup: 'sfx' }),
      audio({ id: 'talk', duration: 2_000, audioGroup: 'voice' }),
    ]
    expect(ids(carveVoices(BED, clips))).toEqual(['talk'])
  })

  it('时间上和它不重叠的、隐藏的、它自己不算', () => {
    const clips = [
      BED,
      video({ id: 'after', start: 4_000, duration: 1_000 }),
      video({ id: 'hidden', duration: 1_000, hidden: true }),
      video({ id: 'edge', start: 3_900, duration: 1_000 }),
    ]
    expect(ids(carveVoices(BED, clips))).toEqual(['edge'])
    const talk = video({ id: 'talk', duration: 4_000 })
    expect(ids(carveVoices(talk, [talk, ...clips]))).toEqual(['edge'])
  })
})

describe('不用用户动手时的设置', () => {
  const loud = video({ id: 'loud', duration: 2_000 })
  const voices = [BED, loud, dubEn]

  it('配乐、音效没设置过、有重叠的人声：默认开，压人声组，强度用默认值', () => {
    expect(nextCarve(BED, voices)).toEqual({ ...DEFAULT_CARVE, sources: ['voice'] })
    const sfx = audio({ id: 'whoosh', duration: 4_000, audioGroup: 'sfx' })
    expect(nextCarve(sfx, [sfx, loud])).toEqual({ ...DEFAULT_CARVE, sources: ['voice'] })
  })

  it('没有重叠的人声、或者自己是人声时：不自动打开', () => {
    expect(nextCarve(BED, [BED])).toBeNull()
    expect(nextCarve(loud, voices)).toBeNull()
  })

  it('用户关掉以后不再自动打开', () => {
    const off = switchedCarve(
      withCarve(BED, { ...DEFAULT_CARVE, sources: ['voice'] }),
      voices,
      false,
    )
    expect(off).toEqual({ ...DEFAULT_CARVE, enabled: false, sources: ['voice'] })
    expect(nextCarve(withCarve(BED, off), voices)).toBeNull()
  })

  it('人声组里还有片段：不动（后来加的人声、改了角色的不自动重新分析）', () => {
    const grouped = [BED, { ...loud, audioGroup: 'voice' }, dubEn]
    const bed = withCarve(BED, { enabled: true, sources: ['voice'], strength: 0.25 })
    expect(nextCarve(bed, grouped)).toBeNull()
  })

  it('名单里的没了：去掉没了的；都没了：有重叠的人声换成人声组，没有就空着', () => {
    const bed = withCarve(BED, { enabled: true, sources: ['loud', 'gone'], strength: 0.5 })
    expect(nextCarve(bed, voices)).toEqual({ enabled: true, sources: ['loud'], strength: 0.5 })
    // 人声组里一个片段都没有了
    const allGone = withCarve(BED, { enabled: true, sources: ['voice'], strength: 0.5 })
    expect(nextCarve(allGone, voices)).toEqual({ enabled: true, sources: ['voice'], strength: 0.5 })
    expect(nextCarve(allGone, [allGone])).toEqual({ enabled: true, sources: [], strength: 0.5 })
  })

  it('打开时压人声组，强度留着之前的；人声也能打开；写法不对的设置当作没设置过', () => {
    const off = withCarve(BED, { enabled: false, sources: [], strength: 0.6 })
    expect(switchedCarve(off, voices, true)).toEqual({
      enabled: true,
      sources: ['voice'],
      strength: 0.6,
    })
    expect(switchedCarve(loud, voices, true)).toEqual({ ...DEFAULT_CARVE, sources: ['voice'] })
    expect(carveOf({ ...BED, fxCarve: '{oops' })).toBeNull()
  })
})

describe('压哪些人声', () => {
  const settings = { ...DEFAULT_CARVE, sources: ['voice'] }

  it('压人声组：重叠的、还没归组的人声一起放进组；量组里重叠的人声，不含自己，别的组的不算', () => {
    const clips = [
      BED,
      video({ id: 'inferred', duration: 2_000 }),
      audio({ id: 'member', duration: 2_000, audioGroup: 'voice' }),
      audio({ id: 'far', start: 5_000, duration: 1_000, audioGroup: 'voice' }),
      audio({ id: 'other', duration: 2_000, syncOrigin: 'lk', audioGroup: 'narration' }),
    ]
    const plan = carvePlan(BED, settings, clips)
    expect(plan.grouped).toEqual(['inferred'])
    expect(ids(plan.voices)).toEqual(['inferred', 'member'])

    const talk = clips[2] as MediaClip
    expect(ids(carvePlan(talk, settings, clips).voices)).toEqual(['inferred'])
  })

  it('人声改成别的角色就不在名单里了；旧文件里写片段编号的照旧认', () => {
    const changed = [BED, audio({ id: 'member', duration: 2_000, audioGroup: 'music' })]
    expect(carvePlan(BED, settings, changed).voices).toEqual([])
    const legacy = { ...DEFAULT_CARVE, sources: ['loud'] }
    const clips = [BED, video({ id: 'loud' }), video({ id: 'quiet' })]
    expect(carvePlan(BED, legacy, clips)).toEqual({ grouped: [], voices: [clips[1]] })
  })

  it('关着时什么都不量、不归组', () => {
    expect(carvePlan(BED, { ...settings, enabled: false }, [BED, video()])).toEqual({
      grouped: [],
      voices: [],
    })
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

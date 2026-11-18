import {
  parseAutomation,
  sampleAutomationLane,
  serializeAutomation,
  type HfAutomationLane,
} from '@hyperframes/core/audio-automation'
import { parseAudioFxChain, serializeAudioFxChain } from '@hyperframes/core/audio-fx'
import { describe, expect, it } from 'vitest'
import { audio, video } from '@/testing/final-cut'
import {
  curvesFollowing,
  followAutomation,
  laneFollows,
  splitAutomation,
  voicesShift,
  type ClipPlacement,
} from './clip-automation'
import type { FilmClip } from './composition/film'

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

  it('音量关键帧：切在压低的那一段中间，前半段到切点为止、后半段从切点的值接着放，两半各自两头有点', () => {
    const volume = {
      target: 'volume',
      points: [
        { t: 0, v: 1 },
        { t: 1, v: 0.25 },
        { t: 3, v: 0.25 },
        { t: 4, v: 1 },
      ],
    }
    const halves = splitAutomation(text([volume]), undefined, 3.5)
    expect(lanesOf(halves?.first)).toEqual([
      {
        target: 'volume',
        points: [
          { t: 0, v: 1 },
          { t: 1, v: 0.25 },
          { t: 3, v: 0.25 },
          { t: 3.5, v: 0.625 },
        ],
      },
    ])
    expect(lanesOf(halves?.second)).toEqual([
      {
        target: 'volume',
        points: [
          { t: 0, v: 0.625 },
          { t: 0.5, v: 1 },
        ],
      },
    ])
  })

  it('没有曲线、读不出时不动', () => {
    expect(splitAutomation(undefined, chain, 1)).toBeNull()
    expect(splitAutomation('{oops', chain, 1)).toBeNull()
  })
})

// 片段上的效果链：n1 是自动压低生成的，n2 是平稳音量生成的
const fxChain = serializeAudioFxChain({
  version: 1,
  nodes: [
    { type: 'gain', id: 'n1', enabled: true, fromCarve: true, params: { gain: 0 } },
    { type: 'gain', id: 'n2', enabled: true, fromLeveller: true, params: { gain: 0 } },
  ],
})

describe('曲线跟什么走', () => {
  const fx = parseAudioFxChain(fxChain)
  it('压低生成的跟时间线走，音量关键帧、平稳音量和别的效果参数跟内容走，速度曲线不动', () => {
    expect(laneFollows('fx.n1.gain', fx)).toBe('timeline')
    expect(laneFollows('volume', fx)).toBe('content')
    expect(laneFollows('fx.n2.gain', fx)).toBe('content')
    expect(laneFollows('fx.n9.frequency', fx)).toBe('content')
    expect(laneFollows('preset.voice-clean', fx)).toBe('content')
    expect(laneFollows('rate', fx)).toBeNull()
  })
})

describe('片段改了以后曲线跟着走', () => {
  // 4 秒的片段放在时间线第 10 秒，从素材第 5 秒放起，原速
  const placed: ClipPlacement = { start: 10, inPoint: 5, rate: 1 }
  const volume = {
    target: 'volume',
    points: [
      { t: 0, v: 1 },
      { t: 1, v: 0.25 },
      { t: 3, v: 0.25 },
      { t: 4, v: 1 },
    ],
  }
  const duck = {
    target: 'fx.n1.gain',
    points: [
      { t: 0, v: 0 },
      { t: 1, v: -6 },
      { t: 3, v: -6 },
      { t: 4, v: 0 },
    ],
  }
  const both = text([volume, duck])
  /** 改完以后两条曲线：[音量关键帧, 压低]；不动时是 null。 */
  const followed = (after: Partial<ClipPlacement>, lanes = both) => {
    const written = followAutomation(lanes, fxChain, placed, { ...placed, ...after }, 0)
    return written === null ? null : lanesOf(written).map((lane) => lane.points)
  }

  it('挪动：音量关键帧不动，压低留在时间线上原来的位置（往后挪时去掉 0 秒以前的、0 秒补一个点）', () => {
    expect(followed({ start: 12 })).toEqual([
      volume.points,
      [
        { t: 0, v: -6 },
        { t: 1, v: -6 },
        { t: 2, v: 0 },
      ],
    ])
    // 往前挪：前面空出来的不补点
    expect(followed({ start: 9 })).toEqual([
      volume.points,
      [
        { t: 1, v: 0 },
        { t: 2, v: -6 },
        { t: 4, v: -6 },
        { t: 5, v: 0 },
      ],
    ])
  })

  it('裁左边：两种曲线都往前平移，0 秒上的值按原曲线算', () => {
    expect(followed({ start: 11, inPoint: 6 })).toEqual([
      [
        { t: 0, v: 0.25 },
        { t: 2, v: 0.25 },
        { t: 3, v: 1 },
      ],
      [
        { t: 0, v: -6 },
        { t: 2, v: -6 },
        { t: 3, v: 0 },
      ],
    ])
  })

  it('只改入点：音量关键帧跟着内容平移，压低不动', () => {
    expect(followed({ inPoint: 5.5 })).toEqual([
      [
        { t: 0, v: 0.625 },
        { t: 0.5, v: 0.25 },
        { t: 2.5, v: 0.25 },
        { t: 3.5, v: 1 },
      ],
      duck.points,
    ])
  })

  it('改速度：音量关键帧按比例压缩或拉长（结尾以后的点留着），压低不动', () => {
    expect(followed({ rate: 2 })).toEqual([
      [
        { t: 0, v: 1 },
        { t: 0.5, v: 0.25 },
        { t: 1.5, v: 0.25 },
        { t: 2, v: 1 },
      ],
      duck.points,
    ])
    expect(followed({ rate: 0.5 })?.[0]).toEqual([
      { t: 0, v: 1 },
      { t: 2, v: 0.25 },
      { t: 6, v: 0.25 },
      { t: 8, v: 1 },
    ])
  })

  it('裁右边：开始、入点、速度都没变，不动', () => {
    expect(followed({})).toBeNull()
  })

  it('只有跟内容走的曲线时挪动不动；没有曲线、读不出时不动', () => {
    expect(followed({ start: 12 }, text([volume]))).toBeNull()
    expect(followAutomation(undefined, fxChain, placed, { ...placed, start: 12 }, 0)).toBeNull()
    expect(followAutomation('{oops', fxChain, placed, { ...placed, start: 12 }, 0)).toBeNull()
  })

  it('变速的片段：裁左边 1 秒（入点多用 2 秒）两种都平移 1 秒，只改入点按速度折算', () => {
    const fast = { ...placed, rate: 2 }
    const trimmed = followAutomation(both, fxChain, fast, { ...fast, start: 11, inPoint: 7 }, 0)
    expect(lanesOf(trimmed ?? '').map((lane) => lane.points[1])).toEqual([
      { t: 2, v: 0.25 },
      { t: 2, v: -6 },
    ])
    const slipped = followAutomation(text([volume]), fxChain, fast, { ...fast, inPoint: 6 }, 0)
    expect(lanesOf(slipped ?? '')[0]?.points).toEqual([
      { t: 0, v: 0.625 },
      { t: 0.5, v: 0.25 },
      { t: 2.5, v: 0.25 },
      { t: 3.5, v: 1 },
    ])
  })

  it('弯曲的一段被 0 秒切开：按原曲线重采，放出来的值不变', () => {
    const bent = {
      target: 'volume',
      points: [
        { t: 0, v: 1, curve: 0.6 },
        { t: 2, v: 0.2 },
        { t: 4, v: 0.2 },
      ],
    }
    const trimmed = { ...placed, start: 11.2, inPoint: 6.2 }
    const [lane] = lanesOf(followAutomation(text([bent]), fxChain, placed, trimmed, 0) ?? '')
    expect(lane?.points[0]?.t).toBe(0)
    for (const t of [0, 0.2, 0.5, 0.8, 1.5, 2.5])
      expect(sampleAutomationLane(lane ?? bent, t)).toBeCloseTo(
        sampleAutomationLane(bent, 1.2 + t),
        2,
      )
  })

  it('速度曲线不跟着换算', () => {
    const rate = {
      target: 'rate',
      points: [
        { t: 0, v: 1 },
        { t: 4, v: 2 },
      ],
    }
    const written = followAutomation(
      text([rate, volume]),
      fxChain,
      placed,
      { ...placed, start: 11, inPoint: 6 },
      0,
    )
    expect(lanesOf(written ?? '')[0]).toEqual(rate)
  })
})

describe('压低的曲线跟着它压的人声走', () => {
  // 配乐 0–4 秒压人声组；人声：视频片段 0–2 秒、对白 2–3 秒，都在人声组里
  const duck = {
    target: 'fx.n1.gain',
    points: [
      { t: 0, v: 0 },
      { t: 1, v: -6 },
      { t: 3, v: -6 },
      { t: 4, v: 0 },
    ],
  }
  const music = audio({
    duration: 4_000,
    fxCarve: JSON.stringify({ enabled: true, sources: ['voice'], strength: 0.25 }),
    fxChain,
    automation: text([duck]),
  })
  const shot = video({ duration: 2_000, audioGroup: 'voice' })
  const talk = audio({
    id: 'talk',
    src: 'https://media.test/audio/talk.mp3',
    start: 2_000,
    duration: 1_000,
    audioGroup: 'voice',
  })
  const before = [music, shot, talk]
  /** 挪完以后配乐要写的压低曲线；不动时是 undefined。 */
  const duckAfter = (after: FilmClip[]) => {
    const written = curvesFollowing(before, after).get('music-1')
    return written === undefined ? undefined : lanesOf(written)[0]?.points
  }
  const later = <T extends FilmClip>(clip: T, ms: number): T => ({
    ...clip,
    start: clip.start + ms,
  })

  it('只挪配乐：压低留在时间线上原来的位置', () => {
    expect(duckAfter([later(music, 1_000), shot, talk])).toEqual([
      { t: 0, v: -6 },
      { t: 2, v: -6 },
      { t: 3, v: 0 },
    ])
  })

  it('配乐和它压的人声一起挪同样的时间：压低不动', () => {
    expect(duckAfter([later(music, 1_000), later(shot, 1_000), later(talk, 1_000)])).toBeUndefined()
  })

  it('只有人声整体挪了：压低跟着挪同样的时间', () => {
    expect(duckAfter([music, later(shot, 500), later(talk, 500)])).toEqual([
      { t: 0.5, v: 0 },
      { t: 1.5, v: -6 },
      { t: 3.5, v: -6 },
      { t: 4.5, v: 0 },
    ])
  })

  it('人声各挪各的：不能靠平移跟上，压低不动（等选中时重量）', () => {
    expect(duckAfter([music, later(shot, 500), later(talk, 300)])).toBeUndefined()
    expect(voicesShift([shot, talk], [later(shot, 500), later(talk, 300)])).toBe(0)
    // 人声裁了、多了少了也不算整体挪
    expect(voicesShift([shot], [{ ...later(shot, 500), duration: 1_500 }])).toBe(0)
    expect(voicesShift([shot, talk], [later(shot, 500)])).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { audio, video } from '@/testing/final-cut'
import {
  beatsToSnap,
  clipBeats,
  isBeatSource,
  shownBeats,
  snapDropToBeats,
  snapEdgeToBeats,
  snapSpanToBeats,
  timelineBeats,
  type BeatGrid,
} from './music-beats'
import { snapTargets } from './timeline-scale'

// 十秒、每 0.5 秒一拍，每 4 拍（2 秒）一个强拍
const steady: BeatGrid = {
  beats: Array.from({ length: 20 }, (_, index) => index * 0.5),
  downbeats: Array.from({ length: 5 }, (_, index) => index * 2),
  seconds: 10,
}
const msOf = (beats: readonly { ms: number }[]) => beats.map((beat) => beat.ms)

describe('节拍放到时间线上', () => {
  it('从入点起、按速度换算，只要片段用到的那段，强拍照音频里的标', () => {
    // 从音频第 1 秒放起、2 倍速、片段长 2 秒：用到音频的第 1 到 5 秒
    const beats = clipBeats(
      audio({ start: 10_000, mediaStart: 1_000, playbackRate: 2, duration: 2_000 }),
      steady,
    )
    expect(msOf(beats)).toEqual([
      10_000, 10_250, 10_500, 10_750, 11_000, 11_250, 11_500, 11_750, 12_000,
    ])
    expect(msOf(beats.filter((beat) => beat.strong))).toEqual([10_500, 11_500])
  })

  it('循环播放的片段放完一遍从入点重来，节拍跟着重复；不循环的放完就没有', () => {
    const short: BeatGrid = { beats: [0.5, 1.5], downbeats: [0.5], seconds: 2 }
    expect(msOf(clipBeats(audio({ duration: 5_000, loop: true }), short))).toEqual([
      500, 1_500, 2_500, 3_500, 4_500,
    ])
    expect(msOf(clipBeats(audio({ duration: 5_000 }), short))).toEqual([500, 1_500])
    // 从第 1 秒放起：一圈只剩 1 秒，只有 1.5 秒那一拍
    expect(
      msOf(clipBeats(audio({ duration: 3_000, mediaStart: 1_000, loop: true }), short)),
    ).toEqual([500, 1_500, 2_500])
  })
})

describe('节拍太密', () => {
  const beats = clipBeats(audio({ duration: 10_000 }), steady)

  it('每拍隔得够开时每一拍都画、都能吸', () => {
    // 一秒 30 像素：每拍隔 15 像素
    expect(shownBeats(beats, 30)).toHaveLength(20)
  })

  it('每拍挤在一起时只留强拍', () => {
    // 一秒 10 像素：每拍隔 5 像素，强拍隔 20 像素
    expect(msOf(shownBeats(beats, 10))).toEqual([0, 2_000, 4_000, 6_000, 8_000])
  })

  it('强拍也挤在一起时一个都不留', () => {
    // 一秒 2 像素：强拍隔 4 像素
    expect(shownBeats(beats, 2)).toEqual([])
  })
})

describe('吸到节拍', () => {
  // 一秒 100 像素：片段两端和播放头的吸附范围是 80 毫秒，节拍的是 52 毫秒
  const PPS = 100
  const targets = snapTargets([{ id: 'a', start: 0, duration: 2_000 }], 9_000)

  it('片段的两端先于节拍：够得着片段的边时吸边，哪怕节拍更近', () => {
    expect(snapEdgeToBeats(2_050, targets, [2_060], PPS)).toEqual({ ms: 2_000, guideMs: 2_000 })
    expect(snapSpanToBeats(2_050, 500, targets, [2_060], PPS)).toEqual({
      ms: 2_000,
      guideMs: 2_000,
    })
  })

  it('够不着片段的边时吸节拍，范围比吸边小', () => {
    expect(snapEdgeToBeats(2_150, targets, [2_180], PPS)).toEqual({ ms: 2_180, guideMs: 2_180 })
    expect(snapEdgeToBeats(2_250, targets, [2_180], PPS)).toEqual({ ms: 2_250, guideMs: null })
    // 挪片段：结尾离节拍近就让结尾吸上去
    expect(snapSpanToBeats(4_480, 1_000, targets, [5_500], PPS)).toEqual({
      ms: 4_500,
      guideMs: 5_500,
    })
  })
})

describe('谁的节拍', () => {
  const grids = new Map([['https://media.test/audio/music.mp3', steady]])

  it('只算角色是配乐、没静音的音频片段', () => {
    expect(isBeatSource(audio())).toBe(true)
    expect(isBeatSource(audio({ hidden: true }))).toBe(false)
    expect(isBeatSource(audio({ audioGroup: 'voice' }))).toBe(false)
    expect(
      isBeatSource(
        audio({
          dub: { locale: 'en', caption: 'c1', trimmed: false, text: null, voice: null, speed: 1 },
        }),
      ),
    ).toBe(false)
    expect(isBeatSource(video())).toBe(false)
    expect([
      ...timelineBeats([audio({ hidden: true }), audio({ id: 'music-2' })], grids, 100).keys(),
    ]).toEqual(['music-2'])
  })

  it('正在动的配乐不吸自己的节拍，别的配乐的照吸', () => {
    const beats = timelineBeats(
      [audio({ duration: 1_000 }), audio({ id: 'music-2', start: 5_000, duration: 1_000 })],
      grids,
      100,
    )
    expect(beatsToSnap(beats, new Set(['music-1']))).toEqual([5_000, 5_500, 6_000])
  })
})

describe('从侧栏拖进来时吸附', () => {
  // 视频片段 0–2.1 秒，配乐 0–10 秒（每 0.5 秒一拍），播放头在 9 秒；一秒 100 像素
  const clips = [video({ duration: 2_100 }), audio({ duration: 10_000 })]
  const grids = new Map([['https://media.test/audio/music.mp3', steady]])

  it('片段的边先于节拍：够得着边时吸边，哪怕节拍更近', () => {
    expect(snapDropToBeats(2_030, 300, clips, 9_000, grids, 100)).toEqual({
      ms: 2_100,
      guideMs: 2_100,
    })
  })

  it('够不着边和播放头时吸配乐的节拍；还没算出节拍时不吸', () => {
    expect(snapDropToBeats(3_480, 300, clips, 9_000, grids, 100)).toEqual({
      ms: 3_500,
      guideMs: 3_500,
    })
    expect(snapDropToBeats(3_480, 300, clips, 9_000, new Map(), 100)).toEqual({
      ms: 3_480,
      guideMs: null,
    })
  })
})

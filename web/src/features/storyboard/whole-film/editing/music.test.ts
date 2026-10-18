import { describe, expect, it } from 'vitest'
import { contextOf, draftOf, expectOk, source, video } from '@/testing/whole-film'
import { insertMaterial } from './layer0'
import {
  filmBeats,
  musicShortfallMs,
  removeMusic,
  setMusic,
  setMusicOffset,
  setMusicVolume,
} from './music'

const context = contextOf(
  { s1: source(60_000) },
  {
    long: {
      durationMs: 30_000,
      beats: [0, 500, 1_000, 1_500].map((timeMs, k) => ({ timeMs, strong: k % 4 === 0 })),
    },
    short: { durationMs: 8_000 },
  },
)

/** 整片 10 秒 */
const film = () => draftOf([video('v1', 's1', 0, 10_000)])

describe('setMusic', () => {
  it('起点收进 [0, 音乐时长 − 整片时长]，音量默认 1', () => {
    const { draft } = expectOk(setMusic(film(), { jobId: 'long', offsetMs: 25_000 }, context))
    expect(draft.music).toEqual({ jobId: 'long', offset: 20_000, volume: 1 })
    const negative = expectOk(setMusic(film(), { jobId: 'long', offsetMs: -5 }, context)).draft
    expect(negative.music?.offset).toBe(0)
  })

  it('换歌时沿用原来的音量；音量收进 0–2', () => {
    const first = expectOk(setMusic(film(), { jobId: 'long', volume: 3 }, context)).draft
    expect(first.music?.volume).toBe(2)
    const second = expectOk(setMusic(first, { jobId: 'short' }, context)).draft
    expect(second.music).toEqual({ jobId: 'short', offset: 0, volume: 2 })
  })

  it('音乐比整片短：照样用，起点为 0，差多少由 musicShortfallMs 报告，不循环', () => {
    const { draft } = expectOk(setMusic(film(), { jobId: 'short', offsetMs: 1_000 }, context))
    expect(draft.music?.offset).toBe(0)
    expect(musicShortfallMs(draft, context)).toBe(2_000)
  })

  it('加段让整片变长后，音乐不够长也由 musicShortfallMs 报告', () => {
    const withMusic = expectOk(setMusic(film(), { jobId: 'long', offsetMs: 20_000 }, context)).draft
    expect(musicShortfallMs(withMusic, context)).toBe(0)
    const longer = expectOk(
      insertMaterial(
        withMusic,
        { sourceJobId: 's1', playbackStart: 0, duration: 3_000, at: { videoIndex: 1 } },
        context,
      ),
    ).draft
    expect(longer.music?.offset).toBe(20_000)
    expect(musicShortfallMs(longer, context)).toBe(3_000)
    expect(musicShortfallMs(film(), context)).toBe(0)
  })

  it('音乐不在上下文里：拒绝', () => {
    expect(setMusic(film(), { jobId: 'x' }, context)).toEqual({
      ok: false,
      refusal: 'unknown-music',
    })
  })
})

describe('setMusicOffset / setMusicVolume / removeMusic', () => {
  const withMusic = () =>
    expectOk(setMusic(film(), { jobId: 'long', offsetMs: 1_000 }, context)).draft

  it('拖音乐改起点，收进范围；没变原样返回', () => {
    expect(
      expectOk(setMusicOffset(withMusic(), { offsetMs: 50_000 }, context)).draft.music?.offset,
    ).toBe(20_000)
    const before = withMusic()
    expect(expectOk(setMusicOffset(before, { offsetMs: 1_000 }, context)).draft).toBe(before)
  })

  it('配乐音量收进 0–2', () => {
    expect(expectOk(setMusicVolume(withMusic(), { volume: -1 })).draft.music?.volume).toBe(0)
    expect(expectOk(setMusicVolume(withMusic(), { volume: 0.35 })).draft.music?.volume).toBe(0.35)
  })

  it('没有音乐时拒绝改起点和音量；移除', () => {
    expect(setMusicOffset(film(), { offsetMs: 0 }, context)).toEqual({
      ok: false,
      refusal: 'no-music',
    })
    expect(setMusicVolume(film(), { volume: 1 })).toEqual({ ok: false, refusal: 'no-music' })
    expect(expectOk(removeMusic(withMusic())).draft.music).toBeNull()
    const none = film()
    expect(expectOk(removeMusic(none)).draft).toBe(none)
  })
})

describe('filmBeats', () => {
  it('拍点换算到整片时间，起点之前的拍点不算；不截到片尾', () => {
    const { draft } = expectOk(setMusic(film(), { jobId: 'long', offsetMs: 600 }, context))
    expect(filmBeats(draft, context)).toEqual([
      { timeMs: 400, strong: false },
      { timeMs: 900, strong: false },
    ])
    const shortFilm = draftOf([video('v1', 's1', 0, 200)], {
      music: { jobId: 'long', offset: 0, volume: 1 },
    })
    expect(filmBeats(shortFilm, context).map((b) => b.timeMs)).toEqual([0, 500, 1_000, 1_500])
    expect(filmBeats(film(), context)).toEqual([])
  })
})

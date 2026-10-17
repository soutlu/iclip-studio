import { describe, expect, it } from 'vitest'
import { EMPTY_FILM, insertSegment, type FilmState } from './film-draft'
import {
  beatGridOf,
  beatsOf,
  alignmentOf,
  chooseStart,
  clampStart,
  gainAt,
  internalCuts,
  musicGainCurve,
  MUSIC_BED_GAIN,
  MUSIC_DUCKED_GAIN,
  placeMusic,
  speechSpansOf,
  stepStart,
  withFadeOut,
  type Song,
} from './film-music'
import type { FilmSubtitle } from './film-subtitles'

const song = (duration: number, offset = 0): Song => ({
  duration,
  grid: { bpm: 120, interval: 0.5, offset },
})

describe('拍点', () => {
  it('按未取整的速度排拍，取整的 bpm 只给人看', () => {
    expect(beatGridOf({ bpm: 120, offset: 0.12, tempo: 119.6 })).toEqual({
      bpm: 120,
      interval: 60 / 119.6,
      offset: 0.12,
    })
    expect(beatGridOf({ bpm: 128, offset: 0 })).toEqual({ bpm: 128, interval: 60 / 128, offset: 0 })
  })

  it.each([
    ['速度不是正数', { bpm: 0, offset: 0 }],
    ['第一拍在负时刻', { bpm: 120, offset: -0.1 }],
    ['不是数', { bpm: Number.NaN, offset: 0 }],
  ])('%s：当作没有检测到拍子', (_, guessed) => {
    expect(beatGridOf(guessed)).toBeNull()
  })

  it('从第一拍起每 4 拍一小节，排到整首结束为止', () => {
    expect(beatsOf({ duration: 2.6, grid: { bpm: 120, interval: 0.5, offset: 0.1 } })).toEqual([
      { at: 0.1, downbeat: true },
      { at: 0.6, downbeat: false },
      { at: 1.1, downbeat: false },
      { at: 1.6, downbeat: false },
      { at: 2.1, downbeat: true },
    ])
    expect(beatsOf({ duration: 30, grid: null })).toEqual([])
  })
})

const filmOf = (...lengths: number[]): FilmState =>
  lengths.reduce(
    (state, length, at) =>
      insertSegment(state, { sourceJobId: 'A', start: 0, end: length }, at, `s${at}`) ?? state,
    EMPTY_FILM,
  )

describe('对齐', () => {
  it('切点是相邻两段的交界，不含开头与结尾', () => {
    expect(internalCuts(filmOf(1, 1.25, 1.75).segments)).toEqual([1, 2.25])
    expect(internalCuts(filmOf(3).segments)).toEqual([])
  })

  it('命中数与误差相同，偏好小节第一拍和开头踩拍，再取最早的', () => {
    expect(chooseStart(song(20), 4, [1, 2.25])).toBe(1)
  })

  it(`离最近的拍不超过 60 毫秒才算落在拍上`, () => {
    const placed = (cut: number) => alignmentOf(song(20), 0, [cut])
    expect(placed(1.05).onBeat).toEqual([1.05])
    expect(placed(1.07).onBeat).toEqual([])
  })

  it('选择非整数拍起点，把原先错开的内部切点真正移到拍上', () => {
    const cuts = [1.25, 2.25]
    expect(alignmentOf(song(20), 0, cuts).onBeat).toEqual([])
    const start = chooseStart(song(20), 4, cuts)
    expect(start % 0.5).toBe(0.25)
    expect(alignmentOf(song(20), start, cuts).onBeat).toEqual(cuts)
  })

  it('内部切点命中数优先于第一帧踩拍', () => {
    const cuts = [0.5, 1.25, 2.25]
    const start = chooseStart(song(20), 4, cuts)
    expect(alignmentOf(song(20), start, cuts).onBeat).toEqual([1.25, 2.25])
  })

  it('命中数相同时选择误差更小的相位', () => {
    const cuts = [1.01, 1.5, 2]
    const start = chooseStart(song(20), 4, cuts)
    const errorAt = (offset: number) =>
      cuts.reduce((sum, cut) => {
        const time = offset + cut
        return sum + Math.abs(time - Math.round(time / 0.5) * 0.5)
      }, 0)
    expect(errorAt(start)).toBeCloseTo(0.01)
    expect(errorAt(start)).toBeLessThan(errorAt(0.49))
  })

  it('起点加视频段总长要放得下：最好的起点超出整首时只在放得下的里面选', () => {
    expect(chooseStart(song(4.8), 4, [3])).toBe(0)
    expect(chooseStart(song(20), 4, [3])).toBe(1)
  })

  it('没有检测到拍子：从 0 秒起，没有切点落在拍上', () => {
    const placement = placeMusic({ duration: 20, grid: null }, 4, [1, 2], null)
    expect(placement).toMatchObject({ start: 0, userPlaced: false, onBeat: [], cutCount: 2 })
  })

  it('人拖到的起点还放得下就用它；剪辑变长放不下了就自动重选', () => {
    expect(placeMusic(song(20), 4, [1], 6)).toMatchObject({ start: 6, userPlaced: true })
    expect(placeMusic(song(20), 15, [1], 6)).toMatchObject({ start: 1, userPlaced: false })
  })

  it('音乐比视频段短：从 0 秒起，记下短多少，不循环补', () => {
    expect(placeMusic(song(3), 4.25, [1], null)).toMatchObject({
      start: 0,
      available: 3,
      shortBy: 1.25,
    })
    expect(placeMusic(song(4), 4, [1], null).shortBy).toBe(0)
  })

  it('手动起点保留非拍相位和毫秒精度，只限制在可用范围里', () => {
    expect(clampStart(song(20), 4, 2.2)).toBe(2.2)
    expect(clampStart(song(20), 4, 2.5014)).toBe(2.501)
    expect(clampStart(song(20), 4, 30)).toBe(16)
    expect(clampStart(song(20.0006), 4, 30)).toBe(16)
    expect(clampStart(song(20), 4, -1)).toBe(0)
    expect(clampStart({ duration: 10, grid: null }, 4, 7.25)).toBe(6)
    expect(clampStart({ duration: 3, grid: null }, 4, 1)).toBe(0)
  })

  it('键盘每步微调 0.1 秒，十步为 1 秒，到头为止', () => {
    expect(stepStart(song(20), 4, 2.25, 1)).toBe(2.35)
    expect(stepStart(song(20), 4, 2, -10)).toBe(1)
    expect(stepStart(song(20), 4, 15.5, 10)).toBe(16)
  })
})

const subtitle = (kind: FilmSubtitle['kind'], at: number, end: number): FilmSubtitle => ({
  key: `${kind}${at}`,
  kind,
  textKey: `${kind}${at}`,
  segmentId: 's0',
  at,
  end,
  text: '',
})

describe('音量曲线', () => {
  it('口播时段只取识别出的句子，从已合成版本恢复的字幕不算', () => {
    expect(
      speechSpansOf([
        subtitle('sentence', 1, 2),
        subtitle('snapshot', 3, 4),
        subtitle('sentence', 5, 6),
      ]),
    ).toEqual([
      { at: 1, end: 2 },
      { at: 5, end: 6 },
    ])
  })

  it('没有口播：整段衬底音量', () => {
    expect(musicGainCurve([], 4)).toEqual([
      { atMs: 0, gain: MUSIC_BED_GAIN },
      { atMs: 4000, gain: MUSIC_BED_GAIN },
    ])
    expect(musicGainCurve([], 0)).toEqual([])
  })

  it('一句口播：前 0.3 秒降下来，说完 0.3 秒升回去', () => {
    expect(musicGainCurve([{ at: 1, end: 2 }], 4)).toEqual([
      { atMs: 0, gain: MUSIC_BED_GAIN },
      { atMs: 700, gain: MUSIC_BED_GAIN },
      { atMs: 1000, gain: MUSIC_DUCKED_GAIN },
      { atMs: 2000, gain: MUSIC_DUCKED_GAIN },
      { atMs: 2300, gain: MUSIC_BED_GAIN },
      { atMs: 4000, gain: MUSIC_BED_GAIN },
    ])
  })

  it('两句之间不够一下一上两段渐变（≤ 0.6 秒）就连成一段；再宽就各自压低', () => {
    const merged = musicGainCurve(
      [
        { at: 1, end: 2 },
        { at: 2.6, end: 3 },
      ],
      5,
    )
    expect(merged.map((point) => point.atMs)).toEqual([0, 700, 1000, 3000, 3300, 5000])

    const apart = musicGainCurve(
      [
        { at: 1, end: 2 },
        { at: 2.7, end: 3 },
      ],
      5,
    )
    expect(apart.map((point) => point.atMs)).toEqual([
      0, 700, 1000, 2000, 2300, 2400, 2700, 3000, 3300, 5000,
    ])
  })

  it('贴着两头的口播：开头那刻已压到一半以下，结尾停在压低处', () => {
    const curve = musicGainCurve(
      [
        { at: 0.1, end: 1 },
        { at: 3.5, end: 4 },
      ],
      4,
    )
    expect(curve[0]).toEqual({
      atMs: 0,
      gain:
        Math.round((MUSIC_BED_GAIN + ((MUSIC_DUCKED_GAIN - MUSIC_BED_GAIN) * 2) / 3) * 1000) / 1000,
    })
    expect(curve.at(-1)).toEqual({ atMs: 4000, gain: MUSIC_DUCKED_GAIN })
  })

  it('预览叠上结尾 2 秒线性淡出，到总长处为 0；淡出之前不变', () => {
    const faded = withFadeOut(musicGainCurve([], 4), 4000)
    expect(gainAt(faded, 1000)).toBe(MUSIC_BED_GAIN)
    expect(gainAt(faded, 2000)).toBe(MUSIC_BED_GAIN)
    expect(gainAt(faded, 3000)).toBeCloseTo(MUSIC_BED_GAIN / 2, 2)
    expect(gainAt(faded, 4000)).toBe(0)
  })
})

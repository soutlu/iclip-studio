import { describe, expect, it } from 'vitest'
import { FILM_AUDIO_RATE, integratedLoudness, mixFilmAudio, type FilmPcm } from './film-audio'

const tone = (
  frequency: number,
  { seconds = 4, rate = FILM_AUDIO_RATE, channels = 1, amplitude = 0.1, pause = false } = {},
): FilmPcm => ({
  sampleRate: rate,
  channels: Array.from({ length: channels }, () =>
    Float32Array.from({ length: Math.round(seconds * rate) }, (_, frame) =>
      pause && (frame < 2 * rate || frame >= 6 * rate)
        ? 0
        : amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate),
    ),
  ),
})

const peakOf = (pcm: FilmPcm) =>
  pcm.channels.reduce(
    (peak, channel) => channel.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), peak),
    0,
  )

describe('预览音频定量校验', () => {
  it.each([0, 0.5, 2])('原声音量 %s 在母线归一后仍生效', (volume) => {
    const source = tone(1000)
    const baseline = mixFilmAudio([{ source, start: 0, end: 4 }], null)
    const adjusted = mixFilmAudio([{ source, start: 0, end: 4, volume }], null)
    expect(peakOf(adjusted) / peakOf(baseline)).toBeCloseTo(volume, 4)
  })

  it.each([0, 0.5, 2])('只有配乐时，音量 %s 不会被自动拉回', (volume) => {
    const music = {
      source: tone(1000),
      start: 0,
      bodyStart: 0,
      bodyDuration: 4,
      curve: [{ atMs: 0, gain: 0.5 }],
    }
    const segments = [{ source: null, start: 0, end: 4 }]
    const baseline = mixFilmAudio(segments, music)
    const adjusted = mixFilmAudio(segments, { ...music, volume })
    expect(peakOf(adjusted) / peakOf(baseline)).toBeCloseTo(volume, 4)
  })

  it('同一来源不同段独立调音，原声静音后仍保留配乐', () => {
    const source = tone(1000)
    const mixed = mixFilmAudio(
      [
        { source, start: 0, end: 2, volume: 0.5 },
        { source, start: 0, end: 2, volume: 1 },
      ],
      null,
    )
    const left = mixed.channels[0]
    expect((left?.[4812] ?? 0) / (left?.[2 * FILM_AUDIO_RATE + 4812] ?? 1)).toBeCloseTo(0.5, 4)
    const withMusic = mixFilmAudio([{ source, start: 0, end: 4, volume: 0 }], {
      source: tone(500),
      start: 0,
      bodyStart: 0,
      bodyDuration: 4,
      curve: [{ atMs: 0, gain: 0.5 }],
    })
    expect(peakOf(withMusic)).toBeGreaterThan(0)
  })

  // 同样 Float32 PCM 送本机 FFmpeg loudnorm=print_format=json 得到 input_i。
  // 命令：ffmpeg -f f32le -ar <rate> -ac <channels> -i input.f32 -af loudnorm=print_format=json -f null -
  // FFmpeg 输出使用响度直方图取整；容许 0.15 LU，不把双方量化差当作精确相等。
  it.each([
    ['1 kHz 单声道', 1000, {}, -23.05],
    ['1 kHz 双声道', 1000, { channels: 2 }, -20.05],
    ['100 Hz', 100, {}, -24.85],
    ['10 kHz', 10000, {}, -19.65],
    ['44.1 kHz 采样', 1000, { rate: 44_100 }, -23.05],
  ] as const)('BS.1770 与 FFmpeg 对账：%s', (_, frequency, options, expected) => {
    expect(Math.abs(integratedLoudness(tone(frequency, options)) - expected)).toBeLessThan(0.15)
  })

  it('带静音的门限测量匹配 FFmpeg ebur128；记录 loudnorm 路径的测量差', () => {
    const measured = integratedLoudness(tone(1000, { seconds: 8, pause: true }))
    // 相同 PCM 实测：ebur128=-23.3，loudnorm input_i=-23.55。loudnorm 的分帧和直方图不同，
    // 这里锁住这组样本的差异，不把预览称为与服务端精确相同。
    expect(Math.abs(measured - -23.3)).toBeLessThan(0.05)
    expect(Math.abs(measured - -23.55)).toBeLessThan(0.3)
  })

  it('正常原声统一到 -14 LUFS，输出时长不变，左右声道同相，不修改来源', () => {
    const source = tone(1000)
    const before = source.channels[0]?.slice()
    const mixed = mixFilmAudio([{ source, start: 0, end: 4 }], null)
    expect(mixed.channels[0]).toHaveLength(4 * FILM_AUDIO_RATE)
    expect(mixed.channels[1]).toEqual(mixed.channels[0])
    expect(Math.abs(integratedLoudness(mixed) - -14)).toBeLessThan(0.05)
    expect(peakOf(mixed)).toBeLessThanOrEqual(10 ** (-1.5 / 20) + 1e-6)
    expect(source.channels[0]).toEqual(before)
  })

  it('各来源先统一响度，每段两端 50 ms 线性淡入淡出，切点归零', () => {
    const mixed = mixFilmAudio(
      [
        { source: tone(1000, { amplitude: 0.03 }), start: 0, end: 2 },
        { source: tone(1000, { amplitude: 0.1 }), start: 0, end: 2 },
      ],
      null,
    )
    const left = mixed.channels[0]
    const body = Math.abs(left?.[4812] ?? 0)
    expect(body).toBeGreaterThan(0)
    expect((left?.[12] ?? 0) / body).toBeCloseTo(0.005, 4)
    expect(Math.abs(left?.[2 * FILM_AUDIO_RATE - 12] ?? 0) / body).toBeCloseTo(0.005, 4)
    expect(left?.[2 * FILM_AUDIO_RATE]).toBe(0)
    expect((left?.[2 * FILM_AUDIO_RATE + 4812] ?? 0) / body).toBeCloseTo(1, 3)
  })

  it('音乐只铺正文，按原曲起点、duck 曲线与最后 2 秒淡出；片头片尾仍无音乐', () => {
    const source = tone(1000, { seconds: 12 })
    const mixed = mixFilmAudio([{ source: null, start: 0, end: 10 }], {
      source,
      start: 1,
      bodyStart: 1,
      bodyDuration: 8,
      curve: [
        { atMs: 0, gain: 0.5 },
        { atMs: 2000, gain: 0.5 },
        { atMs: 2010, gain: 0.125 },
        { atMs: 4000, gain: 0.125 },
        { atMs: 4010, gain: 0.5 },
      ],
    })
    const left = mixed.channels[0]
    expect(left?.slice(0, FILM_AUDIO_RATE).every((sample) => sample === 0)).toBe(true)
    expect(left?.slice(9 * FILM_AUDIO_RATE).every((sample) => sample === 0)).toBe(true)
    const bed = Math.abs(left?.[2 * FILM_AUDIO_RATE + 12] ?? 0)
    expect(Math.abs(left?.[4 * FILM_AUDIO_RATE + 12] ?? 0) / bed).toBeCloseTo(0.25, 3)
    expect(Math.abs(left?.[8 * FILM_AUDIO_RATE + 12] ?? 0) / bed).toBeCloseTo(0.5, 3)
  })

  it('突峰限制到 -1.5 dBFS，静音与短于测量窗的片段不产生 NaN', () => {
    const source = tone(1000, { amplitude: 0.001 })
    if (source.channels[0] !== undefined) source.channels[0][FILM_AUDIO_RATE] = 1
    const mixed = mixFilmAudio([{ source, start: 0, end: 4 }], null)
    expect(peakOf(mixed)).toBeLessThanOrEqual(10 ** (-1.5 / 20) + 1e-6)
    expect(peakOf(mixed)).toBeGreaterThan(0.8)
    const silent = mixFilmAudio([{ source: null, start: 0, end: 0.2 }], null)
    expect(peakOf(silent)).toBe(0)
    expect(integratedLoudness(silent)).toBe(-Infinity)
  })
})

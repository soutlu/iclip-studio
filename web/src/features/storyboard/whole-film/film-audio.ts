/** 整片预览的 PCM 混音。处理顺序与 contract/conventions §12 一致；浏览器重采样与限幅包络不承诺和
 * FFmpeg 逐采样相同。所有时间取视频时间线，只有音乐曲线取正文时间。 */

import { gainAt, MUSIC_FADE_OUT_SECONDS, type GainPoint } from './film-music'

export const FILM_AUDIO_RATE = 48_000
const SOURCE_LUFS = -16
const FILM_LUFS = -14
const PEAK = 10 ** (-1.5 / 20)
const EDGE_SECONDS = 0.05

export type FilmPcm = { sampleRate: number; channels: readonly Float32Array[] }
export type FilmAudioSegment = {
  source: FilmPcm | null
  start: number
  end: number
  volume?: number
}
export type FilmAudioMusic = {
  source: FilmPcm
  start: number
  bodyStart: number
  bodyDuration: number
  curve: readonly GainPoint[]
  volume?: number
}

/** BS.1770 的 K 加权两级滤波器；系数生成与 libebur128 的 ebur128_init_filter 对账：
 * https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c 。只量声道能量，不处理真峰值。 */
const kFilters = (rate: number) => {
  const shelf = Math.tan((Math.PI * 1681.974450955533) / rate)
  const q = 0.7071752369554196
  const high = 10 ** (3.999843853973347 / 20)
  const middle = high ** 0.4996667741545416
  const denominator = 1 + shelf / q + shelf * shelf
  const highPass = Math.tan((Math.PI * 38.13547087602444) / rate)
  const highPassDenominator = 1 + highPass / 0.5003270373238773 + highPass * highPass
  return [
    [
      (high + (middle * shelf) / q + shelf * shelf) / denominator,
      (2 * (shelf * shelf - high)) / denominator,
      (high - (middle * shelf) / q + shelf * shelf) / denominator,
      (2 * (shelf * shelf - 1)) / denominator,
      (1 - shelf / q + shelf * shelf) / denominator,
    ],
    [
      1,
      -2,
      1,
      (2 * (highPass * highPass - 1)) / highPassDenominator,
      (1 - highPass / 0.5003270373238773 + highPass * highPass) / highPassDenominator,
    ],
  ] as const
}

/** EBU R128 综合响度：400 ms 窗、100 ms 步长，先 -70 LUFS 绝对门限，再 -10 LU 相对门限。
 * 不足 400 ms、或没有超过门限的声音时为 -Infinity，和服务端一样不放大。输入是 mono / stereo。 */
export const integratedLoudness = ({ sampleRate, channels }: FilmPcm): number => {
  const length = channels[0]?.length ?? 0
  const step = Math.round(sampleRate / 10)
  const window = step * 4
  if (length < window) return -Infinity
  const blocks = new Float64Array(Math.floor(length / step))
  const filters = kFilters(sampleRate)
  for (const channel of channels) {
    const states = filters.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
    for (let frame = 0; frame < blocks.length * step; frame += 1) {
      let value = channel[frame] ?? 0
      for (const [index, [b0, b1, b2, a1, a2]] of filters.entries()) {
        const state = states[index]
        if (state === undefined) continue
        const filtered = b0 * value + b1 * state.x1 + b2 * state.x2 - a1 * state.y1 - a2 * state.y2
        state.x2 = state.x1
        state.x1 = value
        state.y2 = state.y1
        state.y1 = filtered
        value = filtered
      }
      const block = Math.floor(frame / step)
      blocks[block] = (blocks[block] ?? 0) + value * value
    }
  }
  const energies: number[] = []
  const absoluteGate = 10 ** ((-70 + 0.691) / 10)
  for (let index = 3; index < blocks.length; index += 1) {
    const energy =
      ((blocks[index] ?? 0) +
        (blocks[index - 1] ?? 0) +
        (blocks[index - 2] ?? 0) +
        (blocks[index - 3] ?? 0)) /
      window
    if (energy >= absoluteGate) energies.push(energy)
  }
  if (energies.length === 0) return -Infinity
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  const relativeGate = mean(energies) / 10
  return -0.691 + 10 * Math.log10(mean(energies.filter((energy) => energy >= relativeGate)))
}

/** 服务端以两位小数 dB 施加增益，静音不调，最多放大 20 dB。 */
const normalizationGain = (source: FilmPcm, target: number) => {
  const loudness = integratedLoudness(source)
  return Number.isFinite(loudness)
    ? 10 ** (Number(Math.min(20, target - loudness).toFixed(2)) / 20)
    : 1
}

/** 在任意采样率的 mono / stereo 上取样；mono 等功率铺到双声道，维持来源综合响度。 */
const sampleAt = (source: FilmPcm, channel: number, seconds: number) => {
  const plane = source.channels[channel] ?? source.channels[0]
  if (plane === undefined || seconds < 0) return 0
  const frame = seconds * source.sampleRate
  const left = Math.floor(frame)
  const value = (plane[left] ?? 0) + ((plane[left + 1] ?? 0) - (plane[left] ?? 0)) * (frame - left)
  return value * (source.channels.length === 1 ? Math.SQRT1_2 : 1)
}

/** 双声道联动的采样峰值限幅：提前 5 ms 收住突峰、50 ms 放开。包络与 FFmpeg alimiter 不同，
 * 但同样不自动拉满、不引入播放延迟，且每个输出采样均不超过 -1.5 dBFS。 */
const limitPeak = (channels: readonly Float32Array[]) => {
  const length = channels[0]?.length ?? 0
  const envelope = new Float32Array(length)
  const attack = FILM_AUDIO_RATE * 0.005
  const release = FILM_AUDIO_RATE * 0.05
  let following = 1
  for (let frame = length - 1; frame >= 0; frame -= 1) {
    const peak = Math.max(Math.abs(channels[0]?.[frame] ?? 0), Math.abs(channels[1]?.[frame] ?? 0))
    following = Math.min(1, peak > PEAK ? PEAK / peak : 1, following + 1 / attack)
    envelope[frame] = following
  }
  let previous = 1
  for (let frame = 0; frame < length; frame += 1) {
    previous = Math.min(envelope[frame] ?? 1, previous + 1 / release)
    for (const channel of channels) channel[frame] = (channel[frame] ?? 0) * previous
  }
}

/** 原声按整条来源测响度再裁段；模板也是普通段。音乐只铺正文，先归一再 duck / 淡出，两路相加后
 * 母线增益按未手调的参考混音计算，避免把用户调低的音量再次拉高；最后限幅。
 * 返回全新的 48 kHz stereo PCM，不修改调用方或查询缓存中的声音。 */
export const mixFilmAudio = (
  segments: readonly FilmAudioSegment[],
  music: FilmAudioMusic | null,
): FilmPcm => {
  const count = Math.round(
    segments.reduce((sum, segment) => sum + segment.end - segment.start, 0) * FILM_AUDIO_RATE,
  )
  const channels = [new Float32Array(count), new Float32Array(count)]
  const adjusted =
    segments.some((segment) => (segment.volume ?? 1) !== 1) ||
    (music !== null && (music.volume ?? 1) !== 1)
  const reference = adjusted ? [new Float32Array(count), new Float32Array(count)] : channels
  const gains = new Map<FilmPcm, number>()
  const sourceGain = (source: FilmPcm) => {
    const known = gains.get(source)
    if (known !== undefined) return known
    const gain = normalizationGain(source, SOURCE_LUFS)
    gains.set(source, gain)
    return gain
  }
  let at = 0
  for (const segment of segments) {
    const duration = segment.end - segment.start
    const length = Math.round(duration * FILM_AUDIO_RATE)
    const fade = Math.min(EDGE_SECONDS, duration / 2)
    if (segment.source !== null) {
      const gain = sourceGain(segment.source)
      for (let frame = 0; frame < length; frame += 1) {
        const clock = frame / FILM_AUDIO_RATE
        const level = gain * Math.min(1, clock / fade, (duration - clock) / fade)
        for (const [index, channel] of channels.entries()) {
          const sample = sampleAt(segment.source, index, segment.start + clock) * level
          channel[at + frame] = sample * (segment.volume ?? 1)
          const referenceChannel = reference[index]
          if (adjusted && referenceChannel !== undefined) referenceChannel[at + frame] = sample
        }
      }
    }
    at += length
  }
  if (music !== null) {
    const gain = sourceGain(music.source)
    const start = Math.round(music.bodyStart * FILM_AUDIO_RATE)
    const length = Math.round(music.bodyDuration * FILM_AUDIO_RATE)
    const fade = Math.min(MUSIC_FADE_OUT_SECONDS, music.bodyDuration)
    // 后端按 10 ms 帧求值，同一帧 480 个采样复用一次曲线结果，避免逐采样扫描几百个曲线点。
    const duckFrames = Array.from({ length: Math.ceil(music.bodyDuration * 100) }, (_, frame) =>
      gainAt(music.curve, frame * 10),
    )
    for (let frame = 0; frame < length && start + frame < count; frame += 1) {
      const clock = frame / FILM_AUDIO_RATE
      // 后端 asetnsamples 的 10 ms 帧求值，结尾淡出按采样线性处理。
      const duck = duckFrames[Math.floor(frame / (FILM_AUDIO_RATE / 100))] ?? 0
      const level = gain * duck * Math.min(1, (music.bodyDuration - clock) / fade)
      for (const [index, channel] of channels.entries()) {
        const sample = sampleAt(music.source, index, music.start + clock) * level
        channel[start + frame] = (channel[start + frame] ?? 0) + sample * (music.volume ?? 1)
        const referenceChannel = reference[index]
        if (adjusted && referenceChannel !== undefined)
          referenceChannel[start + frame] = (referenceChannel[start + frame] ?? 0) + sample
      }
    }
  }
  const result = { sampleRate: FILM_AUDIO_RATE, channels }
  const gain = normalizationGain({ sampleRate: FILM_AUDIO_RATE, channels: reference }, FILM_LUFS)
  for (const channel of channels)
    for (let frame = 0; frame < channel.length; frame += 1)
      channel[frame] = (channel[frame] ?? 0) * gain
  limitPeak(channels)
  return result
}

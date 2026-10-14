/** 读一首音乐：下载、解码成整段声音（预览混音直接用它），量出拍子与波形。只经 `useMusicAnalysis` 动态加载，
 * 拍点检测库（web-audio-beat-detector）跟着这个模块进单独的包，不进首屏。 */

import { guess } from 'web-audio-beat-detector'
import { beatGridOf, type Song } from './film-music'

/** 波形每秒取几个峰值：音乐轨上一秒十几像素，够画包络。 */
const PEAK_RATE = 50

/** 拍点检测库在整首都找不出拍子时抛的那一句；只有它算「没有拍子」，别的错照常抛出。 */
const NO_BEATS = /detectable beats/

export type MusicAnalysis = Song & {
  /** 解码好的整首，预览时交给 Web Audio 播。 */
  buffer: AudioBuffer
  /** 每秒 `rate` 个峰值，0–1（按整首最响处归一）。 */
  peaks: { rate: number; values: number[] }
}

const peaksOf = (buffer: AudioBuffer): MusicAnalysis['peaks'] => {
  const bucket = Math.max(1, Math.round(buffer.sampleRate / PEAK_RATE))
  const count = Math.ceil(buffer.length / bucket)
  const values = Array.from({ length: count }, () => 0)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) {
      const at = Math.floor(index / bucket)
      const level = Math.abs(data[index] ?? 0)
      if (level > (values[at] ?? 0)) values[at] = level
    }
  }
  const loudest = Math.max(...values, 0)
  return {
    rate: buffer.sampleRate / bucket,
    values: loudest === 0 ? values : values.map((value) => value / loudest),
  }
}

/** 下载并解码 `url`，量拍子与波形。下载、解码失败照常抛出；整首找不出拍子不算失败，`grid` 为 null。 */
export const analyzeMusic = async (url: string, signal?: AbortSignal): Promise<MusicAnalysis> => {
  // 外链素材下载：音乐在对象存储上，不经 apiFetch。
  const response = await fetch(url, signal === undefined ? {} : { signal })
  if (!response.ok) throw new Error(`音乐下载失败：${response.status}`)
  const bytes = await response.arrayBuffer()
  // 解码不需要出声，离线上下文不受浏览器「先有手势才能出声」的限制。
  const buffer = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(bytes)
  let grid: Song['grid'] = null
  try {
    // 类型里只写了 bpm 与 offset，运行时还带未取整的 tempo（GuessedBeat 里是可选的）。
    grid = beatGridOf(await guess(buffer))
  } catch (error) {
    if (!(error instanceof Error && NO_BEATS.test(error.message))) throw error
  }
  return { buffer, duration: buffer.duration, grid, peaks: peaksOf(buffer) }
}

import { guess } from 'web-audio-beat-detector'
import { audioBufferPeaks, type AudioPeaks } from '../editing/audio-peaks'
import { beatGridOf, type Song } from './film-music'
import { FILM_AUDIO_RATE } from './film-audio'

// web-audio-beat-detector 在整首都找不出拍子时抛出这一句，其余错误照常抛出。
const NO_BEATS = /detectable beats/

export type MusicAnalysis = Song & {
  buffer: AudioBuffer
  peaks: AudioPeaks
}

export const analyzeMusic = async (url: string, signal?: AbortSignal): Promise<MusicAnalysis> => {
  // 外链素材下载：音乐在对象存储上，不经 apiFetch。
  const response = await fetch(url, signal === undefined ? {} : { signal })
  if (!response.ok) throw new Error(`音乐下载失败：${response.status}`)
  const bytes = await response.arrayBuffer()
  // 离线上下文不受浏览器「先有用户手势才能出声」的限制。
  const buffer = await new OfflineAudioContext(1, 1, FILM_AUDIO_RATE).decodeAudioData(bytes)
  let grid: Song['grid'] = null
  try {
    // 类型里只写了 bpm 与 offset，运行时还带未取整的 tempo（GuessedBeat 里是可选的）。
    grid = beatGridOf(await guess(buffer))
  } catch (error) {
    if (!(error instanceof Error && NO_BEATS.test(error.message))) throw error
  }
  return { buffer, duration: buffer.duration, grid, peaks: audioBufferPeaks(buffer) }
}

import { readAudioTrack } from '../editing/media-file'
import { FILM_AUDIO_RATE, type FilmPcm } from './film-audio'

export const readFilmAudioSource = (url: string, signal: AbortSignal): Promise<FilmPcm | null> =>
  readAudioTrack(
    url,
    async ({ numberOfChannels, duration, samples }) => {
      // 单声道保持单声道，铺到双声道由混音完成；多声道按 Web Audio 的扬声器规则下混到立体声。
      const offline = new OfflineAudioContext(
        Math.min(2, await numberOfChannels()),
        Math.max(1, Math.ceil((await duration()) * FILM_AUDIO_RATE)),
        FILM_AUDIO_RATE,
      )
      for await (const sample of samples) {
        const source = offline.createBufferSource()
        source.buffer = sample.toAudioBuffer()
        source.connect(offline.destination)
        source.start(Math.max(0, sample.timestamp), Math.max(0, -sample.timestamp))
      }
      signal.throwIfAborted()
      const buffer = await offline.startRendering()
      signal.throwIfAborted()
      return pcmOf(buffer)
    },
    { failure: '预览原声读取失败，请重试', signal },
  )

export const pcmOf = (buffer: AudioBuffer): FilmPcm => ({
  sampleRate: buffer.sampleRate,
  channels: Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  ),
})

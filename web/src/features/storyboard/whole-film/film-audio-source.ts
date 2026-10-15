/** 视频原声只在整片预览需要时解码；没有音轨是静音，下载/解码失败必须展示错误。 */

import { AudioSampleSink, Input, MP4, QTFF, UrlSource } from 'mediabunny'
import { UserFacingError } from '@/shared/api/client'
import { FILM_AUDIO_RATE, type FilmPcm } from './film-audio'

/** 保留原始声道测量所需的 PCM；浏览器完成重采样。mono 等功率铺到 stereo，与服务端一致。 */
export const readFilmAudioSource = async (
  url: string,
  signal: AbortSignal,
): Promise<FilmPcm | null> => {
  const input = new Input({ source: new UrlSource(url), formats: [MP4, QTFF] })
  const abort = () => input.dispose()
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const track = await input.getPrimaryAudioTrack()
    if (track === null) return null
    if (!(await track.canDecode())) throw new UserFacingError('当前浏览器无法解码视频原声')
    const duration = await input.computeDuration([track])
    const offline = new OfflineAudioContext(
      2,
      Math.max(1, Math.ceil(duration * FILM_AUDIO_RATE)),
      FILM_AUDIO_RATE,
    )
    for await (const sample of new AudioSampleSink(track).samples()) {
      try {
        signal.throwIfAborted()
        const source = offline.createBufferSource()
        source.buffer = sample.toAudioBuffer()
        const gain = offline.createGain()
        gain.gain.value = sample.numberOfChannels === 1 ? Math.SQRT1_2 : 1
        source.connect(gain).connect(offline.destination)
        source.start(Math.max(0, sample.timestamp), Math.max(0, -sample.timestamp))
      } finally {
        sample.close()
      }
    }
    signal.throwIfAborted()
    const buffer = await offline.startRendering()
    signal.throwIfAborted()
    return pcmOf(buffer)
  } catch (cause) {
    signal.throwIfAborted()
    throw cause instanceof UserFacingError
      ? cause
      : new UserFacingError('预览原声读取失败，请重试', { cause })
  } finally {
    signal.removeEventListener('abort', abort)
    input.dispose()
  }
}

/** 共享 AudioBuffer 的只读采样视图；后续混音只写新数组。 */
export const pcmOf = (buffer: AudioBuffer): FilmPcm => ({
  sampleRate: buffer.sampleRate,
  channels: Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  ),
})

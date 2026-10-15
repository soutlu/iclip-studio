/** PCM 混音与响度计算放在 worker，长时间线不阻塞拖拽和输入。 */
import { mixFilmAudio, type FilmAudioMusic, type FilmAudioSegment } from './film-audio'

self.onmessage = ({
  data,
}: MessageEvent<{ segments: FilmAudioSegment[]; music: FilmAudioMusic | null }>) => {
  try {
    const pcm = mixFilmAudio(data.segments, data.music)
    self.postMessage({ pcm }, { transfer: pcm.channels.map((channel) => channel.buffer) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '预览混音失败' })
  }
}

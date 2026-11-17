import { rhythmSteps } from '@hyperframes/core/audio-analysis'
import type { BeatGrid } from './music-beats'

// 每算这么久（毫秒）让界面喘一口气
const SLICE_MS = 8

const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 用引擎的节拍分析（只靠信号处理）算一段解好的声音（单声道，`sampleRate` 的采样）的节拍和强拍。分成小段算，
 * 中间让出主线程，不卡界面；一首三分钟的配乐大约要一秒。没有稳定的节拍（太短、不成拍子）时是 null。
 */
export async function analyseBeats(
  samples: Float32Array,
  sampleRate: number,
): Promise<BeatGrid | null> {
  const steps = rhythmSteps({ sampleRate, channels: [samples] })
  let sliceStart = performance.now()
  for (;;) {
    const next = steps.next()
    if (next.done) {
      const { beats, downbeats } = next.value
      return beats.times.length === 0
        ? null
        : { beats: beats.times, downbeats: downbeats.times, seconds: samples.length / sampleRate }
    }
    if (performance.now() - sliceStart >= SLICE_MS) {
      await breathe()
      sliceStart = performance.now()
    }
  }
}

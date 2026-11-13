/** 一条音轨的波形：每秒 `rate` 个峰值；`duration` 是这条音轨的时长（秒）。 */
export type AudioPeaks = { rate: number; peaks: number[]; duration: number }

const PEAKS_PER_SECOND = 50

export const peakCollector = () => {
  const peaks: number[] = []
  return {
    add(samples: ArrayLike<number>, startSeconds: number, sampleRate: number) {
      for (let frame = 0; frame < samples.length; frame += 1) {
        const bucket = Math.floor((startSeconds + frame / sampleRate) * PEAKS_PER_SECOND)
        if (bucket >= 0) peaks[bucket] = Math.max(peaks[bucket] ?? 0, Math.abs(samples[frame] ?? 0))
      }
    },
    result(duration: number): AudioPeaks {
      const filled = Array.from(peaks, (peak) => peak ?? 0)
      const loudest = Math.max(0, ...filled)
      return {
        rate: PEAKS_PER_SECOND,
        peaks: loudest === 0 ? filled : filled.map((peak) => peak / loudest),
        duration,
      }
    },
  }
}

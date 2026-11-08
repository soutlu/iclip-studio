export type AudioPeaks = { rate: number; peaks: number[] }

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
    result(): AudioPeaks {
      const filled = Array.from(peaks, (peak) => peak ?? 0)
      const loudest = Math.max(0, ...filled)
      return {
        rate: PEAKS_PER_SECOND,
        peaks: loudest === 0 ? filled : filled.map((peak) => peak / loudest),
      }
    },
  }
}

export const audioBufferPeaks = (buffer: AudioBuffer): AudioPeaks => {
  const collector = peakCollector()
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1)
    collector.add(buffer.getChannelData(channel), 0, buffer.sampleRate)
  return collector.result()
}

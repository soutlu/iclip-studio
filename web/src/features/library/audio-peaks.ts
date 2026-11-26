/** 波形分几段：和入库时后端算的一样多。 */
const PEAK_BUCKETS = 120

/**
 * 按入库时后端的规则算波形峰值：各声道平均成单声道，分 `buckets` 段，每段取采样绝对值的最大值，
 * 按最响的一段归一到 1，保留 3 位小数；全程静音时全是 0。
 */
export function peaksOf(channels: readonly Float32Array[], buckets = PEAK_BUCKETS): number[] {
  const count = channels[0]?.length ?? 0
  const levels: number[] = []
  for (let index = 0; index < buckets; index += 1) {
    let level = 0
    const end = Math.floor(((index + 1) * count) / buckets)
    for (let sample = Math.floor((index * count) / buckets); sample < end; sample += 1) {
      let sum = 0
      for (const channel of channels) sum += channel[sample] ?? 0
      level = Math.max(level, Math.abs(sum / channels.length))
    }
    levels.push(level)
  }
  const loudest = Math.max(0, ...levels)
  return levels.map((level) => (loudest === 0 ? 0 : Math.round((level / loudest) * 1000) / 1000))
}

export type LocalAudioLevels = { durationMs: number; peaks: number[] }

/**
 * 在浏览器里解码本地选的音频，量出时长和波形峰值。浏览器不支持或解不出来时是 null（只是不画波形，
 * 能不能入库以后端为准）。
 */
export async function measureLocalAudio(file: File): Promise<LocalAudioLevels | null> {
  if (typeof OfflineAudioContext !== 'function') return null
  try {
    // 只用来解码，不出声：1 个采样的离线上下文就够
    const context = new OfflineAudioContext(1, 1, 44_100)
    const buffer = await context.decodeAudioData(await file.arrayBuffer())
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index),
    )
    return { durationMs: Math.round(buffer.duration * 1000), peaks: peaksOf(channels) }
  } catch {
    return null
  }
}

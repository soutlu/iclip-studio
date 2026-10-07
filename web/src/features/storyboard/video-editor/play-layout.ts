/** 预览连着放的一串段：每段从哪条素材的哪一截放，排在整条预览的哪个时刻。 */

/** 播放器里连着放的一段：从 `mediaUrl` 的 `start` 放到 `end`（秒，素材自己的时间）。 */
export type PlaySegment = { mediaUrl: string; start: number; end: number }

/** 排好时钟的一段：`at` 是它在整条预览里的起点。 */
export type LaidOutSegment = PlaySegment & { at: number; duration: number }

/** 按顺序排上时钟；零长的段不占时钟。 */
export const layoutPlay = (segments: readonly PlaySegment[]): LaidOutSegment[] => {
  const laid: LaidOutSegment[] = []
  let at = 0
  for (const segment of segments) {
    const duration = Math.max(0, segment.end - segment.start)
    if (duration === 0) continue
    laid.push({ ...segment, at, duration })
    at += duration
  }
  return laid
}

export const totalDuration = (segments: readonly LaidOutSegment[]): number =>
  segments.reduce((sum, segment) => sum + segment.duration, 0)

/** 时钟落在哪一段、段内偏移多少；超出末尾就是最后一段的结尾。 */
export const locateClock = (
  segments: readonly LaidOutSegment[],
  clock: number,
): { index: number; offset: number } | undefined => {
  if (segments.length === 0) return undefined
  if (clock < 0) return { index: 0, offset: 0 }
  const index = segments.findIndex(
    (segment) => clock >= segment.at && clock < segment.at + segment.duration,
  )
  const hit = segments[index]
  if (hit !== undefined) return { index, offset: clock - hit.at }
  const last = segments.length - 1
  return { index: last, offset: segments[last]?.duration ?? 0 }
}

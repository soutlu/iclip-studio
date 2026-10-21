export type PlaySegment = { mediaUrl: string; start: number; end: number }

export type LaidOutSegment = PlaySegment & { at: number; duration: number }

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

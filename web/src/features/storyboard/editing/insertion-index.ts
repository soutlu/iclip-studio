const GAP_SLACK_MS = 70

export const insertionIndex = (
  lengthsMs: readonly number[],
  pointMs: number,
  gap: { index: number; lengthMs: number } | undefined,
): number => {
  if (gap !== undefined) {
    const start = lengthsMs.slice(0, gap.index).reduce((sum, length) => sum + length, 0)
    if (pointMs >= start - GAP_SLACK_MS && pointMs <= start + gap.lengthMs + GAP_SLACK_MS)
      return gap.index
  }
  let start = 0
  for (const [index, length] of lengthsMs.entries()) {
    const shifted = start + (gap !== undefined && index >= gap.index ? gap.lengthMs : 0)
    if (pointMs < shifted + length / 2) return index
    start += length
  }
  return lengthsMs.length
}

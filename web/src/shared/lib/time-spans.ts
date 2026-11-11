export type TimeSpan = { start: number; end: number }

export const spansOf = (ranges: TimeRanges): TimeSpan[] =>
  Array.from({ length: ranges.length }, (_, at) => ({
    start: ranges.start(at),
    end: ranges.end(at),
  }))

export const sameSpans = (left: readonly TimeSpan[], right: readonly TimeSpan[]) =>
  left.length === right.length &&
  left.every((span, at) => span.start === right[at]?.start && span.end === right[at].end)

const TOUCHING_SECONDS = 0.05

export const windowSpans = (
  spans: readonly TimeSpan[],
  from: number,
  to: number,
  at: number,
): TimeSpan[] =>
  spans.flatMap(({ start, end }) => {
    const first = Math.max(start, from)
    const last = Math.min(end, to)
    return last > first ? [{ start: at + first - from, end: at + last - from }] : []
  })

export const mergeSpans = (spans: readonly TimeSpan[]): TimeSpan[] => {
  const merged: TimeSpan[] = []
  for (const span of spans.toSorted((left, right) => left.start - right.start)) {
    const last = merged.at(-1)
    if (last !== undefined && span.start <= last.end + TOUCHING_SECONDS)
      last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

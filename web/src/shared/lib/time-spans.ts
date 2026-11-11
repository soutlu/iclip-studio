export type TimeSpan = { start: number; end: number }

export const spansOf = (ranges: TimeRanges): TimeSpan[] =>
  Array.from({ length: ranges.length }, (_, at) => ({
    start: ranges.start(at),
    end: ranges.end(at),
  }))

export const sameSpans = (left: readonly TimeSpan[], right: readonly TimeSpan[]) =>
  left.length === right.length &&
  left.every((span, at) => span.start === right[at]?.start && span.end === right[at].end)

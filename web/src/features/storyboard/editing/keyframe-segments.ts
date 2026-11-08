import type { SecondsRange } from './clip'

export type KeyframeIndex = { keyframes: number[]; duration: number }

export const keyframeRanges = (index: {
  keyframes: readonly number[]
  duration: number
}): SecondsRange[] => {
  const cuts = [
    ...new Set([0, ...index.keyframes.filter((time) => time > 0 && time < index.duration)]),
  ].sort((left, right) => left - right)
  return cuts.map((start, at) => ({ start, end: cuts[at + 1] ?? index.duration }))
}

import { roundToMs } from '../editing/clip'
import { layoutFilm, type FilmSegment } from './film-draft'
import type { FilmSubtitle } from './film-subtitles'

export const BEAT_TOLERANCE = 0.06

export const BEATS_PER_BAR = 4

export const MUSIC_BED_DB = -6

export const MUSIC_DUCKED_DB = -18

export const DUCK_RAMP_SECONDS = 0.3

export const MUSIC_FADE_OUT_SECONDS = 2

const round3 = (value: number) => Math.round(value * 1000) / 1000
const dbToGain = (db: number) => round3(10 ** (db / 20))

export const MUSIC_BED_GAIN = dbToGain(MUSIC_BED_DB)
export const MUSIC_DUCKED_GAIN = dbToGain(MUSIC_DUCKED_DB)

const EPSILON = 1e-6

export type BeatGrid = { bpm: number; interval: number; offset: number }

export type Song = { duration: number; grid: BeatGrid | null }

// web-audio-beat-detector 的类型里没有 `tempo`，运行时有未取整的速度。
export type GuessedBeat = { bpm: number; offset: number; tempo?: number }

export const beatGridOf = ({ bpm, offset, tempo }: GuessedBeat): BeatGrid | null => {
  const speed = tempo !== undefined && Number.isFinite(tempo) && tempo > 0 ? tempo : bpm
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(speed) || speed <= 0) return null
  if (!Number.isFinite(offset) || offset < 0) return null
  return { bpm: Math.round(bpm), interval: 60 / speed, offset }
}

export type Beat = { at: number; downbeat: boolean }

const beatCount = (song: Song): number => {
  const { grid } = song
  if (grid === null || grid.offset >= song.duration) return 0
  return Math.floor((song.duration - grid.offset) / grid.interval - EPSILON) + 1
}

const beatAt = (grid: BeatGrid, index: number): Beat => ({
  at: grid.offset + index * grid.interval,
  downbeat: index % BEATS_PER_BAR === 0,
})

export const beatsOf = (song: Song): Beat[] => {
  const { grid } = song
  return grid === null
    ? []
    : Array.from({ length: beatCount(song) }, (_, index) => beatAt(grid, index))
}

const nearestBeat = (song: Song, time: number): Beat | undefined => {
  const count = beatCount(song)
  if (song.grid === null || count === 0) return undefined
  const index = Math.min(
    count - 1,
    Math.max(0, Math.round((time - song.grid.offset) / song.grid.interval)),
  )
  return beatAt(song.grid, index)
}

export const internalCuts = (segments: readonly FilmSegment[]): number[] =>
  layoutFilm(segments)
    .slice(1)
    .map((placed) => placed.at)

export const alignmentOf = (
  song: Song,
  start: number,
  cuts: readonly number[],
): { onBeat: number[]; score: number } => {
  const onBeat: number[] = []
  let score = 0
  for (const cut of cuts) {
    const beat = nearestBeat(song, start + cut)
    if (beat === undefined || Math.abs(beat.at - (start + cut)) > BEAT_TOLERANCE + EPSILON) continue
    onBeat.push(cut)
    score += beat.downbeat ? 2 : 1
  }
  return { onBeat, score }
}

const fits = (song: Song, total: number, start: number): boolean =>
  start >= -EPSILON && start + total <= song.duration + EPSILON

export const candidateStarts = (
  song: Song,
  total: number,
  cuts: readonly number[] = [],
): number[] =>
  [...new Set(beatsOf(song).flatMap((beat) => [0, ...cuts].map((cut) => roundToMs(beat.at - cut))))]
    .filter((start) => fits(song, total, start))
    .toSorted((left, right) => left - right)

export const chooseStart = (song: Song, total: number, cuts: readonly number[]): number => {
  let best: { start: number; count: number; error: number; score: number } | undefined
  for (const start of candidateStarts(song, total, cuts)) {
    const { onBeat, score } = alignmentOf(song, start, cuts)
    const error = onBeat.reduce((sum, cut) => {
      const beat = nearestBeat(song, start + cut)
      return sum + (beat === undefined ? 0 : Math.abs(beat.at - (start + cut)))
    }, 0)
    const opening = alignmentOf(song, start, [0]).onBeat.length * 0.25
    const next = { start, count: onBeat.length, error, score: score + opening }
    if (
      best === undefined ||
      next.count > best.count ||
      (next.count === best.count &&
        (next.error < best.error - EPSILON ||
          (Math.abs(next.error - best.error) <= EPSILON && next.score > best.score)))
    )
      best = next
  }
  return best?.start ?? 0
}

export type MusicPlacement = {
  start: number
  userPlaced: boolean
  available: number
  shortBy: number
  onBeat: number[]
  cutCount: number
}

export const placeMusic = (
  song: Song,
  total: number,
  cuts: readonly number[],
  userStart: number | null,
): MusicPlacement => {
  const userPlaced = userStart !== null && fits(song, total, userStart)
  const start = userPlaced ? userStart : chooseStart(song, total, cuts)
  const available = Math.max(0, song.duration - start)
  const shortBy = roundToMs(Math.max(0, total - available))
  return {
    start,
    userPlaced,
    available,
    shortBy: shortBy < 0.001 ? 0 : shortBy,
    onBeat: alignmentOf(song, start, cuts).onBeat,
    cutCount: cuts.length,
  }
}

export const clampStart = (song: Song, total: number, raw: number): number => {
  if (!Number.isFinite(raw)) throw new RangeError('音乐起点必须是有限数值')
  const latest = Math.floor(Math.max(0, song.duration - total) * 1000 + EPSILON) / 1000
  return Math.min(latest, Math.max(0, roundToMs(raw)))
}

export const stepStart = (song: Song, total: number, current: number, steps: number): number =>
  clampStart(song, total, current + steps * 0.1)

export type GainPoint = { atMs: number; gain: number }

export type SpeechSpan = { at: number; end: number }

export const speechSpansOf = (subtitles: readonly FilmSubtitle[]): SpeechSpan[] =>
  subtitles.flatMap((item) => (item.kind === 'sentence' ? [{ at: item.at, end: item.end }] : []))

export const gainAt = (points: readonly GainPoint[], atMs: number): number => {
  const first = points[0]
  if (first === undefined) return MUSIC_BED_GAIN
  if (atMs <= first.atMs) return first.gain
  let left = first
  for (const right of points) {
    if (atMs <= right.atMs) {
      if (right.atMs === left.atMs) return right.gain
      return left.gain + ((right.gain - left.gain) * (atMs - left.atMs)) / (right.atMs - left.atMs)
    }
    left = right
  }
  return left.gain
}

export const musicGainCurve = (speech: readonly SpeechSpan[], total: number): GainPoint[] => {
  const totalMs = Math.round(total * 1000)
  if (totalMs <= 0) return []
  const ramp = Math.round(DUCK_RAMP_SECONDS * 1000)
  const spans = speech
    .map((span) => ({
      from: Math.max(0, Math.round(span.at * 1000)),
      to: Math.min(totalMs, Math.round(span.end * 1000)),
    }))
    .filter((span) => span.to > span.from)
    .toSorted((left, right) => left.from - right.from)
  const merged: { from: number; to: number }[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span.from - ramp <= last.to + ramp)
      last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }
  const raw: GainPoint[] = merged.flatMap(({ from, to }) => [
    { atMs: from - ramp, gain: MUSIC_BED_GAIN },
    { atMs: from, gain: MUSIC_DUCKED_GAIN },
    { atMs: to, gain: MUSIC_DUCKED_GAIN },
    { atMs: to + ramp, gain: MUSIC_BED_GAIN },
  ])
  const valueAt = (atMs: number) => (raw.length === 0 ? MUSIC_BED_GAIN : gainAt(raw, atMs))
  const times = [
    ...new Set([
      0,
      ...raw.map((point) => point.atMs).filter((at) => at > 0 && at < totalMs),
      totalMs,
    ]),
  ].toSorted((left, right) => left - right)
  return times.map((atMs) => ({ atMs, gain: round3(valueAt(atMs)) }))
}

const FADE_SAMPLE_MS = 100

export const withFadeOut = (curve: readonly GainPoint[], totalMs: number): GainPoint[] => {
  if (curve.length === 0 || totalMs <= 0) return []
  const fadeMs = Math.min(MUSIC_FADE_OUT_SECONDS * 1000, totalMs)
  const fadeFrom = Math.max(0, totalMs - fadeMs)
  const samples = Array.from(
    { length: Math.floor((totalMs - fadeFrom) / FADE_SAMPLE_MS) },
    (_, index) => fadeFrom + (index + 1) * FADE_SAMPLE_MS,
  )
  const times = [...new Set([...curve.map((point) => point.atMs), fadeFrom, ...samples, totalMs])]
    .filter((at) => at >= 0 && at <= totalMs)
    .toSorted((left, right) => left - right)
  return times.map((atMs) => ({
    atMs,
    gain: round3(gainAt(curve, atMs) * Math.min(1, Math.max(0, (totalMs - atMs) / fadeMs))),
  }))
}

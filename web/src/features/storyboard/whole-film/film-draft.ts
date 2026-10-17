import { z } from 'zod'
import { zMusicGainPoint } from '@/shared/api/generated/zod.gen'
import { roundToMs, type Clip } from '../editing/clip'
import type { GainPoint } from './film-music'
import {
  MAX_FILM_SECONDS,
  MAX_FILM_SEGMENTS,
  MAX_MUSIC_GAIN_POINTS,
  MAX_VOLUME,
} from './film-limits'

export const MIN_SEGMENT_SECONDS = 0.2

export type FilmSegment = Clip & {
  id: string
  volume?: number | undefined
  subtitles?: readonly { id: string; start: number; end: number; text: string }[] | undefined
}

export type FilmMusic = (
  | {
      kind: 'upload'
      jobId: string
      name: string | null
      url: string
      userStart: number | null
      verifyAccess?: boolean | undefined
    }
  | { kind: 'generate'; jobId: string; userStart: number | null }
) & {
  volume?: number | undefined
  gain?: readonly GainPoint[] | undefined
}

export type FilmBrand = {
  templateId: string
  name: string | null
  url: string
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
}
export type BrandPosition = 'intro' | 'outro'

export type FilmFont = { fontId: string; name: string; url: string }

export type FilmState = {
  segments: readonly FilmSegment[]
  texts: Readonly<Record<string, string>>
  music: FilmMusic | null
  intro?: FilmBrand | null
  outro?: FilmBrand | null
  font?: FilmFont | null
}

export const EMPTY_FILM: FilmState = { segments: [], texts: {}, music: null }

const clearMusicGain = (state: FilmState): FilmState =>
  state.music?.gain === undefined ? state : { ...state, music: { ...state.music, gain: undefined } }

const checkedVolume = (volume: number): number => {
  if (!Number.isFinite(volume) || volume < 0 || volume > MAX_VOLUME)
    throw new RangeError(`音量必须是 0 到 ${MAX_VOLUME} 之间的有限数值`)
  return volume
}

export const setSegmentVolume = (state: FilmState, id: string, volume: number): FilmState => {
  checkedVolume(volume)
  const at = state.segments.findIndex((segment) => segment.id === id)
  const segment = state.segments[at]
  if (segment === undefined || (segment.volume ?? 1) === volume) return state
  return { ...state, segments: state.segments.with(at, { ...segment, volume }) }
}

export const setFont = (state: FilmState, font: FilmFont | null): FilmState => ({ ...state, font })

export const sentenceKey = (subtitleJobId: string, index: number): string =>
  `${subtitleJobId}#${index}`

export const segmentDuration = (segment: Clip): number => roundToMs(segment.end - segment.start)

export type PlacedSegment = { segment: FilmSegment; at: number; duration: number }

export const layoutFilm = (segments: readonly FilmSegment[]): PlacedSegment[] => {
  let at = 0
  return segments.map((segment) => {
    const duration = segmentDuration(segment)
    const placed = { segment, at: roundToMs(at), duration }
    at += duration
    return placed
  })
}

export const filmDuration = (segments: readonly FilmSegment[]): number =>
  roundToMs(segments.reduce((sum, segment) => sum + segmentDuration(segment), 0))

export const brandDuration = (film: FilmState): number =>
  ((film.intro?.durationMs ?? 0) + (film.outro?.durationMs ?? 0)) / 1000
export const wholeFilmDuration = (film: FilmState): number =>
  roundToMs(filmDuration(film.segments) + brandDuration(film))
export const setBrand = (
  film: FilmState,
  position: BrandPosition,
  template: FilmBrand | null,
): FilmState => ({ ...film, [position]: template })

const segmentAt = (segments: readonly FilmSegment[], clock: number): PlacedSegment | undefined =>
  layoutFilm(segments).find((placed) => clock >= placed.at && clock < placed.at + placed.duration)

export const insertIndexAt = (segments: readonly FilmSegment[], clock: number): number => {
  const index = layoutFilm(segments).findIndex((placed) => placed.at + placed.duration / 2 > clock)
  return index < 0 ? segments.length : index
}

export const insertClockOf = (segments: readonly FilmSegment[], index: number): number =>
  layoutFilm(segments)[index]?.at ?? filmDuration(segments)

const fitsInFilm = (segments: readonly FilmSegment[], duration: number, reserved: number) =>
  filmDuration(segments) + roundToMs(duration) + reserved <= MAX_FILM_SECONDS + 1e-9

const seconds = (value: number) => value.toFixed(1)

export const insertBlockedReason = (
  segments: readonly FilmSegment[],
  duration: number,
  reserved: number,
): string | undefined => {
  if (roundToMs(duration) < MIN_SEGMENT_SECONDS - 1e-9)
    return `镜头不足 ${MIN_SEGMENT_SECONDS} 秒，无法加入成片；请拖动两端扩大范围`
  if (segments.length >= MAX_FILM_SEGMENTS)
    return `片段已达 ${MAX_FILM_SEGMENTS} 段，无法加入成片；请先删减片段`
  if (!fitsInFilm(segments, duration, reserved))
    return `整片含片头片尾已有 ${seconds(roundToMs(filmDuration(segments) + reserved))} 秒，再加 ${seconds(duration)} 秒将超过 ${MAX_FILM_SECONDS} 秒，无法加入成片；请先删减成片轨上的片段`
  return undefined
}

export const insertSegment = (
  state: FilmState,
  clip: Clip,
  index: number,
  id: string,
): FilmState | undefined => {
  const start = roundToMs(clip.start)
  const end = roundToMs(clip.end)
  if (insertBlockedReason(state.segments, end - start, brandDuration(state)) !== undefined)
    return undefined
  const segment: FilmSegment = {
    id,
    sourceJobId: clip.sourceJobId,
    start,
    end,
  }
  const at = Math.max(0, Math.min(state.segments.length, index))
  return { ...clearMusicGain(state), segments: state.segments.toSpliced(at, 0, segment) }
}

export const moveSegment = (
  state: FilmState,
  id: string,
  before: number,
): FilmState | undefined => {
  const from = state.segments.findIndex((segment) => segment.id === id)
  const moving = state.segments[from]
  if (moving === undefined || before === from || before === from + 1) return undefined
  const rest = state.segments.toSpliced(from, 1)
  const at = before > from ? before - 1 : before
  return { ...clearMusicGain(state), segments: rest.toSpliced(at, 0, moving) }
}

export const trimBounds = (
  segments: readonly FilmSegment[],
  segment: FilmSegment,
  edge: 'start' | 'end',
  reserved = 0,
  sourceDuration?: number,
): { min: number; max: number } | undefined => {
  if (
    !Number.isFinite(segment.start) ||
    !Number.isFinite(segment.end) ||
    segment.start < 0 ||
    segment.end <= segment.start ||
    (sourceDuration !== undefined &&
      (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || segment.end > sourceDuration))
  )
    return undefined
  const slack = Math.max(0, MAX_FILM_SECONDS - reserved - filmDuration(segments))
  const bounds =
    edge === 'start'
      ? {
          min: roundToMs(Math.max(0, segment.start - slack)),
          max: Math.max(segment.start, roundToMs(segment.end - MIN_SEGMENT_SECONDS)),
        }
      : {
          min: Math.min(segment.end, roundToMs(segment.start + MIN_SEGMENT_SECONDS)),
          max: roundToMs(Math.min(sourceDuration ?? segment.end, segment.end + slack)),
        }
  return Number.isFinite(bounds.min) && Number.isFinite(bounds.max) && bounds.min <= bounds.max
    ? bounds
    : undefined
}

export const trimSegment = (
  state: FilmState,
  id: string,
  edge: 'start' | 'end',
  value: number,
  sourceDuration?: number,
): FilmState => {
  const at = state.segments.findIndex((segment) => segment.id === id)
  const segment = state.segments[at]
  if (segment === undefined || !Number.isFinite(value)) return state
  const bounds = trimBounds(state.segments, segment, edge, brandDuration(state), sourceDuration)
  if (bounds === undefined) return state
  const bounded = roundToMs(Math.min(bounds.max, Math.max(bounds.min, value)))
  if (bounded === segment[edge]) return state
  return {
    ...clearMusicGain(state),
    segments: state.segments.with(at, { ...segment, [edge]: bounded }),
  }
}

const splitPoint = (segments: readonly FilmSegment[], clock: number) => {
  const placed = segmentAt(segments, clock)
  if (placed === undefined) return undefined
  const { segment } = placed
  const time = roundToMs(segment.start + (clock - placed.at))
  if (
    time - segment.start < MIN_SEGMENT_SECONDS - 1e-9 ||
    segment.end - time < MIN_SEGMENT_SECONDS - 1e-9
  )
    return undefined
  return { segment, time }
}

export const canSplitAt = (segments: readonly FilmSegment[], clock: number): boolean =>
  segments.length < MAX_FILM_SEGMENTS && splitPoint(segments, clock) !== undefined

export const splitAt = (
  state: FilmState,
  clock: number,
  rightId: string,
): FilmState | undefined => {
  if (state.segments.length >= MAX_FILM_SEGMENTS) return undefined
  const point = splitPoint(state.segments, clock)
  if (point === undefined) return undefined
  const { segment, time } = point
  const left: FilmSegment = {
    ...segment,
    end: time,
  }
  const right: FilmSegment = {
    ...segment,
    id: rightId,
    start: time,
  }
  const at = state.segments.indexOf(segment)
  return {
    ...clearMusicGain(state),
    segments: state.segments.toSpliced(at, 1, left, right),
  }
}

export const removeSegment = (state: FilmState, id: string): FilmState => {
  if (!state.segments.some((segment) => segment.id === id)) return state
  return {
    ...clearMusicGain(state),
    segments: state.segments.filter((segment) => segment.id !== id),
  }
}

export const setSentenceText = (state: FilmState, key: string, text: string): FilmState => ({
  ...state,
  texts: { ...state.texts, [key]: text },
})

export const setMusic = (state: FilmState, music: FilmMusic | null): FilmState => ({
  ...state,
  music,
})

export const moveMusic = (state: FilmState, start: number): FilmState | undefined => {
  if (!Number.isFinite(start) || start < 0) throw new RangeError('音乐起点必须是非负有限数值')
  if (state.music === null) return undefined
  const userStart = roundToMs(start)
  if (userStart === state.music.userStart) return undefined
  return { ...state, music: { ...state.music, userStart } }
}

export const setMusicVolume = (state: FilmState, volume: number): FilmState => {
  checkedVolume(volume)
  if (state.music === null || (state.music.volume ?? 1) === volume) return state
  return { ...state, music: { ...state.music, volume } }
}

export const resetMusicStart = (state: FilmState): FilmState =>
  state.music === null || state.music.userStart === null
    ? state
    : { ...state, music: { ...state.music, userStart: null } }

export type MaterialLane = { takeId: string; jobId: string }

export const putLane = (
  lanes: readonly MaterialLane[],
  lane: MaterialLane,
): readonly MaterialLane[] => {
  const at = lanes.findIndex((item) => item.takeId === lane.takeId)
  return at < 0 ? [...lanes, lane] : lanes.with(at, lane)
}

const STORAGE_VERSION = 2

export const zVolume = z.number().min(0).max(MAX_VOLUME).optional()

export const zFilmMusicGain = z
  .array(zMusicGainPoint)
  .min(1)
  .max(MAX_MUSIC_GAIN_POINTS)
  .refine((points) =>
    points.every((point, index) => index === 0 || point.atMs > (points[index - 1]?.atMs ?? 0)),
  )

const zStoredSegment = z
  .object({
    id: z.string().min(1),
    sourceJobId: z.string().min(1),
    volume: zVolume,
    start: z.number().nonnegative(),
    end: z.number().positive(),
    subtitles: z
      .array(
        z.object({
          id: z.string().min(1),
          start: z.number().nonnegative(),
          end: z.number().positive(),
          text: z.string(),
        }),
      )
      .optional(),
  })
  .refine((segment) => segment.end > segment.start)

export const zFilmBrand = z.object({
  templateId: z.string().min(1),
  name: z.string().nullable(),
  url: z.string().min(1),
  durationMs: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  hasAudio: z.boolean(),
})

export const zFilmFont = z.object({
  fontId: z.string().min(1),
  name: z.string(),
  url: z.string().min(1),
})

const zStoredFilm = z.object({
  version: z.union([z.literal(1), z.literal(STORAGE_VERSION)]),
  intro: zFilmBrand.nullish(),
  outro: zFilmBrand.nullish(),
  font: zFilmFont.nullish(),
  segments: z.array(zStoredSegment),
  texts: z.record(z.string(), z.string()),
  lanes: z.array(z.object({ jobId: z.string().min(1) })),
  music: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('upload'),
        jobId: z.string().min(1),
        name: z.string().nullable(),
        verifyAccess: z.boolean().optional(),
        url: z.string().min(1),
        userStart: z.number().nonnegative().nullable(),
        volume: zVolume,
        gain: zFilmMusicGain.optional(),
      }),
      z.object({
        kind: z.literal('generate'),
        jobId: z.string().min(1),
        userStart: z.number().nonnegative().nullable(),
        volume: zVolume,
        gain: zFilmMusicGain.optional(),
      }),
    ])
    .nullable()
    .optional(),
})

export type StoredFilm = { film: FilmState; lanes: readonly MaterialLane[] }

export const parseStoredFilm = (
  raw: string,
  takeOf: (jobId: string) => string | undefined,
): StoredFilm | undefined => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = zStoredFilm.safeParse(json)
  if (!parsed.success) return undefined
  const { segments, texts, lanes, music, intro, outro, font } = parsed.data
  return {
    film: {
      segments,
      texts,
      music: music ?? null,
      ...(intro === undefined ? {} : { intro }),
      ...(outro === undefined ? {} : { outro }),
      ...(font === undefined ? {} : { font }),
    },
    lanes: lanes.reduce<readonly MaterialLane[]>((result, lane) => {
      const takeId = takeOf(lane.jobId)
      return takeId === undefined ? result : putLane(result, { takeId, jobId: lane.jobId })
    }, []),
  }
}

export const serializeStoredFilm = ({ film, lanes }: StoredFilm): string =>
  JSON.stringify({
    version: STORAGE_VERSION,
    segments: film.segments,
    texts: film.texts,
    lanes,
    music: film.music,
    intro: film.intro,
    outro: film.outro,
    font: film.font,
  })

export const keepKnownSources = (
  stored: StoredFilm,
  known: ReadonlySet<string>,
): { stored: StoredFilm; dropped: number } => {
  const lost = stored.film.segments.filter((segment) => !known.has(segment.sourceJobId))
  const film = lost.reduce((state, segment) => removeSegment(state, segment.id), stored.film)
  return {
    stored: { film, lanes: stored.lanes.filter((lane) => known.has(lane.jobId)) },
    dropped: lost.length,
  }
}

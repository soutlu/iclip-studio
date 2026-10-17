import { z } from 'zod'
import { roundToMs } from '../editing/clip'
import {
  byCreation,
  byFinish,
  finishedAt,
  isWholeFilm,
  versionLabel,
} from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  putLane,
  zFilmBrand,
  zFilmFont,
  zFilmMusicGain,
  zVolume,
  type FilmMusic,
  type FilmSegment,
  type MaterialLane,
  type StoredFilm,
} from './film-draft'

export type DoneVersion = { job: GenerationJob; label: string; url: string }

export type WholeFilmVersions = {
  done: DoneVersion[]
  running: GenerationJob[]
  failed: GenerationJob[]
}

const newestFirst = (left: GenerationJob, right: GenerationJob): number => byCreation(right, left)

export const wholeFilmVersions = (jobs: readonly GenerationJob[]): WholeFilmVersions => {
  const films = jobs.filter(isWholeFilm)
  const done = films
    .filter((job) => job.status === 'completed' && Boolean(job.outputUrl?.trim()))
    .toSorted(byFinish)
    .map((job, index) => ({ job, label: versionLabel(index + 1), url: job.outputUrl ?? '' }))
  const latest = done.at(-1)
  const failed = films
    .filter(
      (job) =>
        !isRunningStatus(job.status) &&
        !done.some((item) => item.job.id === job.id) &&
        (latest === undefined || finishedAt(job) > finishedAt(latest.job)),
    )
    .toSorted(newestFirst)
  const running = films.filter((job) => isRunningStatus(job.status)).toSorted(newestFirst)
  return { done, running, failed }
}

export const firstSourceOf = (job: GenerationJob): string | undefined =>
  z
    .object({ segments: z.array(z.object({ sourceJobId: z.string().min(1) })).min(1) })
    .safeParse(job.request).data?.segments[0]?.sourceJobId

const zVersionRequest = z.object({
  segments: z
    .array(
      z
        .object({
          sourceJobId: z.string().min(1),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          volume: zVolume,
        })
        .refine((segment) => segment.endMs > segment.startMs),
    )
    .min(1),
  intro: zFilmBrand.omit({ name: true }).nullish(),
  outro: zFilmBrand.omit({ name: true }).nullish(),
  font: zFilmFont.nullish(),
  subtitles: z.array(
    z.object({ startMs: z.number().int(), endMs: z.number().int(), text: z.string() }),
  ),
  music: z
    .object({
      audioJobId: z.string().min(1),
      url: z.string().min(1),
      offsetMs: z.number().int().nonnegative(),
      volume: zVolume,
      gain: zFilmMusicGain.optional(),
    })
    .nullish(),
})

type RebuildContext = {
  takeOf: (jobId: string) => string | undefined
  templateName: (templateId: string) => string | undefined
  generatedMusic: ReadonlySet<string>
  newId: () => string
}

export const draftFromVersion = (
  job: GenerationJob,
  { takeOf, templateName, generatedMusic, newId }: RebuildContext,
): StoredFilm | undefined => {
  const parsed = zVersionRequest.safeParse(job.request)
  if (!parsed.success) return undefined
  const { segments: spans, subtitles, music, intro, outro, font } = parsed.data

  let clockMs = 0
  const segments: FilmSegment[] = spans.map((span) => {
    const start = span.startMs / 1000
    const end = span.endMs / 1000
    const fromMs = clockMs
    clockMs += span.endMs - span.startMs
    const captions = subtitles.flatMap((item) => {
      const from = Math.max(fromMs, item.startMs)
      const to = Math.min(clockMs, item.endMs)
      return to <= from
        ? []
        : [
            {
              id: newId(),
              start: start + (from - fromMs) / 1000,
              end: start + (to - fromMs) / 1000,
              text: item.text,
            },
          ]
    })
    return {
      id: newId(),
      sourceJobId: span.sourceJobId,
      start,
      end,
      volume: span.volume,
      subtitles: captions,
    }
  })
  const filmMusic: FilmMusic | null =
    music == null
      ? null
      : generatedMusic.has(music.audioJobId)
        ? {
            kind: 'generate',
            jobId: music.audioJobId,
            userStart: roundToMs(music.offsetMs / 1000),
            volume: music.volume,
            gain: music.gain,
          }
        : {
            kind: 'upload',
            jobId: music.audioJobId,
            name: null,
            verifyAccess: true,
            url: music.url,
            userStart: roundToMs(music.offsetMs / 1000),
            volume: music.volume,
            gain: music.gain,
          }

  let lanes: readonly MaterialLane[] = []
  for (const segment of segments) {
    const takeId = takeOf(segment.sourceJobId)
    if (takeId === undefined || lanes.some((lane) => lane.takeId === takeId)) continue
    lanes = putLane(lanes, { takeId, jobId: segment.sourceJobId })
  }

  return {
    film: {
      segments,
      texts: {},
      music: filmMusic,
      ...(intro == null
        ? {}
        : { intro: { ...intro, name: templateName(intro.templateId) ?? null } }),
      ...(outro == null
        ? {}
        : { outro: { ...outro, name: templateName(outro.templateId) ?? null } }),
      ...(font === undefined ? {} : { font }),
    },
    lanes,
  }
}

import { roundToMs } from '../editing/clip'
import { byCreation } from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import { layoutFilm, sentenceKey, type FilmState } from './film-draft'

export type SubtitleSource =
  | {
      kind: 'ready'
      jobId: string
      sentences: readonly { startMs: number; endMs: number; text: string }[]
    }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'missing' }

export const latestSubtitles = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs.filter((item) => item.kind === 'subtitle').toSorted(byCreation)) {
    if (job.sourceJobId != null) latest.set(job.sourceJobId, job)
  }
  return latest
}

export const subtitleSourceOf = (record: GenerationJob | undefined): SubtitleSource => {
  if (record === undefined) return { kind: 'missing' }
  if (isRunningStatus(record.status)) return { kind: 'running' }
  if (record.status === 'completed' && record.sentences != null)
    return { kind: 'ready', jobId: record.id, sentences: record.sentences }
  return { kind: 'failed' }
}

export type FilmSubtitle = {
  key: string
  kind: 'sentence' | 'snapshot'
  textKey: string
  segmentId: string
  at: number
  end: number
  text: string
}

export type FilmSubtitleStatus = {
  kind: 'running' | 'failed' | 'missing'
  segmentId: string
  sourceJobId: string
  at: number
  end: number
}

export const projectSubtitles = (
  film: FilmState,
  sourceOf: (sourceJobId: string) => SubtitleSource | undefined,
  snapshots = true,
): { subtitles: FilmSubtitle[]; statuses: FilmSubtitleStatus[] } => {
  const subtitles: FilmSubtitle[] = []
  const statuses: FilmSubtitleStatus[] = []
  for (const { segment, at, duration } of layoutFilm(film.segments)) {
    const toFilm = (time: number) => roundToMs(at + (time - segment.start))
    const source = sourceOf(segment.sourceJobId)
    if (snapshots && segment.subtitles !== undefined) {
      for (const caption of segment.subtitles) {
        const from = Math.max(caption.start, segment.start)
        const to = Math.min(caption.end, segment.end)
        if (to <= from) continue
        subtitles.push({
          key: `${segment.id}:${caption.id}`,
          kind: 'snapshot',
          textKey: caption.id,
          segmentId: segment.id,
          at: toFilm(from),
          end: toFilm(to),
          text: film.texts[caption.id] ?? caption.text,
        })
      }
    } else if (source !== undefined && source.kind !== 'ready') {
      statuses.push({
        kind: source.kind,
        segmentId: segment.id,
        sourceJobId: segment.sourceJobId,
        at,
        end: roundToMs(at + duration),
      })
    } else if (source !== undefined) {
      source.sentences.forEach((sentence, index) => {
        const from = Math.max(sentence.startMs / 1000, segment.start)
        const to = Math.min(sentence.endMs / 1000, segment.end)
        if (to <= from) return
        const textKey = sentenceKey(source.jobId, index)
        subtitles.push({
          key: `${segment.id}:${textKey}`,
          kind: 'sentence',
          textKey,
          segmentId: segment.id,
          at: toFilm(from),
          end: toFilm(to),
          text: film.texts[textKey] ?? sentence.text,
        })
      })
    }
  }
  subtitles.sort((left, right) => left.at - right.at || left.end - right.end)
  return { subtitles, statuses }
}

export type BurnedSubtitle = { at: number; end: number; text: string }

export const burnedSubtitles = (subtitles: readonly FilmSubtitle[]): BurnedSubtitle[] => {
  const ordered = subtitles
    .filter((item) => item.text.trim() !== '')
    .toSorted((left, right) => left.at - right.at || left.end - right.end)
  const burned: BurnedSubtitle[] = []
  for (const item of ordered) {
    const last = burned.at(-1)
    if (last !== undefined && item.at < last.end) {
      last.end = item.at
      if (last.end <= last.at) burned.pop()
    }
    burned.push({ at: item.at, end: item.end, text: item.text.trim() })
  }
  return burned
}

export const captionAt = (burned: readonly BurnedSubtitle[], clock: number): string | undefined =>
  burned.find((item) => clock >= item.at && clock < item.end)?.text

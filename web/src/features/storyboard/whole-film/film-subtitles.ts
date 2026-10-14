/** 整片的字幕：各段取它来源成片最新一条字幕记录的逐句结果，与段区间重叠的句子截到段内、换算到整片时间，
 * 跟着画面走；再叠上改过的字与手动加的字幕。纯函数，不持有状态。 */

import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  layoutFilm,
  MANUAL_SUBTITLE_SECONDS,
  roundToMs,
  sentenceKey,
  type FilmState,
} from './film-draft'

/** 一条成片此刻的字幕：识别好了（逐句，可以一句都没有）、在识别、识别失败，或根本没有字幕记录（旧视频）。 */
export type SubtitleSource =
  | {
      kind: 'ready'
      jobId: string
      sentences: readonly { startMs: number; endMs: number; text: string }[]
    }
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'missing' }

const byCreation = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)

/** 每条成片最新的那条字幕记录（按提交先后），按成片 id 给。 */
export const latestSubtitles = (
  jobs: readonly GenerationJob[],
): ReadonlyMap<string, GenerationJob> => {
  const latest = new Map<string, GenerationJob>()
  for (const job of jobs.filter((item) => item.kind === 'subtitle').toSorted(byCreation)) {
    if (job.sourceJobId != null) latest.set(job.sourceJobId, job)
  }
  return latest
}

/** 最新那条字幕记录说明了什么。完成了却没有逐句结果的当失败：结果读不出来，只能重来。 */
export const subtitleSourceOf = (record: GenerationJob | undefined): SubtitleSource => {
  if (record === undefined) return { kind: 'missing' }
  if (isRunningStatus(record.status)) return { kind: 'running' }
  if (record.status === 'completed' && record.sentences != null)
    return { kind: 'ready', jobId: record.id, sentences: record.sentences }
  return { kind: 'failed' }
}

/** 字幕轨上的一条字幕，整片时间。 */
export type FilmSubtitle = {
  /** 这一条在轨上的身份：识别出的是「段 id:句子键」，手动的是它自己的 id。 */
  key: string
  kind: 'sentence' | 'manual'
  /** 改字时改哪一份：识别出的是句子键（几段共用），手动的是它自己的 id。 */
  textKey: string
  segmentId: string
  at: number
  end: number
  text: string
}

/** 一段的来源没有可用的字幕：在识别、识别失败、没有记录。没有口播（逐句为空）不算，什么也不标。 */
export type FilmSubtitleStatus = {
  kind: 'running' | 'failed' | 'missing'
  segmentId: string
  sourceJobId: string
  at: number
  end: number
}

/** 把草稿与各来源的字幕排成字幕轨：按起点先后。手动字幕从它钉住的那一刻起 {@link MANUAL_SUBTITLE_SECONDS} 秒，
 * 截到所在段内；钉住的那一刻被裁掉了就不显示。`sourceOf` 给 `undefined` 是字幕记录还没读到：这段先什么也不标。 */
export const projectSubtitles = (
  film: FilmState,
  sourceOf: (sourceJobId: string) => SubtitleSource | undefined,
): { subtitles: FilmSubtitle[]; statuses: FilmSubtitleStatus[] } => {
  const subtitles: FilmSubtitle[] = []
  const statuses: FilmSubtitleStatus[] = []
  for (const { segment, at, duration } of layoutFilm(film.segments)) {
    const toFilm = (time: number) => roundToMs(at + (time - segment.start))
    const source = sourceOf(segment.sourceJobId)
    if (source !== undefined && source.kind !== 'ready') {
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
    for (const item of film.manual) {
      if (item.segmentId !== segment.id || item.at < segment.start || item.at >= segment.end)
        continue
      subtitles.push({
        key: item.id,
        kind: 'manual',
        textKey: item.id,
        segmentId: segment.id,
        at: toFilm(item.at),
        end: toFilm(Math.min(segment.end, item.at + MANUAL_SUBTITLE_SECONDS)),
        text: item.text,
      })
    }
  }
  subtitles.sort((left, right) => left.at - right.at || left.end - right.end)
  return { subtitles, statuses }
}

/** 整片时刻 `clock` 该显示哪一条字幕：手动加的盖过识别出的；空字不显示。 */
export const captionAt = (
  subtitles: readonly FilmSubtitle[],
  clock: number,
): string | undefined => {
  const showing = subtitles.filter(
    (item) => clock >= item.at && clock < item.end && item.text.trim() !== '',
  )
  return (showing.find((item) => item.kind === 'manual') ?? showing[0])?.text
}

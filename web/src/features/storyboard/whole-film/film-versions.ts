/** 整片的版本与从一版重建草稿。整片是没有来源的视频合成，一段对话读得到的整片自成一个版本组，按完成时刻编 V1、V2……
 * （CONTEXT「镜头组」）。纯函数，不持有状态。 */

import { z } from 'zod'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  putLane,
  roundToMs,
  type FilmMusic,
  type FilmSegment,
  type MaterialLane,
  type StoredFilm,
} from './film-draft'
import { zFilmBrand, zFilmFont, zFilmMusicGain } from './film-draft'

/** 整片：没有来源的视频合成。 */
export const isWholeFilm = (job: GenerationJob): boolean =>
  job.kind === 'video' && job.operation === 'compose' && job.sourceJobId == null

/** 完成的一版：V1、V2……与它的产物地址。 */
export type DoneVersion = { job: GenerationJob; label: string; url: string }

export type WholeFilmVersions = {
  /** 完成的，按完成时刻从旧到新，第 N 条是 VN。 */
  done: DoneVersion[]
  /** 在合成的，新提交的在前。 */
  running: GenerationJob[]
  /** 失败的，新的在前；只留比最新完成的那一版晚结束的：之后又合成成功了，之前失败的那几次不再显示。 */
  failed: GenerationJob[]
}

const finishedAt = (job: GenerationJob): number => Date.parse(job.finishedAt ?? job.createdAt)

const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  finishedAt(left) - finishedAt(right) || left.id.localeCompare(right.id)

const newestFirst = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)

/** 从本对话的视频记录里挑出整片，分成完成、在合成、失败三类。完成了却没有产物地址的算失败。 */
export const wholeFilmVersions = (jobs: readonly GenerationJob[]): WholeFilmVersions => {
  const films = jobs.filter(isWholeFilm)
  const done = films
    .filter((job) => job.status === 'completed' && Boolean(job.outputUrl?.trim()))
    .toSorted(byFinish)
    .map((job, index) => ({ job, label: `V${index + 1}`, url: job.outputUrl ?? '' }))
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

/** 一条整片第一段出自哪条成片：还没有产物的（合成中、失败）拿它的画面当小图；请求读不出来时没有。 */
export const firstSourceOf = (job: GenerationJob): string | undefined =>
  z
    .object({ segments: z.array(z.object({ sourceJobId: z.string().min(1) })).min(1) })
    .safeParse(job.request).data?.segments[0]?.sourceJobId

// ---------- 从一版重建草稿 ----------

/** 一版整片的请求里重建要用的部分：段、烧进画面的字幕与音乐（音乐的地址是服务端按出处填的；段的地址与声音参数不用）。 */
const zVersionRequest = z.object({
  segments: z
    .array(
      z
        .object({
          sourceJobId: z.string().min(1),
          startMs: z.number().int().nonnegative(),
          endMs: z.number().int().positive(),
          volume: z.number().min(0).max(2).optional(),
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
      volume: z.number().min(0).max(2).optional(),
      gain: zFilmMusicGain.optional(),
    })
    .nullish(),
})

/** 重建出的上传音乐叫什么：上传时的文件名不在记录里。 */
export const REBUILT_UPLOAD_NAME = '上传的音乐'

type RebuildContext = {
  /** 一条成片属于哪次独立生成；不在素材里时没有。 */
  takeOf: (jobId: string) => string | undefined
  /** 本对话生成的音乐（音频记录 id）；不在里面的音乐当作上传的。 */
  generatedMusic: ReadonlySet<string>
  /** 发一个新的段或手动字幕 id。 */
  newId: () => string
}

/** 按已合成请求恢复最终字幕快照：保留空字幕和精确区间，不再猜测来自哪次识别。
 * 字幕固定在来源视频时间上，裁剪、拆分与换序后仍跟随画面；新插入的段照常使用最新识别结果。 */
export const draftFromVersion = (
  job: GenerationJob,
  { takeOf, generatedMusic, newId }: RebuildContext,
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
            // 上传记录不挂对话、列不出来，地址只在请求里。
            kind: 'upload',
            jobId: music.audioJobId,
            name: REBUILT_UPLOAD_NAME,
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
      manual: [],
      music: filmMusic,
      ...(intro == null ? {} : { intro: { ...intro, name: '片头' } }),
      ...(outro == null ? {} : { outro: { ...outro, name: '片尾' } }),
      ...(font === undefined ? {} : { font }),
    },
    lanes,
  }
}

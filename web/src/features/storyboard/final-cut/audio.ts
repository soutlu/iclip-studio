import { z } from 'zod'
import type { MediaUpload } from '@/shared/api/media-upload'
import { formatDateTime } from '@/shared/lib/date-time'
import type { GenerationJob } from '../storyboard.api'
import type { AudioClip, FilmClip } from './composition/film'
import { isMusicRow, rowBusy, rowsOf, type RowTarget } from './placement'

/**
 * 音频面板里的一条：这段对话生成的音乐，或挂在这段对话上的音频上传。`title` 是列表里的名字，
 * 加进 final-cut 的音频片段也叫这个；上传的总是已就绪，只有生成的会失败、能重新生成。
 */
export type ConversationAudio = {
  id: string
  title: string
  status: GenerationJob['status']
  url: string | null
  durationMs: number | null
  errorMessage: string | null
  generated: boolean
  createdAt: string
}

const promptOf = (job: GenerationJob): string | undefined =>
  z.object({ prompt: z.string().min(1) }).safeParse(job.request).data?.prompt

/** 生成的音乐：名字取描述。 */
export const generatedAudio = (job: GenerationJob): ConversationAudio => ({
  id: job.id,
  title: promptOf(job) ?? '生成的音乐',
  status: job.status,
  url: job.outputUrl,
  durationMs: job.durationMs,
  errorMessage: job.errorMessage,
  generated: true,
  createdAt: job.createdAt,
})

/** 上传的音频：名字写上传时间。 */
export const uploadedAudio = (upload: MediaUpload): ConversationAudio => ({
  id: upload.id,
  title: `上传的音乐 · ${formatDateTime(upload.createdAt)}`,
  status: 'completed',
  url: upload.url,
  durationMs: upload.durationMs,
  errorMessage: null,
  generated: false,
  createdAt: upload.createdAt,
})

/** 生成的和上传的合成一张表，新的在前。 */
export const conversationAudio = (
  jobs: readonly GenerationJob[],
  uploads: readonly MediaUpload[],
): ConversationAudio[] =>
  [...jobs.map(generatedAudio), ...uploads.map(uploadedAudio)].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )

/** 名字里含有 `query`（不分大小写，去掉两头空白）的音频，按原来的先后。 */
export const filterAudio = (
  items: readonly ConversationAudio[],
  query: string,
): ConversationAudio[] => {
  const keyword = query.trim().toLowerCase()
  return items.filter((item) => item.title.toLowerCase().includes(keyword))
}

/** 时长写成「分:秒」，秒四舍五入。 */
export const durationLabel = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** final-cut 里用着地址 `src`（音频记录的产物地址）的音频片段里开始得最早的那个；没用到时是 undefined。 */
export const firstAudioClipOf = (clips: readonly FilmClip[], src: string): AudioClip | undefined =>
  clips
    .filter((clip): clip is AudioClip => clip.kind === 'audio' && clip.src === src)
    .reduce<AudioClip | undefined>(
      (earliest, clip) => (earliest === undefined || clip.start < earliest.start ? clip : earliest),
      undefined,
    )

/**
 * 点「加到播放头」时音频片段放在哪：从 `startMs` 起、长 `durationMs`。配乐不进「配音」行和「原声」行：
 * 放在第一条配乐行；它在这段时间已经有片段时，在它下面紧挨着新开一行；还没有配乐行时在声音区最下面
 * （配音行、原声行下面）新开一行。
 */
export const audioPlayheadSpot = (
  clips: readonly FilmClip[],
  startMs: number,
  durationMs: number,
): { row: RowTarget; start: number } => {
  const rows = rowsOf(clips)
  // insertAt 数的是时间线上从上往下的第几行，画面区的行也算在里面
  const at = rows.findIndex(isMusicRow)
  const top = rows[at]
  // 没有配乐行时声音区只剩配音行、原声行，最下面就是它们下面
  if (top === undefined) return { row: { zone: 'audio', insertAt: rows.length }, start: startMs }
  return {
    row: rowBusy(top, startMs, durationMs)
      ? { zone: 'audio', insertAt: at + 1 }
      : { zone: 'audio', track: top.track },
    start: startMs,
  }
}

import { z } from 'zod'
import { formatDateTime } from '@/shared/lib/date-time'
import type { GenerationJob } from '../storyboard.api'
import type { AudioBlock, FilmBlock } from './composition/film'
import { rowBusy, rowsOf, type RowTarget } from './placement'

const promptOf = (job: GenerationJob): string | undefined =>
  z.object({ prompt: z.string().min(1) }).safeParse(job.request).data?.prompt

/** 音频在列表里的名字，加进成片的音频块也叫这个：生成的取描述，上传的写上传时间。 */
export const audioTitleOf = (job: GenerationJob): string =>
  job.operation === 'upload'
    ? `上传的音乐 · ${formatDateTime(job.createdAt)}`
    : (promptOf(job) ?? '生成的音乐')

/** 名字里含有 `query`（不分大小写，去掉两头空白）的音频，按原来的先后。 */
export const filterAudio = (jobs: readonly GenerationJob[], query: string): GenerationJob[] => {
  const keyword = query.trim().toLowerCase()
  return jobs.filter((job) => audioTitleOf(job).toLowerCase().includes(keyword))
}

/** 时长写成「分:秒」，秒四舍五入。 */
export const durationLabel = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** 成片里用着记录 `jobId` 的音频块里开始得最早的那个；没用到时是 undefined。 */
export const firstAudioBlockOf = (
  blocks: readonly FilmBlock[],
  jobId: string,
): AudioBlock | undefined =>
  blocks
    .filter((block): block is AudioBlock => block.kind === 'audio' && block.jobId === jobId)
    .reduce<AudioBlock | undefined>(
      (earliest, block) =>
        earliest === undefined || block.start < earliest.start ? block : earliest,
      undefined,
    )

/**
 * 点「加到播放头」时音频块放在哪：从 `startMs` 起、长 `durationMs`。
 * 放在声音区第一行；第一行在这段时间已经有块时，在它下面紧挨着新开一行；还没有声音行时新开第一条。
 */
export const audioPlayheadSpot = (
  blocks: readonly FilmBlock[],
  startMs: number,
  durationMs: number,
): { row: RowTarget; start: number } => {
  const rows = rowsOf(blocks)
  // insertAt 数的是时间线上从上往下的第几行，画面区的行也算在里面
  const at = rows.findIndex((row) => row.zone === 'audio')
  const top = rows[at]
  if (top === undefined) return { row: { zone: 'audio', insertAt: rows.length }, start: startMs }
  return {
    row: rowBusy(top, startMs, durationMs)
      ? { zone: 'audio', insertAt: at + 1 }
      : { zone: 'audio', track: top.track },
    start: startMs,
  }
}

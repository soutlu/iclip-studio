import { z } from 'zod'
import type { MediaUpload } from '@/shared/api/media-upload'
import {
  AUDIO_KIND_FILTERS,
  type AudioFilterKey,
  type AudioTraitFilter,
  type ReferenceAudio,
} from '@/shared/api/reference-audios'
import { formatDateTime } from '@/shared/lib/date-time'
import type { GenerationJob } from '../storyboard.api'
import type { AudioClip, FilmClip } from './composition/film'
import { isMusicRow, rowBusy, rowsOf, type RowTarget } from './placement'

/**
 * 音频面板条目：本对话生成的音乐或上传的音频文件。`title` 同时用作列表标题与加入轨道后的音频片段名称；
 * 上传音频默认已就绪，仅生成任务可能失败并支持重新生成。
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

/** 「音频库」里的一条：参考音频库里的配乐或音效，总是已就绪、量过时长；`reference` 是库里那条（子类、波形、属性）。 */
export type LibraryAudio = ConversationAudio & {
  url: string
  durationMs: number
  reference: ReferenceAudio
}

/** 参考音频库里的一条配乐或音效：名字用它的标题。 */
export const libraryAudio = (audio: ReferenceAudio): LibraryAudio => ({
  id: audio.id,
  title: audio.title,
  status: 'completed',
  url: audio.url,
  durationMs: audio.durationMs,
  errorMessage: null,
  generated: false,
  createdAt: audio.createdAt,
  reference: audio,
})

/** 「音频库」里能看的子类：配乐或音效。 */
export type LibraryKind = 'bgm' | 'sfx'

/** 「音频库」当前看的子类和它的属性筛选（只放这个子类能筛的几项）。 */
export type LibraryScope = { kind: LibraryKind; traits: AudioTraitFilter }

/** 每个子类在页签上能筛的属性，按显示的先后：配乐是曲风、情绪。 */
export const LIBRARY_FILTERS: Readonly<Record<LibraryKind, readonly AudioFilterKey[]>> = {
  bgm: ['genre', 'mood'],
  sfx: AUDIO_KIND_FILTERS.sfx,
}

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

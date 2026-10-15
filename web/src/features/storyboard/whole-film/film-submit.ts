/** 合成整片：把草稿排成 `POST /generations/whole-films` 的时间线，以及「合成成片」此刻为什么不能点。纯函数，不持有状态。
 *
 * 字幕与音乐时间以正文第一段的开头为 0（不含片头）；字幕与音乐的时刻都按它算，毫秒取整。 */

import type { WholeFilmIn } from '@/shared/api/generated/types.gen'
import {
  MAX_FILM_SECONDS,
  MAX_FILM_SEGMENTS,
  MAX_FILM_SUBTITLES,
  MAX_MUSIC_GAIN_POINTS,
  type FilmState,
} from './film-draft'
import type { GainPoint } from './film-music'
import type { BurnedSubtitle } from './film-subtitles'

/** 一条字幕至多多少字（后端同样拦）。 */
export const MAX_SUBTITLE_CHARS = 200

const toMs = (seconds: number): number => Math.round(seconds * 1000)

/** 音乐怎么用：哪条音频记录、整首里对着整片 0 秒的那一刻（秒）、整片上的音量曲线（不含结尾淡出，淡出由后端做）。 */
export type MusicPlan = { audioJobId: string; start: number; curve: readonly GainPoint[] }

/** 草稿排成的提交体：段取各自来源的原片起止；字幕是烧进画面的那一份（已去掉空字、互不重叠）；有音乐才带 `music`。
 * 不带 userName：浏览器会话由服务端认人。 */
export const wholeFilmBody = ({
  conversationId,
  taskId,
  film,
  subtitles,
  music,
}: {
  conversationId: string
  /** 本对话此刻挂的需求单。 */
  taskId: string | null
  film: FilmState
  subtitles: readonly BurnedSubtitle[]
  music: MusicPlan | null
}): WholeFilmIn => ({
  conversationId,
  taskId,
  ...(film.intro == null ? {} : { intro: { templateId: film.intro.templateId } }),
  ...(film.outro == null ? {} : { outro: { templateId: film.outro.templateId } }),
  segments: film.segments.map((segment) => ({
    sourceJobId: segment.sourceJobId,
    startMs: toMs(segment.start),
    endMs: toMs(segment.end),
  })),
  subtitles: subtitles.flatMap((item) => {
    const startMs = toMs(item.at)
    const endMs = toMs(item.end)
    return endMs > startMs ? [{ startMs, endMs, text: item.text }] : []
  }),
  ...(music === null
    ? {}
    : {
        music: {
          audioJobId: music.audioJobId,
          offsetMs: toMs(music.start),
          gain: music.curve.map((point) => ({ ...point })),
        },
      }),
})

/** 音乐此刻能不能用来合成。 */
export type MusicReadiness =
  | { kind: 'none' }
  | { kind: 'uploading' }
  | { kind: 'generating' }
  | { kind: 'reading' }
  | { kind: 'failed' }
  | { kind: 'short'; shortBy: number }
  | { kind: 'ready'; plan: MusicPlan }

/** 合成要看的几件事。 */
export type ComposeReadiness = {
  submitting: boolean
  segmentCount: number
  totalSeconds: number
  submittedSubtitleCount?: number
  templateBlocked?: string | undefined
  /** 本对话挂的需求单读到了没有。 */
  task: 'ready' | 'loading' | 'failed'
  /** 各段来源的字幕记录读到了没有。 */
  subtitleRecords: 'ready' | 'loading' | 'failed'
  /** 成片轨上有几段的来源还在识别字幕。 */
  recognizing: number
  music: MusicReadiness
  /** 字幕轨上的字幕，按轨上的先后（「第 N 条」与轨上的编号一致）。 */
  subtitles: readonly { text: string }[]
}

/** 「合成成片」此刻不能点的原因，按先后只给第一条；能合成时没有。识别失败、没有识别记录的段照样能合成（那几段没有字幕，
 * 轨上已标出）；还在识别的段要等它，不然合成出来少了它的字幕。 */
export const composeBlockedReason = (state: ComposeReadiness): string | undefined => {
  if (state.submitting) return '正在提交合成，请稍候'
  if (state.segmentCount === 0) return '成片轨为空，无法合成；请先从素材轨挑段放入成片轨'
  if (state.segmentCount > MAX_FILM_SEGMENTS)
    return `片段超过 ${MAX_FILM_SEGMENTS} 段，无法合成；请删减片段`
  if (state.totalSeconds > MAX_FILM_SECONDS)
    return `整片含片头片尾超过 ${MAX_FILM_SECONDS} 秒，无法合成；请删减内容`
  if (state.templateBlocked !== undefined) return state.templateBlocked
  if ((state.submittedSubtitleCount ?? state.subtitles.length) > MAX_FILM_SUBTITLES)
    return `字幕超过 ${MAX_FILM_SUBTITLES} 条，无法合成；请删减字幕`
  if (state.music.kind === 'ready' && state.music.plan.curve.length > MAX_MUSIC_GAIN_POINTS)
    return `音乐音量变化超过 ${MAX_MUSIC_GAIN_POINTS} 个点，无法合成；请减少口播片段或移除音乐`
  if (state.task === 'loading') return '任务信息读取中，暂时无法合成'
  if (state.task === 'failed') return '任务信息读取失败，无法合成；请点击「重试」'
  if (state.subtitleRecords === 'loading') return '字幕读取中，暂时无法合成'
  if (state.subtitleRecords === 'failed') return '字幕读取失败，无法合成；请点击「重试」'
  if (state.recognizing > 0)
    return `有 ${state.recognizing} 段的字幕正在识别，暂时无法合成；识别完成后即可合成`
  const music = musicBlockedReason(state.music)
  if (music !== undefined) return music
  const long = state.subtitles.findIndex((item) => item.text.trim().length > MAX_SUBTITLE_CHARS)
  if (long >= 0) return `第 ${long + 1} 条字幕超过 ${MAX_SUBTITLE_CHARS} 字，无法合成；请删减文字`
  return undefined
}

const musicBlockedReason = (music: MusicReadiness): string | undefined => {
  switch (music.kind) {
    case 'uploading':
      return '音乐上传中，暂时无法合成'
    case 'generating':
      return '音乐生成中，暂时无法合成'
    case 'reading':
      return '音乐读取中，暂时无法合成'
    case 'failed':
      return '音乐不可用，无法合成；请重试、换一首或删除音乐'
    case 'short':
      return `音乐比成片短 ${music.shortBy.toFixed(1)} 秒，无法合成；请重新生成或换一首`
    case 'none':
    case 'ready':
      return undefined
  }
}

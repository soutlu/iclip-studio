import type { WholeFilmIn } from '@/shared/api/generated/types.gen'
import type { FilmState } from './film-draft'
import {
  MAX_FILM_SECONDS,
  MAX_FILM_SEGMENTS,
  MAX_FILM_SUBTITLES,
  MAX_MUSIC_GAIN_POINTS,
  MAX_SUBTITLE_CHARS,
} from './film-limits'
import {
  composableMusic,
  musicBlockedReason,
  type MusicPlan,
  type MusicStatus,
} from './film-music-status'
import type { BurnedSubtitle } from './film-subtitles'

const toMs = (seconds: number): number => Math.round(seconds * 1000)

export const wholeFilmBody = ({
  conversationId,
  taskId,
  film,
  subtitles,
  music,
}: {
  conversationId: string
  taskId: string | null
  film: FilmState
  subtitles: readonly BurnedSubtitle[]
  music: MusicPlan | null
}): WholeFilmIn => ({
  conversationId,
  taskId,
  ...(film.font == null ? {} : { fontId: film.font.fontId }),
  ...(film.intro == null ? {} : { intro: { templateId: film.intro.templateId } }),
  ...(film.outro == null ? {} : { outro: { templateId: film.outro.templateId } }),
  segments: film.segments.map((segment) => ({
    sourceJobId: segment.sourceJobId,
    startMs: toMs(segment.start),
    endMs: toMs(segment.end),
    volume: segment.volume ?? 1,
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
          volume: music.volume ?? 1,
        },
      }),
})

export type ComposeReadiness = {
  submitting: boolean
  segmentCount: number
  totalSeconds: number
  submittedSubtitleCount?: number
  templateBlocked?: string | undefined
  fontBlocked?: string | undefined
  task: 'ready' | 'loading' | 'failed'
  subtitleRecords: 'ready' | 'loading' | 'failed'
  recognizing: number
  music: MusicStatus
  subtitles: readonly { text: string }[]
}

export const composeBlockedReason = (state: ComposeReadiness): string | undefined => {
  if (state.submitting) return '正在提交合成，请稍候'
  if (state.segmentCount === 0) return '成片轨为空，无法合成；请先从素材轨挑段放入成片轨'
  if (state.segmentCount > MAX_FILM_SEGMENTS)
    return `片段超过 ${MAX_FILM_SEGMENTS} 段，无法合成；请删减片段`
  if (state.totalSeconds > MAX_FILM_SECONDS)
    return `整片含片头片尾超过 ${MAX_FILM_SECONDS} 秒，无法合成；请删减内容`
  if (state.templateBlocked !== undefined) return state.templateBlocked
  if (state.fontBlocked !== undefined) return state.fontBlocked
  if ((state.submittedSubtitleCount ?? state.subtitles.length) > MAX_FILM_SUBTITLES)
    return `字幕超过 ${MAX_FILM_SUBTITLES} 条，无法合成；请删减字幕`
  if ((composableMusic(state.music)?.curve.length ?? 0) > MAX_MUSIC_GAIN_POINTS)
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

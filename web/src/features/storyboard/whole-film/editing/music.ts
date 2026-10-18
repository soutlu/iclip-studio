import type { EditContext, MusicBeat } from './context'
import { MAX_VOLUME, type WholeFilmDraft } from './draft'
import { done, refuse, type EditResult } from './result'
import { clamp, filmDuration, musicOf } from './timeline'

// 音乐铺满整片（含片头片尾），不循环：offset 收进 [0, 音乐时长 − 整片时长]。整片比音乐长时
// offset 只能是 0，差多少由 musicShortfallMs 报告。

const fitOffset = (offsetMs: number, musicMs: number, filmMs: number) =>
  clamp(offsetMs, 0, Math.max(0, musicMs - filmMs))

/** 用这首音乐（换掉原来的）；音量不给时沿用原来的，没有原来的就是 1 */
export const setMusic = (
  draft: WholeFilmDraft,
  args: { jobId: string; offsetMs?: number; volume?: number },
  context: EditContext,
): EditResult => {
  const media = context.music[args.jobId]
  if (!media) return refuse('unknown-music')
  return done({
    ...draft,
    music: {
      jobId: args.jobId,
      offset: fitOffset(args.offsetMs ?? 0, media.durationMs, filmDuration(draft)),
      volume: clamp(args.volume ?? draft.music?.volume ?? 1, 0, MAX_VOLUME),
    },
  })
}

/** 拖音乐换用歌里的另一段；整片的切点不动 */
export const setMusicOffset = (
  draft: WholeFilmDraft,
  args: { offsetMs: number },
  context: EditContext,
): EditResult => {
  if (!draft.music) return refuse('no-music')
  const media = musicOf(context, draft.music.jobId)
  const offset = fitOffset(args.offsetMs, media.durationMs, filmDuration(draft))
  return done(
    offset === draft.music.offset ? draft : { ...draft, music: { ...draft.music, offset } },
  )
}

export const setMusicVolume = (draft: WholeFilmDraft, args: { volume: number }): EditResult => {
  if (!draft.music) return refuse('no-music')
  const volume = clamp(args.volume, 0, MAX_VOLUME)
  return done(
    volume === draft.music.volume ? draft : { ...draft, music: { ...draft.music, volume } },
  )
}

export const removeMusic = (draft: WholeFilmDraft): EditResult =>
  done(draft.music ? { ...draft, music: null } : draft)

/** 音乐在片尾之前就放完的时长；铺得满或没有音乐时为 0 */
export const musicShortfallMs = (draft: WholeFilmDraft, context: EditContext): number => {
  if (!draft.music) return 0
  const media = musicOf(context, draft.music.jobId)
  return Math.max(0, draft.music.offset + filmDuration(draft) - media.durationMs)
}

/** 音乐的拍点换算到整片时间（音乐不动，整片 0 秒对齐歌里的 offset）；不截到片尾 */
export const filmBeats = (draft: WholeFilmDraft, context: EditContext): MusicBeat[] => {
  if (!draft.music) return []
  const { offset } = draft.music
  return musicOf(context, draft.music.jobId)
    .beats.map((beat) => ({ timeMs: beat.timeMs - offset, strong: beat.strong }))
    .filter((beat) => beat.timeMs >= 0)
}

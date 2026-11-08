import type { EditContext, MusicBeat } from './context'
import { MAX_VOLUME, type WholeFilmDraft } from './draft'
import { done, refuse, type EditResult } from './result'
import { clamp, filmDuration, musicOf } from './timeline'

const fitOffset = (offsetMs: number, musicMs: number, filmMs: number) =>
  clamp(offsetMs, 0, Math.max(0, musicMs - filmMs))

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

export const musicShortfallMs = (draft: WholeFilmDraft, context: EditContext): number => {
  if (!draft.music) return 0
  const media = musicOf(context, draft.music.jobId)
  return Math.max(0, draft.music.offset + filmDuration(draft) - media.durationMs)
}

export const filmBeats = (draft: WholeFilmDraft, context: EditContext): MusicBeat[] => {
  if (!draft.music) return []
  const { offset } = draft.music
  return musicOf(context, draft.music.jobId)
    .beats.map((beat) => ({ timeMs: beat.timeMs - offset, strength: beat.strength }))
    .filter((beat) => beat.timeMs >= 0)
}

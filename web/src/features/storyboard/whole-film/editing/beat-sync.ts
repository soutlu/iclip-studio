import type { EditContext, MusicBeat } from './context'
import { MAX_FILM_MS, MIN_CLIP_MS, type Layer0Clip, type WholeFilmDraft } from './draft'
import { trimClip } from './layer0'
import { filmBeats } from './music'
import type { Refusal } from './result'
import { componentMsOf, cutsOf, layer0End, musicOf, sourceOf } from './timeline'

const BEAT_EPS_MS = 10

export type BeatSyncResult =
  { ok: true; draft: WholeFilmDraft; moved: number; kept: number } | { ok: false; refusal: Refusal }

const cutRange = (draft: WholeFilmDraft, before: Layer0Clip, context: EditContext) => {
  const room = MAX_FILM_MS - layer0End(draft)
  const length =
    before.type === 'video'
      ? sourceOf(context, before.sourceJobId).durationMs
      : componentMsOf(context, before.component)
  const footage = length - before.playbackStart - before.duration
  return { min: MIN_CLIP_MS - before.duration, max: Math.min(footage, room) }
}

const cutsSpeech = (before: Layer0Clip, delta: number, context: EditContext): boolean => {
  if (before.type !== 'video') return false
  const subtitle = sourceOf(context, before.sourceJobId).subtitle
  if (!subtitle) return false
  const out = before.playbackStart + before.duration
  const next = out + delta
  const inside = (ms: number) => subtitle.sentences.some((s) => s.startMs < ms && s.endMs > ms)
  if (delta < 0) return subtitle.sentences.some((s) => s.startMs < out && s.endMs > next)
  return inside(out) || inside(next)
}

export const autoBeatSync = (draft: WholeFilmDraft, context: EditContext): BeatSyncResult => {
  if (!draft.music) return { ok: false, refusal: 'no-music' }
  const [first, second] = musicOf(context, draft.music.jobId).beats
  if (!first || !second) return { ok: false, refusal: 'no-beats' }
  const gap = second.timeMs - first.timeMs
  const beats = filmBeats(draft, context)
  const distance = (beat: MusicBeat, at: number) => Math.abs(beat.timeMs - at)

  let current = draft
  let moved = 0
  let kept = 0
  const count = cutsOf(draft).length
  for (let j = 0; j < count; j++) {
    const cut = cutsOf(current)[j]
    const before = current.layer0[j]
    if (!cut || !before) break
    const at = cut.timeMs
    if (beats.some((b) => Math.abs(b.timeMs - at) <= BEAT_EPS_MS)) continue

    const range = cutRange(current, before, context)
    const nearest = beats
      .filter((b) => distance(b, at) <= gap)
      .reduce<MusicBeat | null>(
        (best, b) => (best && distance(best, at) <= distance(b, at) ? best : b),
        null,
      )
    const target = nearest?.timeMs
    if (
      target === undefined ||
      target - at < range.min ||
      target - at > range.max ||
      cutsSpeech(before, target - at, context)
    ) {
      kept++
      continue
    }
    const result = trimClip(
      current,
      { clipId: before.id, edge: 'end', deltaMs: target - at },
      context,
    )
    const landed = result.ok ? cutsOf(result.draft)[j]?.timeMs : undefined
    if (result.ok && landed !== undefined && Math.abs(landed - target) <= BEAT_EPS_MS) {
      current = result.draft
      moved++
    } else {
      kept++
    }
  }
  return { ok: true, draft: current, moved, kept }
}

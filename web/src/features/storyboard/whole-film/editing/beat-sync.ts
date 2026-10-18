import type { EditContext, MusicBeat } from './context'
import { MAX_FILM_MS, MIN_CLIP_MS, type Layer0Clip, type WholeFilmDraft } from './draft'
import { trimClip } from './layer0'
import { filmBeats } from './music'
import type { Refusal } from './result'
import { cutsOf, layer0End, musicOf, sourceOf } from './timeline'

/** 离拍点这么近就算在拍上 */
const BEAT_EPS_MS = 10

export type BeatSyncResult =
  { ok: true; draft: WholeFilmDraft; moved: number; kept: number } | { ok: false; refusal: Refusal }

/** 切点能挪的范围：改切点前一段的时长，后面整体跟着移；视频段往后挪要出点之后还有画面 */
const cutRange = (draft: WholeFilmDraft, before: Layer0Clip, context: EditContext) => {
  const room = MAX_FILM_MS - layer0End(draft)
  const footage =
    before.type === 'video'
      ? sourceOf(context, before.sourceJobId).durationMs - before.playbackStart - before.duration
      : Number.POSITIVE_INFINITY
  return { min: MIN_CLIP_MS - before.duration, max: Math.min(footage, room) }
}

/**
 * 切点从 T 挪到 target 会不会切进口播，按切点前一段素材的字幕句子判断（后一段的入点不动）：
 * 往前挪不能截掉任何一句；往后挪时切点原本不能在句子中间，新出点也不能落在句子中间。
 * 素材还没有字幕记录时不知道口播在哪，不拦。
 */
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

/**
 * 自动卡点：音乐不动，把每个切点挪到一拍之内最近的拍点，挪的是切点前一段的出点，后面的段跟着移。
 * 会切断口播、或素材不够长的切点保持不动。
 * moved 只数这次真的挪到拍上的切点，原本就在拍上的切点不算 moved 也不算 kept。
 */
export const autoBeatSync = (draft: WholeFilmDraft, context: EditContext): BeatSyncResult => {
  if (!draft.music) return { ok: false, refusal: 'no-music' }
  const [first, second] = musicOf(context, draft.music.jobId).beats
  if (!first || !second) return { ok: false, refusal: 'no-beats' }
  // 拍间距取歌里前两拍，同设计稿
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

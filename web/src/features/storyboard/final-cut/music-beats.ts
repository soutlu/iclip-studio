import { roleOf } from './audio-role'
import type { AudioClip, FilmClip } from './composition/film'
import {
  beatSnapTargets,
  msToPx,
  snapMs,
  snapSpanStartMs,
  type Snapped,
  type SnapTargets,
} from './timeline-scale'

/**
 * 一首配乐算出来的节拍：`beats` 是每一拍、`downbeats` 是其中每小节的第一拍（强拍，引擎猜的，可能不准），
 * 都是这首音频里的秒数、从小到大；`seconds` 是这首音频的总长（秒），循环播放时按它算一圈。
 */
export type BeatGrid = {
  beats: readonly number[]
  downbeats: readonly number[]
  seconds: number
}

/** 时间线上的一拍：在 final-cut 的第几毫秒，是不是强拍。 */
export type TimelineBeat = { ms: number; strong: boolean }

/** 算节拍的片段：角色是配乐、没隐藏（静音）的音频片段。整行静音时行里的片段都隐藏着，也不算。 */
export const isBeatSource = (clip: FilmClip): clip is AudioClip =>
  clip.kind === 'audio' && !clip.hidden && roleOf(clip) === 'music'

/**
 * `clip` 用到的那段音频里的节拍放到时间线上：音频里第 b 秒在 `开始 + (b − 入点) ÷ 速度`，只要片段放到的那段
 * （入点起、片段长 × 速度那么长）。循环播放的片段放到音频结尾后从入点重来（和引擎的放法一样），节拍跟着一圈圈重复。
 */
export function clipBeats(
  clip: Pick<AudioClip, 'start' | 'duration' | 'mediaStart' | 'playbackRate' | 'loop'>,
  grid: BeatGrid,
): TimelineBeat[] {
  const inPoint = clip.mediaStart / 1000
  const used = (clip.duration / 1000) * clip.playbackRate
  const lap = grid.seconds - inPoint
  const laps = clip.loop && lap > 0 ? Math.ceil(used / lap) : 1
  const strong = new Set(grid.downbeats)
  const found: TimelineBeat[] = []
  for (let round = 0; round < laps; round += 1) {
    for (const beat of grid.beats) {
      if (beat < inPoint || (clip.loop && beat >= grid.seconds)) continue
      const played = beat - inPoint + round * lap
      if (played > used) break
      found.push({
        ms: Math.round(clip.start + (played / clip.playbackRate) * 1000),
        strong: strong.has(beat),
      })
    }
  }
  return found
}

/** 画出来、能吸上去的节拍在屏幕上至少隔这么多像素，再密就分不清、拖起来处处都吸。 */
const MIN_BEAT_GAP_PX = 12

const averageGapPx = (beats: readonly TimelineBeat[], pps: number) => {
  const first = beats[0]
  const last = beats.at(-1)
  if (first === undefined || last === undefined || beats.length < 2) return 0
  return msToPx(last.ms - first.ms, pps) / (beats.length - 1)
}

/**
 * 一个片段上画出来、能吸上去的节拍：每一拍平均隔得够开（`MIN_BEAT_GAP_PX`）时是每一拍；不够开时只要强拍，
 * 强拍也挤在一起时一个都不要。
 */
export function shownBeats(beats: readonly TimelineBeat[], pps: number): readonly TimelineBeat[] {
  if (averageGapPx(beats, pps) >= MIN_BEAT_GAP_PX) return beats
  const strong = beats.filter((beat) => beat.strong)
  return averageGapPx(strong, pps) >= MIN_BEAT_GAP_PX ? strong : []
}

/** 时间线上各个算节拍的片段画出来、能吸上去的节拍，按片段编号；`grids` 按音频地址，还没算出来的不在里面。 */
export function timelineBeats(
  clips: readonly FilmClip[],
  grids: ReadonlyMap<string, BeatGrid>,
  pps: number,
): Map<string, readonly TimelineBeat[]> {
  const found = new Map<string, readonly TimelineBeat[]>()
  for (const clip of clips) {
    if (!isBeatSource(clip)) continue
    const grid = grids.get(clip.src)
    if (grid === undefined) continue
    const shown = shownBeats(clipBeats(clip, grid), pps)
    if (shown.length > 0) found.set(clip.id, shown)
  }
  return found
}

/** 拖动、裁剪时能吸上去的节拍（毫秒）：`moving` 里的片段（正在动的，配乐自己也在里面）的节拍不算。 */
export const beatsToSnap = (
  beats: ReadonlyMap<string, readonly TimelineBeat[]>,
  moving: ReadonlySet<string>,
): number[] =>
  [...beats].flatMap(([id, shown]) => (moving.has(id) ? [] : shown.map((beat) => beat.ms)))

// 节拍的吸附范围是普通吸附的 0.65 倍（照原型）：按比例放大每秒的像素数，范围就按比例缩小
const BEAT_REACH = 0.65

/** 一个时间点（裁剪时的一端）吸附：先吸片段的两端和播放头，都没吸上才吸节拍。 */
export function snapEdgeToBeats(
  ms: number,
  targets: SnapTargets,
  beats: readonly number[],
  pps: number,
): Snapped {
  const snapped = snapMs(ms, targets, pps)
  if (snapped.guideMs !== null || beats.length === 0) return snapped
  return snapMs(ms, beatSnapTargets(beats), pps / BEAT_REACH)
}

/** 挪一个片段时吸附（开头或结尾哪一端近吸哪一端），返回片段的开头：先吸片段的两端和播放头，都没吸上才吸节拍。 */
export function snapSpanToBeats(
  startMs: number,
  durationMs: number,
  targets: SnapTargets,
  beats: readonly number[],
  pps: number,
): Snapped {
  const snapped = snapSpanStartMs(startMs, durationMs, targets, pps)
  if (snapped.guideMs !== null || beats.length === 0) return snapped
  return snapSpanStartMs(startMs, durationMs, beatSnapTargets(beats), pps / BEAT_REACH)
}

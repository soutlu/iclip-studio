/** 整片的背景音乐怎么铺：拍点、自动选起点（音乐对齐视频，切点不动）、拖动吸附、太短判断，以及口播处压低的
 * 音量曲线。纯函数，不持有状态；时间是秒，只有音量曲线用毫秒（原样发给后端的形状）。
 *
 * 音乐铺在成片轨的视频段上：现在没有片头片尾，就是整片 0 秒到总长；整首里从「起点」那一刻起对着整片 0 秒。 */

import { layoutFilm, roundToMs, type FilmSegment } from './film-draft'
import type { FilmSubtitle } from './film-subtitles'

/** 切点离最近的拍不超过这么多秒就算落在拍上：约 30 帧下的两帧，也在人察觉不到音画错位的范围里（约 ±45 ms 起才可感），
 * 再宽就会把明显错开的切点也算进去。 */
export const BEAT_TOLERANCE = 0.06

/** 4/4 拍：每 4 拍一小节，检测出的第一拍是小节的第一拍。 */
export const BEATS_PER_BAR = 4

/** 没有口播时音乐的音量，分贝：音乐被规整到与各段同一响度，满音量会盖过各段自带的环境声，压 6 dB 当衬底。 */
export const MUSIC_BED_DB = -6

/** 口播时音乐的音量，分贝：比衬底再低 12 dB，人声清楚、音乐仍听得见（口播压音乐通常压 10–15 dB）。 */
export const MUSIC_DUCKED_DB = -18

/** 压低前后各渐变多少秒。 */
export const DUCK_RAMP_SECONDS = 0.3

/** 结尾淡出多少秒；合成时由后端做，曲线里不带，预览另外叠上。 */
export const MUSIC_FADE_OUT_SECONDS = 2

const round3 = (value: number) => Math.round(value * 1000) / 1000
const dbToGain = (db: number) => round3(10 ** (db / 20))

/** 0–1 的增益：衬底约 0.501，口播时约 0.126。 */
export const MUSIC_BED_GAIN = dbToGain(MUSIC_BED_DB)
export const MUSIC_DUCKED_GAIN = dbToGain(MUSIC_DUCKED_DB)

/** 浮点比较的余量：时刻都是毫秒精度，差不到这么多就算相等。 */
const EPSILON = 1e-6

// ---------- 拍点 ----------

/** 一首音乐的拍子：`interval` 是每拍多少秒（按检测出的速度，不取整，免得长音乐尾部越差越多），`offset` 是第一拍在整首里的时刻，
 * `bpm` 是取整后的每分钟拍数，只给人看。 */
export type BeatGrid = { bpm: number; interval: number; offset: number }

/** 一首音乐：多长，拍子；没有检测到拍子时 `grid` 为 null。 */
export type Song = { duration: number; grid: BeatGrid | null }

/** 拍点检测给出的结果：取整的 bpm、第一拍的时刻，以及（库的类型里没写、运行时有的）未取整的速度。 */
export type GuessedBeat = { bpm: number; offset: number; tempo?: number }

/** 把检测结果整理成拍子；数不合理（不是正数、第一拍在负时刻）时当作没有检测到拍子。 */
export const beatGridOf = ({ bpm, offset, tempo }: GuessedBeat): BeatGrid | null => {
  const speed = tempo !== undefined && Number.isFinite(tempo) && tempo > 0 ? tempo : bpm
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(speed) || speed <= 0) return null
  if (!Number.isFinite(offset) || offset < 0) return null
  return { bpm: Math.round(bpm), interval: 60 / speed, offset }
}

/** 一拍：在整首里的时刻，是不是小节的第一拍。 */
export type Beat = { at: number; downbeat: boolean }

const beatCount = (song: Song): number => {
  const { grid } = song
  if (grid === null || grid.offset >= song.duration) return 0
  return Math.floor((song.duration - grid.offset) / grid.interval - EPSILON) + 1
}

const beatAt = (grid: BeatGrid, index: number): Beat => ({
  at: grid.offset + index * grid.interval,
  downbeat: index % BEATS_PER_BAR === 0,
})

/** 整首的拍点，从第一拍起、到整首结束为止，按时刻先后。 */
export const beatsOf = (song: Song): Beat[] => {
  const { grid } = song
  return grid === null
    ? []
    : Array.from({ length: beatCount(song) }, (_, index) => beatAt(grid, index))
}

/** 整首里离 `time` 最近的一拍；没有拍子时没有。 */
const nearestBeat = (song: Song, time: number): Beat | undefined => {
  const count = beatCount(song)
  if (song.grid === null || count === 0) return undefined
  const index = Math.min(
    count - 1,
    Math.max(0, Math.round((time - song.grid.offset) / song.grid.interval)),
  )
  return beatAt(song.grid, index)
}

// ---------- 对齐 ----------

/** 成片轨的内部切点（相邻两段的交界，不含开头与结尾），整片时间。 */
export const internalCuts = (segments: readonly FilmSegment[]): number[] =>
  layoutFilm(segments)
    .slice(1)
    .map((placed) => placed.at)

/** 音乐从整首的 `start` 起对着整片 0 秒时，落在拍上的切点（整片时间）与得分：小节第一拍 2 分，其他拍 1 分。 */
export const alignmentOf = (
  song: Song,
  start: number,
  cuts: readonly number[],
): { onBeat: number[]; score: number } => {
  const onBeat: number[] = []
  let score = 0
  for (const cut of cuts) {
    const beat = nearestBeat(song, start + cut)
    if (beat === undefined || Math.abs(beat.at - (start + cut)) > BEAT_TOLERANCE + EPSILON) continue
    onBeat.push(cut)
    score += beat.downbeat ? 2 : 1
  }
  return { onBeat, score }
}

/** 视频段从整首的 `start` 起放得下：起点不早于 0，起点加视频段总长不超过整首。 */
const fits = (song: Song, total: number, start: number): boolean =>
  start >= -EPSILON && start + total <= song.duration + EPSILON

/** 能当起点的时刻：整首的每一拍（成片第一帧总在拍上），且从它起放得下整段视频。没有拍子或一拍都放不下时为空。 */
export const candidateStarts = (song: Song, total: number): number[] =>
  beatsOf(song)
    .filter((beat) => fits(song, total, beat.at))
    .map((beat) => beat.at)

/** 自动选的起点：候选里得分最高的，同分取最早的；没有候选（没检测到拍子、太短、第一拍之后放不下）时从 0 秒起。 */
export const chooseStart = (song: Song, total: number, cuts: readonly number[]): number => {
  let best: { start: number; score: number } | undefined
  for (const start of candidateStarts(song, total)) {
    const { score } = alignmentOf(song, start, cuts)
    if (best === undefined || score > best.score) best = { start, score }
  }
  return best?.start ?? 0
}

/** 音乐此刻怎么铺。 */
export type MusicPlacement = {
  /** 整首里对着整片 0 秒的那一刻。 */
  start: number
  /** 是不是人拖出来的起点（否则是自动选的）。 */
  userPlaced: boolean
  /** 从起点算，整首还剩多长。 */
  available: number
  /** 视频段比剩下的音乐长出多少秒；够长时为 0。 */
  shortBy: number
  /** 落在拍上的切点，整片时间。 */
  onBeat: number[]
  /** 内部切点一共几个。 */
  cutCount: number
}

/** 按剪辑与人拖到的起点铺音乐：人拖过且那个起点还放得下就用它，放不下（剪辑变长了）就自动重选；人拖到的起点不丢，
 * 剪辑再变短、又放得下时还用它。 */
export const placeMusic = (
  song: Song,
  total: number,
  cuts: readonly number[],
  userStart: number | null,
): MusicPlacement => {
  const userPlaced = userStart !== null && fits(song, total, userStart)
  const start = userPlaced ? userStart : chooseStart(song, total, cuts)
  const available = Math.max(0, song.duration - start)
  const shortBy = roundToMs(Math.max(0, total - available))
  return {
    start,
    userPlaced,
    available,
    shortBy: shortBy < 0.001 ? 0 : shortBy,
    onBeat: alignmentOf(song, start, cuts).onBeat,
    cutCount: cuts.length,
  }
}

/** 拖动时吸附：落到离 `raw` 最近的候选起点；没有候选时夹在放得下的范围里（太短时只能从 0 秒起）。 */
export const snapStart = (song: Song, total: number, raw: number): number => {
  const candidates = candidateStarts(song, total)
  if (candidates.length > 0)
    return candidates.reduce((best, start) =>
      Math.abs(start - raw) < Math.abs(best - raw) ? start : best,
    )
  return roundToMs(Math.min(Math.max(0, song.duration - total), Math.max(0, raw)))
}

/** 键盘上挪起点：往后（`steps` 为正）或往前挪几个候选；没有候选时按 0.1 秒一步，夹在放得下的范围里。 */
export const stepStart = (song: Song, total: number, current: number, steps: number): number => {
  const candidates = candidateStarts(song, total)
  if (candidates.length === 0)
    return roundToMs(
      Math.min(Math.max(0, song.duration - total), Math.max(0, current + steps * 0.1)),
    )
  const at = candidates.indexOf(snapStart(song, total, current))
  return candidates[Math.min(candidates.length - 1, Math.max(0, at + steps))] ?? current
}

// ---------- 音量 ----------

/** 音量曲线上的一点：整片时刻（毫秒）与 0–1 的增益，按时刻递增，点与点之间线性插值。 */
export type GainPoint = { atMs: number; gain: number }

/** 一句口播在整片上的时段，秒。 */
export type SpeechSpan = { at: number; end: number }

/** 口播时段：字幕轨上识别出的句子（改过字的照算，手动加的不算，那不是有人在说话）。 */
export const speechSpansOf = (subtitles: readonly FilmSubtitle[]): SpeechSpan[] =>
  subtitles.flatMap((item) => (item.kind === 'sentence' ? [{ at: item.at, end: item.end }] : []))

/** 在 `points`（按时刻递增）上线性插值；落在两头之外取最近那一点，没有点时是衬底音量。 */
export const gainAt = (points: readonly GainPoint[], atMs: number): number => {
  const first = points[0]
  if (first === undefined) return MUSIC_BED_GAIN
  if (atMs <= first.atMs) return first.gain
  let left = first
  for (const right of points) {
    if (atMs <= right.atMs) {
      if (right.atMs === left.atMs) return right.gain
      return left.gain + ((right.gain - left.gain) * (atMs - left.atMs)) / (right.atMs - left.atMs)
    }
    left = right
  }
  return left.gain
}

/** 音乐在整片 0 到 `total` 秒上的音量曲线：口播时段降到 {@link MUSIC_DUCKED_GAIN}，前后各渐变 {@link DUCK_RAMP_SECONDS} 秒，
 * 其余是 {@link MUSIC_BED_GAIN}。两句之间的空隙不够一下一上两段渐变（≤ 0.6 秒）就连成一段，不在中间抬起来。
 * 结尾淡出不在这里（后端做，预览用 {@link withFadeOut} 叠上）。总长为 0 时没有曲线。 */
export const musicGainCurve = (speech: readonly SpeechSpan[], total: number): GainPoint[] => {
  const totalMs = Math.round(total * 1000)
  if (totalMs <= 0) return []
  const ramp = Math.round(DUCK_RAMP_SECONDS * 1000)
  const spans = speech
    .map((span) => ({
      from: Math.max(0, Math.round(span.at * 1000)),
      to: Math.min(totalMs, Math.round(span.end * 1000)),
    }))
    .filter((span) => span.to > span.from)
    .toSorted((left, right) => left.from - right.from)
  const merged: { from: number; to: number }[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && span.from - ramp <= last.to + ramp)
      last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }
  // 合并后相邻两段的渐变互不重叠，按时刻排开就是一条折线；两头之外是衬底。
  const raw: GainPoint[] = merged.flatMap(({ from, to }) => [
    { atMs: from - ramp, gain: MUSIC_BED_GAIN },
    { atMs: from, gain: MUSIC_DUCKED_GAIN },
    { atMs: to, gain: MUSIC_DUCKED_GAIN },
    { atMs: to + ramp, gain: MUSIC_BED_GAIN },
  ])
  const valueAt = (atMs: number) => (raw.length === 0 ? MUSIC_BED_GAIN : gainAt(raw, atMs))
  const times = [
    ...new Set([
      0,
      ...raw.map((point) => point.atMs).filter((at) => at > 0 && at < totalMs),
      totalMs,
    ]),
  ].toSorted((left, right) => left - right)
  return times.map((atMs) => ({ atMs, gain: round3(valueAt(atMs)) }))
}

/** 每隔多少毫秒在淡出段上取一个点：两条折线相乘不是折线，取密一点让预览贴近合成。 */
const FADE_SAMPLE_MS = 100

/** 预览用：在曲线上叠结尾 {@link MUSIC_FADE_OUT_SECONDS} 秒的线性淡出（到总长处为 0）。 */
export const withFadeOut = (curve: readonly GainPoint[], totalMs: number): GainPoint[] => {
  if (curve.length === 0 || totalMs <= 0) return []
  const fadeMs = MUSIC_FADE_OUT_SECONDS * 1000
  const fadeFrom = Math.max(0, totalMs - fadeMs)
  const samples = Array.from(
    { length: Math.floor((totalMs - fadeFrom) / FADE_SAMPLE_MS) },
    (_, index) => fadeFrom + (index + 1) * FADE_SAMPLE_MS,
  )
  const times = [...new Set([...curve.map((point) => point.atMs), fadeFrom, ...samples, totalMs])]
    .filter((at) => at >= 0 && at <= totalMs)
    .toSorted((left, right) => left - right)
  return times.map((atMs) => ({
    atMs,
    gain: round3(gainAt(curve, atMs) * Math.min(1, Math.max(0, (totalMs - atMs) / fadeMs))),
  }))
}

/** 从整片 `clockMs` 处起播时怎么排增益：先在 0 秒处定到那一刻的值，之后每个点按距起播多少秒线性过去。 */
export const automationFrom = (
  curve: readonly GainPoint[],
  clockMs: number,
): { after: number; gain: number }[] => [
  { after: 0, gain: round3(gainAt(curve, clockMs)) },
  ...curve
    .filter((point) => point.atMs > clockMs)
    .map((point) => ({ after: (point.atMs - clockMs) / 1000, gain: point.gain })),
]

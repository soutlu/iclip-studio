import {
  fxAutomationTarget,
  resolveAutomationRange,
  sampleAutomationLane,
  VOLUME_TARGET,
  type HfAutomation,
  type HfAutomationLane,
  type HfAutomationPoint,
} from '@hyperframes/core/audio-automation'
import { enabledAudioFxNodes } from '@hyperframes/core/audio-fx'
import { fadeGain } from '@hyperframes/core/audio-fade'
import {
  audioDbToGain,
  audioFaderPositionToGain,
  audioGainToDb,
  audioGainToFaderPosition,
  clampAudioGain,
  formatAudioGain,
  gainTimesLane,
  MAX_AUDIO_GAIN_DB,
} from '@hyperframes/core/audio-gain'
import { automationOf, chainOf } from './carve'
import type { MediaClip } from './composition/film'
import {
  MIN_POINT_GAP_SEC,
  POINT_MERGE_SEC,
} from './vendor/hyperframes-studio/player/components/automationLaneGeometry'

/**
 * 波形音量关键帧：片段 `data-automation` 里的音量曲线（目标 `volume`），写法照 core
 * （`@hyperframes/core/audio-automation`）：点的时间是片段时钟上的秒，值是乘在片段音量（`data-volume`）上的
 * 线性倍数（0 到 +12 dB 的倍数），点和点之间按倍数走直线；放的时候是「音量 × 曲线（乘积不超过 +12 dB）× 淡入
 * 淡出」。曲线没有「关着」的写法，开着就是有这条曲线，关掉就是去掉它。压低、平稳音量推的是效果链里自己的增益
 * 节点（`fx.<节点>.gain`），不是这条曲线，各改各的。
 *
 * 界面上的高低按 dB 均匀画（见 `envelopeHeight`），值却按倍数走直线，所以斜着的一段按 core 的取样画成几小段
 * （见 `envelopeLine`），和放出来的一致。
 */

export type EnvelopePoint = HfAutomationPoint

// 取样画斜线时每段分成几小段：时间线上一段最宽几百像素，这么多段看不出折角
const SEGMENT_SAMPLES = 24

const at3 = (t: number) => Number(t.toFixed(3))

/** 写进文件的倍数：照 core 写 `data-volume` 的位数，推子上每一格都能原样读回来。 */
const gainOf = (v: number) => Number(formatAudioGain(v))

const laneOf = (points: readonly EnvelopePoint[]): HfAutomationLane => ({
  target: VOLUME_TARGET,
  points: [...points],
})

/** 片段曲线 `automation`（属性原来的值）里音量曲线的点；没有这条曲线（或读不出）时是 null。 */
export const volumePointsOf = (automation: string | null): EnvelopePoint[] | null =>
  automationOf(automation ?? undefined).lanes.find((lane) => lane.target === VOLUME_TARGET)
    ?.points ?? null

/** 平的一条：片段开头和结尾（第 `durationSec` 秒）各一个点，都是原音量，不改变声音。 */
export const flatPoints = (durationSec: number): EnvelopePoint[] => [
  { t: 0, v: 1 },
  { t: at3(durationSec), v: 1 },
]

/** 音量曲线换成 `points`（null 是去掉这条曲线），别的曲线不动、先后不变；原来没有时加在最后。 */
export function withVolumePoints(
  automation: HfAutomation,
  points: readonly EnvelopePoint[] | null,
): HfAutomation {
  const exists = automation.lanes.some((lane) => lane.target === VOLUME_TARGET)
  const lanes = automation.lanes.flatMap((lane) =>
    lane.target !== VOLUME_TARGET ? [lane] : points === null ? [] : [laneOf(points)],
  )
  return {
    version: 1,
    lanes: exists || points === null ? lanes : [...lanes, laneOf(points)],
  }
}

/**
 * 打开或关掉波形音量关键帧：打开时已经有音量曲线就不动，没有就加平的一条（片段长 `durationSec` 秒）；关掉是
 * 去掉音量曲线。
 */
export const withEnvelope = (
  automation: HfAutomation,
  on: boolean,
  durationSec: number,
): HfAutomation => {
  if (!on) return withVolumePoints(automation, null)
  return automation.lanes.some((lane) => lane.target === VOLUME_TARGET)
    ? automation
    : withVolumePoints(automation, flatPoints(durationSec))
}

/** 重置：音量曲线换回平的一条。 */
export const withFlatEnvelope = (automation: HfAutomation, durationSec: number): HfAutomation =>
  withVolumePoints(automation, flatPoints(durationSec))

/** 曲线在片段第 `t` 秒的值（倍数），照 core 取样：第一个点以前、最后一个点以后保持两头的值。 */
export const valueAt = (points: readonly EnvelopePoint[], t: number): number =>
  sampleAutomationLane(laneOf(points), t)

/**
 * 在片段第 `t` 秒加一个点，值取曲线在那里原来的值（加了不改变声音），答复加好的点和新点是第几个。`t` 离已有的
 * 点不到 core 的合并距离时不加（是 null），这时抓的是那个点。
 */
export function insertPoint(
  points: readonly EnvelopePoint[],
  t: number,
): { points: EnvelopePoint[]; index: number } | null {
  const at = at3(Math.max(0, t))
  if (points.some((point) => Math.abs(point.t - at) <= POINT_MERGE_SEC)) return null
  const added = { t: at, v: gainOf(valueAt(points, at)) }
  const next = [...points, added].toSorted((left, right) => left.t - right.t)
  return { points: next, index: next.indexOf(added) }
}

/** 这个点是不是两头的（第一个、最后一个）：两头的点只能上下挪、不能删。 */
export const isEndPoint = (points: readonly EnvelopePoint[], index: number) =>
  index === 0 || index === points.length - 1

/**
 * 把第 `index` 个点挪到片段第 `t` 秒、值 `v`：值收进 0 到 core 的上限；两头的点时间不变；中间的点左右挪时不越过
 * 相邻的点（照 core 留出最小间隔，免得和相邻的点落在同一时刻被并掉）。
 */
export function movePoint(
  points: readonly EnvelopePoint[],
  index: number,
  t: number,
  v: number,
): EnvelopePoint[] {
  const point = points[index]
  if (point === undefined) return [...points]
  const before = points[index - 1]
  const after = points[index + 1]
  const time =
    before === undefined || after === undefined
      ? point.t
      : at3(Math.min(after.t - MIN_POINT_GAP_SEC, Math.max(before.t + MIN_POINT_GAP_SEC, t)))
  return points.map((each, at) => (at === index ? { ...each, t: time, v: gainOf(v) } : each))
}

/** 删掉第 `index` 个点；两头的点不删（原样答复）。 */
export const removePoint = (points: readonly EnvelopePoint[], index: number): EnvelopePoint[] =>
  isEndPoint(points, index) || points[index] === undefined
    ? [...points]
    : points.filter((_, at) => at !== index)

// 线画在多少 dB 之间：波形那一块只有十几像素高，照推子的刻度（下半截管 60 dB）压低 12 dB 只挪一两个像素，看不出来
const FLOOR_DB = -36
const SPAN_DB = MAX_AUDIO_GAIN_DB - FLOOR_DB

/**
 * 倍数在线上的高度（0 到 1，按 dB 均匀）：-36 dB 以下（含没有声音）在底，原音量在 3/4 高，+12 dB 在顶。
 */
export const envelopeHeight = (v: number) =>
  v <= 0 ? 0 : Math.min(1, Math.max(0, (audioGainToDb(v) - FLOOR_DB) / SPAN_DB))

/** `envelopeHeight` 反过来：高度换回倍数；拖到底是没有声音。 */
export const gainAtHeight = (height: number) =>
  height <= 0 ? 0 : audioDbToGain(FLOOR_DB + Math.min(1, height) * SPAN_DB)

/** 推子上的一格：方向键按一下挪 `steps` 格（和「属性」里的音量滑杆一样）。 */
export const nudgedGain = (v: number, steps: number) =>
  gainOf(audioFaderPositionToGain(audioGainToFaderPosition(v) + steps))

/**
 * 在 dB 刻度上把曲线画成折线要连的点（片段第 0 秒到第 `durationSec` 秒）：平的一段只要两头，斜的一段按 core 的
 * 取样多取几处，所以画出来的线就是放出来的音量。片段外面的点不画，两头按曲线在那里的值接上。
 */
export function envelopeLine(
  points: readonly EnvelopePoint[],
  durationSec: number,
): EnvelopePoint[] {
  const inside = points.map((point) => point.t).filter((t) => t > 0 && t < durationSec)
  const stops = [0, ...inside, durationSec]
  const line: EnvelopePoint[] = []
  stops.forEach((from, at) => {
    const v = valueAt(points, from)
    line.push({ t: from, v })
    const to = stops[at + 1]
    if (to === undefined || valueAt(points, to) === v) return
    for (let step = 1; step < SEGMENT_SAMPLES; step += 1) {
      const t = from + ((to - from) * step) / SEGMENT_SAMPLES
      line.push({ t, v: valueAt(points, t) })
    }
  })
  return line
}

/**
 * 片段 `clip`（时长按 `durationSec` 秒算）第 `t` 秒放出来的电平倍数，画波形高低用：照引擎放的时候的算法，
 * 片段音量 × 音量曲线（乘积不超过 +12 dB）× 淡入淡出，再乘上压低、平稳音量生成的增益节点在那一刻的值（它们的
 * 曲线是 dB，用同一个取样函数取）。`points` 给了时用它当音量曲线（拖动中的样子），null 是没有音量曲线。
 * 均衡、预设等别的效果不算。
 */
export function clipLevel(
  clip: MediaClip,
  durationSec: number,
  points: readonly EnvelopePoint[] | null,
): (t: number) => number {
  const automation = automationOf(clip.automation ?? undefined)
  const chain = chainOf(clip.fxChain ?? undefined)
  const fades = { fadeIn: clip.fadeIn / 1000, fadeOut: clip.fadeOut / 1000 }
  const stages = enabledAudioFxNodes(chain).flatMap((node) => {
    if (node.type !== 'gain' || (node.fromCarve !== true && node.fromLeveller !== true)) return []
    const target = node.id === undefined ? null : fxAutomationTarget(node.id, 'gain')
    const lane = automation.lanes.find((each) => each.target === target)
    const fixed = Number(node.params?.['gain'] ?? 0)
    const scale =
      target === null ? 'linear' : (resolveAutomationRange(target, chain)?.scale ?? 'linear')
    return [
      (t: number) =>
        audioDbToGain(lane === undefined ? fixed : sampleAutomationLane(lane, t, scale)),
    ]
  })
  return (t) => {
    const volume =
      points === null ? clampAudioGain(clip.volume) : gainTimesLane(clip.volume, valueAt(points, t))
    return stages.reduce(
      (level, stage) => level * stage(t),
      volume * fadeGain(t, durationSec, fades),
    )
  }
}

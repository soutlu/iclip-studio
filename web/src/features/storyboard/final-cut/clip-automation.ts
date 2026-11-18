import {
  parseAutomation,
  parseAutomationTarget,
  resolveAutomationRange,
  sampleAutomationLane,
  serializeAutomation,
  type HfAutomationLane,
  type HfAutomationPoint,
} from '@hyperframes/core/audio-automation'
import type { HfAudioFxChain } from '@hyperframes/core/audio-fx'
import { carveOf, carvePlan, chainOf } from './carve'
import { isMediaClip, type FilmClip, type MediaClip } from './composition/film'

// 切点落在弯曲的一段里时，这一段在两边各重采这么多份（和 core 的 `shiftRateLane` 一样）
const RESAMPLES = 16

const at3 = (t: number) => Number(t.toFixed(3))

const isShaped = (point: HfAutomationPoint) =>
  (point.curve !== undefined && point.curve !== 0) || point.viaX !== undefined

const plain = ({ t, v }: HfAutomationPoint): HfAutomationPoint => ({ t, v })

/**
 * 一条曲线在片段里第 `cut` 秒切开后的前后两段，时间都还是原来的：前一段到切点为止（切点上补一个点），后一段从
 * 切点上补的点开始。
 */
function laneParts(
  lane: HfAutomationLane,
  cut: number,
  scale: 'linear' | 'log',
): [HfAutomationPoint[], HfAutomationPoint[]] {
  const value = (t: number) => sampleAutomationLane(lane, t, scale)
  const next = lane.points.findIndex((point) => point.t > cut)
  const before = next < 0 ? lane.points : lane.points.slice(0, next)
  const after = next < 0 ? [] : lane.points.slice(next)
  const left = before.at(-1)
  const right = after[0]
  // 弯曲的一段被切开：形状属于左端点，两边都换成按原曲线采的直线段
  const crossing = left !== undefined && right !== undefined && isShaped(left)
  const samples = (from: number, to: number) =>
    Array.from({ length: RESAMPLES - 1 }, (_, k) => {
      const t = from + ((k + 1) * (to - from)) / RESAMPLES
      return { t, v: value(t) }
    })
  const first = crossing ? [...before.slice(0, -1), plain(left), ...samples(left.t, cut)] : before
  const edge = value(cut)
  return [
    first.at(-1)?.t === cut ? first : [...first, { t: cut, v: edge }],
    [{ t: cut, v: edge }, ...(crossing ? samples(cut, right.t) : []), ...after],
  ]
}

/** 曲线 `automation`（属性原来的值）读成一条条曲线；没写或读不出时是 null。 */
const lanesIn = (automation: string | undefined): HfAutomationLane[] | null => {
  if (automation === undefined) return null
  try {
    return parseAutomation(automation).lanes
  } catch {
    return null
  }
}

const scaleOf = (lane: HfAutomationLane, fx: HfAudioFxChain) =>
  resolveAutomationRange(lane.target, fx)?.scale ?? 'linear'

/**
 * 片段在它自己的第 `cut` 秒切开时，`data-automation`（属性原来的值 `automation`）在前后两半上要写的值：前半段
 * 只留切点之前的部分（切点上补一个点），后半段去掉切点之前的部分、时间平移到从 0 开始（0 秒补一个切点上的值）。
 * 曲线的时间是片段时钟上的秒，值按 `chain`（`data-fx-chain`）里参数的刻度取。没写或读不出时是 null（不动）。
 * 切开时引擎和工作台都不改曲线，这是我们补的。
 */
export function splitAutomation(
  automation: string | undefined,
  chain: string | undefined,
  cut: number,
): { first: string; second: string } | null {
  const lanes = lanesIn(automation)
  if (lanes === null) return null
  const fx = chainOf(chain)
  const parts = lanes.map((lane) => ({ lane, parts: laneParts(lane, cut, scaleOf(lane, fx)) }))
  const firsts = parts.map(({ lane, parts: [first] }) => ({
    ...lane,
    points: first.map((point) => ({ ...point, t: at3(point.t) })),
  }))
  const seconds = parts.map(({ lane, parts: [, second] }) => ({
    ...lane,
    points: second.map((point, index) =>
      index === 0 ? { ...point, t: 0 } : { ...point, t: at3(point.t - cut) },
    ),
  }))
  return {
    first: serializeAutomation({ version: 1, lanes: firsts }),
    second: serializeAutomation({ version: 1, lanes: seconds }),
  }
}

/**
 * 一条曲线跟着什么走：自动压低生成的（推带 `fromCarve` 的节点，`chain` 是片段的效果链）跟着时间线走，它压的是
 * 那一刻时间线上的人声；速度曲线（`rate`）不动；别的（音量关键帧、平稳音量、别的效果参数）跟着片段放的内容走。
 */
export function laneFollows(target: string, chain: HfAudioFxChain): 'content' | 'timeline' | null {
  const parsed = parseAutomationTarget(target)
  if (parsed?.kind === 'rate') return null
  const carved =
    parsed?.kind === 'fx' &&
    chain.nodes.some((node) => node.fromCarve === true && node.id === parsed.nodeId)
  return carved ? 'timeline' : 'content'
}

/** 片段放在哪、放素材的哪里：开始（时间线上的秒）、入点（素材里的秒）、速度。 */
export type ClipPlacement = { start: number; inPoint: number; rate: number }

/**
 * 片段从 `before` 改成 `after`（挪动、裁开头、改入点、改速度）以后，`data-automation`（属性原来的值 `automation`）
 * 要写的值；不用改、没写或读不出时是 null（不动）。曲线的时间是片段时钟上的秒（片段开始以后时间线上过了几秒，
 * 预览和导出都这么算）：
 * - 跟着内容走的（见 `laneFollows`）：曲线上第 t 秒放的是素材里的 `inPoint + t·rate`，改完以后还对着素材里这一刻；
 * - 跟着时间线走的：第 t 秒对着时间线上 `start + t` 那一刻的人声；人声在时间线上整体挪了 `voicesShift` 秒
 *   （见 `voicesShift`）时跟着挪同样的时间，改完以后还对着那一刻的人声。
 * 换算以后落到 0 秒以前的部分去掉，0 秒上补一个按原曲线算的点（弯曲的一段照 `splitAutomation` 重采）；落到片段
 * 结尾以后的留着，往前拉长时空出来的开头不补点（引擎按第一个点的值保持）。值按 `chain` 里参数的刻度取。
 * 改的时间、点都没变时是 null。
 */
export function followAutomation(
  automation: string | undefined,
  chain: string | undefined,
  before: ClipPlacement,
  after: ClipPlacement,
  voicesShift: number,
): string | null {
  const lanes = lanesIn(automation)
  if (lanes === null) return null
  const fx = chainOf(chain)
  // 换算是 t' = a·t + b
  const maps = {
    content: { a: before.rate / after.rate, b: (before.inPoint - after.inPoint) / after.rate },
    timeline: { a: 1, b: before.start - after.start + voicesShift },
  }
  let moved = false
  const next = lanes.map((lane) => {
    const follows = laneFollows(lane.target, fx)
    if (follows === null) return lane
    const { a, b } = maps[follows]
    if (a === 1 && b === 0) return lane
    moved = true
    // 新的 0 秒在原来的第几秒
    const zero = -b / a
    const points = zero > 0 ? laneParts(lane, zero, scaleOf(lane, fx))[1] : lane.points
    return {
      ...lane,
      points: points.map((point) => ({ ...point, t: Math.max(0, at3(a * point.t + b)) })),
    }
  })
  if (!moved) return null
  const text = serializeAutomation({ version: 1, lanes: next })
  return text === automation ? null : text
}

const placementOf = (clip: MediaClip): ClipPlacement => ({
  start: clip.start / 1000,
  inPoint: clip.mediaStart / 1000,
  rate: clip.playbackRate,
})

/**
 * 压低压的人声从 `before` 改成 `after`（各是一次 `carvePlan` 给出的人声）时在时间线上整体挪了几秒：同一批人声、
 * 每个的地址、时长、入点、速度都没变、开始都挪了同一个量时是这个量，别的情况（没动、各挪各的、多了少了、裁了）
 * 是 0。
 */
export function voicesShift(before: readonly MediaClip[], after: readonly MediaClip[]): number {
  const first = before[0]
  const moved = after[0]
  if (first === undefined || moved === undefined || before.length !== after.length) return 0
  const shift = moved.start - first.start
  const same = before.every((was, index) => {
    const now = after[index]
    return (
      now !== undefined &&
      now.id === was.id &&
      now.src === was.src &&
      now.duration === was.duration &&
      now.mediaStart === was.mediaStart &&
      now.playbackRate === was.playbackRate &&
      now.start - was.start === shift
    )
  })
  return same ? shift / 1000 : 0
}

/** 片段 `bed` 开着的压低（在 `clips` 里）压的人声；没开着时是空的。 */
const carvedVoices = (bed: MediaClip, clips: readonly FilmClip[]) => {
  const carve = carveOf(bed)
  return carve === null ? [] : carvePlan(bed, carve, clips).voices
}

/**
 * 一步编辑把片段从 `before` 改成 `after` 以后，曲线要跟着改的有声片段和要写的 `data-automation`（见
 * `followAutomation`；曲线、效果链按改完的读）。新加的片段（比如切开的后半段）不算。
 */
export function curvesFollowing(
  before: readonly FilmClip[],
  after: readonly FilmClip[],
): Map<string, string> {
  const earlier = new Map(before.filter(isMediaClip).map((clip) => [clip.id, clip]))
  const writes = new Map<string, string>()
  for (const clip of after) {
    const was = earlier.get(clip.id)
    if (!isMediaClip(clip) || clip.automation === null || was === undefined) continue
    const next = followAutomation(
      clip.automation,
      clip.fxChain ?? undefined,
      placementOf(was),
      placementOf(clip),
      voicesShift(carvedVoices(was, before), carvedVoices(clip, after)),
    )
    if (next !== null) writes.set(clip.id, next)
  }
  return writes
}

import {
  parseAutomation,
  resolveAutomationRange,
  sampleAutomationLane,
  serializeAutomation,
  type HfAutomationLane,
  type HfAutomationPoint,
} from '@hyperframes/core/audio-automation'
import { chainOf } from './carve'

// 切点落在弯曲的一段里时，这一段在两边各重采这么多份（和 core 的 `shiftRateLane` 一样）
const RESAMPLES = 16

const at3 = (t: number) => Number(t.toFixed(3))

const isShaped = (point: HfAutomationPoint) =>
  (point.curve !== undefined && point.curve !== 0) || point.viaX !== undefined

const plain = ({ t, v }: HfAutomationPoint): HfAutomationPoint => ({ t, v })

/** 一条曲线在片段里第 `cut` 秒切开后的前后两段；后一段的时间从 0 算起。 */
function laneHalves(
  lane: HfAutomationLane,
  cut: number,
  scale: 'linear' | 'log',
): [HfAutomationLane, HfAutomationLane] {
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
  const firstPoints = first.at(-1)?.t === cut ? first : [...first, { t: cut, v: edge }]
  const secondPoints = [
    { t: 0, v: edge },
    ...(crossing ? samples(cut, right.t) : []),
    ...after,
  ].map((point, index) => (index === 0 ? point : { ...point, t: at3(point.t - cut) }))
  return [
    { ...lane, points: firstPoints.map((point) => ({ ...point, t: at3(point.t) })) },
    { ...lane, points: secondPoints },
  ]
}

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
  if (automation === undefined) return null
  let lanes: HfAutomationLane[]
  try {
    lanes = parseAutomation(automation).lanes
  } catch {
    return null
  }
  const fx = chainOf(chain)
  const halves = lanes.map((lane) =>
    laneHalves(lane, cut, resolveAutomationRange(lane.target, fx)?.scale ?? 'linear'),
  )
  return {
    first: serializeAutomation({ version: 1, lanes: halves.map(([first]) => first) }),
    second: serializeAutomation({ version: 1, lanes: halves.map(([, second]) => second) }),
  }
}

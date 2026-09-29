/** 总览的呈现规则：各指标怎么取数、样本够不够、环比怎么比、图上每一格画什么与提示框写什么。

均线的值与覆盖区间一律读接口的 ma7 / ma30，前端不重算；这里只决定呈现。 */

import type { Metrics, MovingAverages, Overview, OverviewBucket } from './audit.api'
import {
  EMPTY,
  durationParts,
  durationTicks,
  durationTickText,
  fmtCount,
  fmtDayRange,
  fmtDuration,
  fmtLength,
  fmtRate,
  fmtTokens,
  lengthTicks,
  lengthTickText,
  niceTicks,
  percentTickText,
  periodLabel,
  rateTicks,
  tickLabel,
  tokenTickText,
} from './overview-format'

type MovingAverage = NonNullable<MovingAverages['deliveries']>

// ——— 样本 ———

/**
 * 比率与平均数的样本口径：某一格不到 cellMin 不画当天的点，悬停照实给数并带样本数；
 * 本期或上一期不到 periodMin 就不显示环比。
 */
export const SAMPLES = {
  shots: { cellMin: 3, periodMin: 30, unit: '镜', count: (m: Metrics) => m.shots },
  cycles: {
    cellMin: 2,
    periodMin: 10,
    unit: '段',
    count: (m: Metrics) => m.activeCycleSeconds?.count ?? 0,
  },
  deliveries: { cellMin: 2, periodMin: 10, unit: '件', count: (m: Metrics) => m.deliveries },
  videos: {
    cellMin: 3,
    periodMin: 30,
    unit: '条',
    count: (m: Metrics) => m.upstreamSeconds?.count ?? 0,
  },
} as const

type SampleKey = keyof typeof SAMPLES

/** 两期件数都不到这个数时，成片数不比：0 比 1 就是「降 100%」。 */
const THIN_DELIVERIES = 5

/** 「出得多」的门槛：单镜成功生成 3 次及以上，与异常「反复重试」同一个门槛。 */
export const RETRY_AT_LEAST = 3

// ——— 指标 ———

export type ChartKind = 'bar' | 'line' | 'stack' | 'stackbar'

type PartSpec = {
  name: string
  /** 图上与图例的颜色，CSS 变量。 */
  color: string
  raw: (m: Metrics) => number | null
  line: (ma: MovingAverages) => MovingAverage | null
}

type MetricSpec = {
  label: string
  /** 值后面跟的单位；token 不跟。 */
  unit: string
  kind: ChartKind
  sample?: SampleKey
  raw: (m: Metrics) => number | null
  line: (ma: MovingAverages) => MovingAverage | null
  format: (value: number) => string
  axis: (value: number, ticks: readonly number[]) => string
  ticks?: (high: number) => number[]
  integer?: boolean
  floor?: number
  baseline?: { value: number; label: string }
  parts?: readonly PartSpec[]
}

const perDelivery = (m: Metrics, tokens: number) =>
  m.deliveries === 0 ? null : tokens / m.deliveries

export const TOKEN_PARTS = [
  {
    name: '输入',
    color: 'var(--color-chart-1)',
    usage: (m: Metrics) => m.usage.inputTokens,
    perDelivery: (ma: MovingAverages) => ma.inputTokensPerDelivery,
  },
  {
    name: '输出',
    color: 'var(--color-chart-3)',
    usage: (m: Metrics) => m.usage.outputTokens,
    perDelivery: (ma: MovingAverages) => ma.outputTokensPerDelivery,
  },
  {
    name: '缓存写入',
    color: 'var(--color-chart-4)',
    usage: (m: Metrics) => m.usage.cacheWriteTokens,
    perDelivery: (ma: MovingAverages) => ma.cacheWriteTokensPerDelivery,
  },
  {
    // 缓存读取量最大、单价最低，用中性灰，别盖住输入和输出。
    name: '缓存读取',
    color: 'var(--color-chart-neutral)',
    usage: (m: Metrics) => m.usage.cacheReadTokens,
    perDelivery: (ma: MovingAverages) => ma.cacheReadTokensPerDelivery,
  },
] as const

export const METRICS = {
  deliveries: {
    label: '成片数',
    unit: '件',
    kind: 'bar',
    raw: (m) => m.deliveries,
    line: (ma) => ma.deliveries,
    format: fmtCount,
    axis: fmtCount,
    integer: true,
  },
  attempts: {
    label: '每镜头重试次数',
    unit: '次',
    kind: 'line',
    sample: 'shots',
    raw: (m) => m.attemptsPerShot,
    line: (ma) => ma.attemptsPerShot,
    format: (v) => v.toFixed(1),
    axis: (v) => v.toFixed(1),
    floor: 1,
    baseline: { value: 1, label: '1 次就成' },
  },
  cycle: {
    label: '单任务平均时长',
    unit: '',
    kind: 'line',
    sample: 'cycles',
    raw: (m) => m.activeCycleSeconds?.avg ?? null,
    line: (ma) => ma.activeCycleSeconds,
    format: fmtDuration,
    axis: durationTickText,
    ticks: durationTicks,
  },
  effective: {
    label: '素材有效率',
    unit: '',
    kind: 'line',
    sample: 'shots',
    raw: (m) => m.effectiveRate,
    line: (ma) => ma.effectiveRate,
    format: fmtRate,
    axis: percentTickText,
    ticks: rateTicks,
  },
  perDelivery: {
    label: '每件成片 · token',
    unit: 'token',
    kind: 'stack',
    sample: 'deliveries',
    raw: (m) => m.tokensPerDelivery,
    line: (ma) => ma.tokensPerDelivery,
    format: fmtTokens,
    axis: tokenTickText,
    parts: TOKEN_PARTS.map((part) => ({
      color: part.color,
      line: part.perDelivery,
      name: part.name,
      raw: (m: Metrics) => perDelivery(m, part.usage(m)),
    })),
  },
  oneTake: {
    label: '一次通过率',
    unit: '',
    kind: 'line',
    sample: 'shots',
    raw: (m) => m.oneTakeRate,
    line: (ma) => ma.oneTakeRate,
    format: fmtRate,
    axis: percentTickText,
    ticks: rateTicks,
  },
  upstream: {
    label: '视频生成平均时长',
    unit: '',
    kind: 'line',
    sample: 'videos',
    raw: (m) => m.upstreamSeconds?.avg ?? null,
    line: (ma) => ma.upstreamSeconds,
    format: fmtDuration,
    axis: durationTickText,
    ticks: durationTicks,
  },
  producers: {
    label: '使用人次',
    unit: '人',
    kind: 'bar',
    raw: (m) => m.producers,
    line: (ma) => ma.producers,
    format: fmtCount,
    axis: fmtCount,
    integer: true,
  },
  tokens: {
    label: 'token 消耗',
    unit: 'token',
    kind: 'stackbar',
    raw: (m) => m.usage.totalTokens,
    line: (ma) => ma.totalTokens,
    format: fmtTokens,
    axis: tokenTickText,
    parts: TOKEN_PARTS.map((part) => ({
      color: part.color,
      line: () => null,
      name: part.name,
      raw: part.usage,
    })),
  },
  length: {
    label: '总视频生成秒数',
    unit: '',
    kind: 'bar',
    raw: (m) => m.lengthSeconds,
    line: (ma) => ma.lengthSeconds,
    format: fmtLength,
    axis: lengthTickText,
    ticks: lengthTicks,
    integer: true,
  },
} satisfies Record<string, MetricSpec>

export type MetricKey = keyof typeof METRICS

const isBarLike = (kind: ChartKind) => kind === 'bar' || kind === 'stackbar'

/** 值加单位；件数的平均值保留一位小数，fmtCount 会取整所以不交给它。 */
const withUnit = (spec: MetricSpec, value: number | null): string => {
  if (value === null) return '无'
  const shown =
    spec.format === fmtCount && !Number.isInteger(value) ? value.toFixed(1) : spec.format(value)
  return spec.unit === '' || spec.unit === 'token' ? shown : `${shown} ${spec.unit}`
}

// ——— 环比 ———

export type Delta = {
  tone: 'good' | 'bad' | 'flat'
  /** 数值涨跌；持平与上期无数据没有方向。 */
  direction: 'up' | 'down' | null
  text: string
}

const FLAT: Delta = { direction: null, text: '持平', tone: 'flat' }

/** 本期对上一期的相对变化；变化不到 2% 算持平。text 给了就代替百分比。 */
export const relativeDelta = (
  current: number | null,
  previous: number | null,
  better: 'up' | 'down',
  text?: string,
): Delta => {
  if (current === null || previous === null || previous === 0) {
    return { direction: null, text: '上期无数据', tone: 'flat' }
  }
  const change = (current - previous) / previous
  if (Math.abs(change) < 0.02) return FLAT
  const direction = change > 0 ? 'up' : 'down'
  return {
    direction,
    text: text ?? `${Math.abs(change * 100).toFixed(0)}%`,
    tone: direction === better ? 'good' : 'bad',
  }
}

const sampled = (key: SampleKey, current: Metrics, previous: Metrics) =>
  SAMPLES[key].count(current) >= SAMPLES[key].periodMin &&
  SAMPLES[key].count(previous) >= SAMPLES[key].periodMin

// ——— 五张卡 ———

export const CARD_KEYS = ['deliveries', 'attempts', 'cycle', 'effective', 'perDelivery'] as const

export type CardKey = (typeof CARD_KEYS)[number]

export type CardHead = {
  value: string
  unit: string
  delta: Delta | null
  /** 紧跟在数字后的一句副字。 */
  aside: string | null
  /** 数字悬停时的分项与对照。 */
  detail: string
}

/** 卡头的数字、单位、环比与悬停分项；previousRange 是上一期的日期区间。 */
export function cardHead(key: CardKey, overview: Overview, previousRange: string): CardHead {
  const current = overview.current.metrics
  const previous = overview.previous.metrics
  switch (key) {
    case 'deliveries': {
      // 两期的活跃日数不一定一样（空档期、月份长短），环比按活跃日日均比，不按总数比。
      const days = overview.current.activeDays
      const previousDays = overview.previous.activeDays
      const byDay = days > 0 && previousDays > 0
      const perDay = current.deliveries / days
      const previousPerDay = previous.deliveries / previousDays
      const thin = Math.max(current.deliveries, previous.deliveries) < THIN_DELIVERIES
      const delta = thin
        ? null
        : byDay
          ? relativeDelta(perDay, previousPerDay, 'up')
          : relativeDelta(current.deliveries, previous.deliveries, 'up')
      const daily = byDay
        ? `环比按活跃日日均：${perDay.toFixed(1)} 件（${previousRange} ${previousPerDay.toFixed(1)} 件，${days} 对 ${previousDays} 个活跃日）；`
        : ''
      return {
        aside: null,
        delta,
        detail: `${daily}成片视频 ${fmtCount(current.completedVideos)} 条 · 需求单 ${current.deliveredTasks} · 无单对话 ${current.deliveredOrphanConversations}`,
        unit: '件',
        value: fmtCount(current.deliveries),
      }
    }
    case 'attempts':
      return {
        aside: current.shots > 0 ? `一次通过 ${fmtRate(current.oneTakeRate)}` : null,
        delta: sampled('shots', current, previous)
          ? relativeDelta(current.attemptsPerShot, previous.attemptsPerShot, 'down')
          : null,
        detail: `${fmtCount(current.shots)} 镜`,
        unit: '次',
        value: current.attemptsPerShot === null ? EMPTY : current.attemptsPerShot.toFixed(1),
      }
    case 'cycle': {
      const [value, unit] = durationParts(current.activeCycleSeconds?.avg ?? null)
      return {
        aside: null,
        delta: sampled('cycles', current, previous)
          ? relativeDelta(
              current.activeCycleSeconds?.avg ?? null,
              previous.activeCycleSeconds?.avg ?? null,
              'down',
            )
          : null,
        detail: `中位 ${fmtDuration(current.activeCycleSeconds?.median ?? null)}；不去掉空档时平均 ${fmtDuration(current.cycleSeconds?.avg ?? null)}`,
        unit,
        value,
      }
    }
    case 'effective': {
      // 比率的环比写百分点，免得和相对变化的百分比混。
      const rate = current.effectiveRate
      const previousRate = previous.effectiveRate
      const points =
        rate === null || previousRate === null ? null : Math.round((rate - previousRate) * 100)
      const delta =
        points === null || !sampled('shots', current, previous)
          ? null
          : points === 0
            ? FLAT
            : relativeDelta(rate, previousRate, 'up', `${Math.abs(points)} 个百分点`)
      return {
        aside: null,
        delta,
        detail: `${fmtCount(current.effectiveShots)} / ${fmtCount(current.shots)} 个镜头有人下载过`,
        unit: '%',
        value: rate === null ? EMPTY : String(Math.round(rate * 100)),
      }
    }
    case 'perDelivery': {
      const [value = EMPTY, magnitude = ''] = fmtTokens(current.tokensPerDelivery).split(' ')
      const each = (tokens: number) => fmtTokens(tokens / current.deliveries)
      return {
        aside: null,
        delta: sampled('deliveries', current, previous)
          ? relativeDelta(current.tokensPerDelivery, previous.tokensPerDelivery, 'down')
          : null,
        detail:
          current.deliveries === 0
            ? '这段时间没有成片'
            : `每件：输入 ${each(current.usage.inputTokens)} · 输出 ${each(current.usage.outputTokens)} · 缓存写入 ${each(current.usage.cacheWriteTokens)} · 缓存读取 ${each(current.usage.cacheReadTokens)}`,
        unit: magnitude === '' ? 'token' : `${magnitude} token`,
        value,
      }
    }
  }
}

// ——— 趋势图 ———

export type TipRow = {
  value: string
  name: string
  /** 图例形状跟图上的记号一致：柱与分项是方块，当天的点是圆点，均线是横线（30 日均线虚线）。 */
  mark?: 'box' | 'dot' | 'line' | 'dash'
  color?: string
  total?: boolean
}

export type ChartPoint = {
  key: string
  tick: string
  inactive: boolean
  /** 这一格画出来的值；样本不够的点不画，为空。 */
  value: number | null
  /** 7 日均线；按周没有。 */
  line: number | null
  /** 30 日均线；按周没有。 */
  slow: number | null
  /** 堆叠的分项，自下而上；不是堆叠图时为空。 */
  parts: (number | null)[] | null
  /** 提示框的行；这一格的日期写在当天那一行里。 */
  rows: TipRow[]
}

export type ChartModel = {
  kind: ChartKind
  bucket: OverviewBucket
  points: ChartPoint[]
  partColors: string[]
  yTicks: number[]
  axis: (value: number) => string
  baseline: { value: number; label: string } | null
  /** 有均线时当天的值画成点，超出纵轴的画成图顶的小三角。 */
  dayMarks: boolean
  /** 按小时的滚动值是台阶形，铺面积会显成一块块色砖，只画线。 */
  area: boolean
  hasLine: boolean
  hasSlow: boolean
}

const nonNull = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null)

const windowOf = (average: MovingAverage | null | undefined) =>
  average === null || average === undefined
    ? null
    : { since: new Date(average.since), until: new Date(average.until) }

const sumOf = (values: readonly (number | null)[] | null) =>
  values === null || values.every((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)

/** 一个指标在当前粒度下每一格的值、两条均线、堆叠分项与提示行，外加纵轴刻度。 */
export function chartModel(overview: Overview, key: MetricKey): ChartModel {
  const spec: MetricSpec = METRICS[key]
  const { bucket } = overview.window
  const window = { since: new Date(overview.window.since), until: new Date(overview.window.until) }
  const sample = spec.sample === undefined ? null : SAMPLES[spec.sample]
  const barLike = isBarLike(spec.kind)
  const averageWord = barLike ? ' 平均' : ''
  const windowLabel = (range: { since: Date; until: Date } | null) =>
    range === null ? '' : `${fmtDayRange(range.since, range.until)}${averageWord}`
  const hasLine = overview.series.some(
    (point) => point.ma7 !== null && spec.line(point.ma7) !== null,
  )
  const hasSlow = overview.series.some(
    (point) => point.ma30 !== null && spec.line(point.ma30) !== null,
  )
  // 堆叠面积在有均线时画 7 日均线那几天的分项，另把当天合计画成点。
  const areaIsLevel = spec.kind === 'stack' && hasLine

  const points = overview.series.map((point, index): ChartPoint => {
    const start = new Date(point.periodStart)
    const raw = spec.raw(point.metrics)
    const count = sample === null ? null : sample.count(point.metrics)
    const low = sample !== null && count !== null && count < sample.cellMin
    const fast = point.ma7 === null ? null : spec.line(point.ma7)
    const slow = point.ma30 === null ? null : spec.line(point.ma30)
    const parts =
      spec.parts?.map((part) =>
        areaIsLevel
          ? point.ma7 === null
            ? null
            : (part.line(point.ma7)?.value ?? null)
          : part.raw(point.metrics),
      ) ?? null
    const lowNote = low && raw !== null && sample !== null ? `（${count} ${sample.unit}）` : ''
    const rawLabel = `${periodLabel(start, bucket, window)}${point.inactive ? ' · 非活跃日' : ''}${lowNote}`
    const slowRow: TipRow[] =
      slow === null
        ? []
        : [
            {
              color: 'var(--color-chart-ghost)',
              mark: 'dash',
              name: windowLabel(windowOf(slow)),
              value: withUnit(spec, slow.value),
            },
          ]

    let rows: TipRow[]
    if (spec.parts !== undefined && parts !== null) {
      const partRows = spec.parts
        .map((part, partIndex): TipRow => ({
          color: part.color,
          mark: 'box',
          name: part.name,
          value: withUnit(spec, parts[partIndex] ?? null),
        }))
        .reverse()
      const totalRow: TipRow = {
        name: `合计 · ${areaIsLevel ? windowLabel(windowOf(fast)) : rawLabel}`,
        total: true,
        value: withUnit(spec, sumOf(parts)),
      }
      const dayRow: TipRow[] = areaIsLevel
        ? [
            {
              color: 'var(--color-on-surface-muted)',
              mark: 'dot',
              name: rawLabel,
              value: withUnit(spec, raw),
            },
          ]
        : []
      const fastRow: TipRow[] =
        spec.kind === 'stackbar' && fast !== null
          ? [
              {
                color: 'var(--color-primary)',
                mark: 'line',
                name: windowLabel(windowOf(fast)),
                value: withUnit(spec, fast.value),
              },
            ]
          : []
      rows = [...partRows, totalRow, ...dayRow, ...fastRow, ...slowRow]
    } else {
      // 当天的值在柱图上是柱、有均线的折线图上是点；按周没有均线，折线本身就是原始值。
      const rawMark: TipRow['mark'] = barLike ? 'box' : fast !== null ? 'dot' : 'line'
      rows = [
        {
          color: 'var(--color-chart-1)',
          mark: rawMark,
          name: rawLabel,
          value: withUnit(spec, raw),
        },
        ...(fast === null
          ? []
          : [
              {
                color: barLike ? 'var(--color-primary)' : 'var(--color-chart-1)',
                mark: 'line' as const,
                name: windowLabel(windowOf(fast)),
                value: withUnit(spec, fast.value),
              },
            ]),
        ...slowRow,
      ]
    }

    return {
      inactive: point.inactive,
      key: point.periodStart,
      line: fast?.value ?? null,
      parts,
      rows,
      slow: slow?.value ?? null,
      tick: tickLabel(start, bucket, index === 0),
      value: low ? null : raw,
    }
  })

  // 纵轴按原始值与 7 日均线定；30 日均线不超过它们两倍时才参与，更高的部分裁到图框外，别把近期压扁。
  const values = points.map((point) => point.value)
  const lines = points.map((point) => point.line)
  const totals = points.map((point) => sumOf(point.parts))
  const own = nonNull(
    spec.kind === 'line' && hasLine
      ? lines
      : spec.parts !== undefined
        ? totals
        : [...values, ...lines],
  )
  const ownMax = own.length === 0 ? 0 : Math.max(...own)
  const slows = nonNull(points.map((point) => point.slow))
  const slowFits = ownMax === 0 || slows.length === 0 || Math.max(...slows) <= ownMax * 2
  let known = [...own, ...(slowFits ? slows : [])]
  if (known.length === 0) known = nonNull(values)
  const high = known.length === 0 ? 1 : Math.max(...known)
  const low = spec.floor ?? 0
  const yTicks =
    spec.ticks?.(high * 1.05) ??
    niceTicks(
      low,
      Math.max(high * 1.08, low + (spec.integer === true ? 4 : 0.5)),
      4,
      spec.integer === true,
    )

  return {
    area: bucket !== 'hour',
    axis: (value) => spec.axis(value, yTicks),
    baseline: spec.baseline ?? null,
    bucket,
    dayMarks: (spec.kind === 'line' || spec.kind === 'stack') && hasLine,
    hasLine,
    hasSlow,
    kind: spec.kind,
    partColors: spec.parts?.map((part) => part.color) ?? [],
    points,
    yTicks,
  }
}

// ——— 出片次数（只数成功生成） ———

export const ATTEMPT_BINS = [
  { name: '1 次', color: 'var(--color-chart-ord-1)', ink: 'var(--color-on-chart-ord-1)' },
  { name: '2 次', color: 'var(--color-chart-ord-2)', ink: 'var(--color-on-chart-ord-2)' },
  { name: '3 次', color: 'var(--color-chart-ord-3)', ink: 'var(--color-on-chart-ord-3)' },
  { name: '4 次', color: 'var(--color-chart-ord-4)', ink: 'var(--color-on-chart-ord-4)' },
  { name: '5 次及以上', color: 'var(--color-chart-ord-5)', ink: 'var(--color-on-chart-ord-5)' },
] as const

export type AttemptSummary = {
  /** 每档的镜数，与 ATTEMPT_BINS 对齐。 */
  shots: number[]
  /** 每档占镜数与占出片次数的比例。 */
  shotShares: number[]
  attemptShares: number[]
  totalShots: number
  /** 成功生成 RETRY_AT_LEAST 次及以上的镜占镜数与占出片次数的比例；没有这样的镜为空。 */
  heavy: { shotShare: number; attemptShare: number } | null
}

/** 按 1 / 2 / 3 / 4 / 5 次及以上分档，算两条占比条与结论句要的数。 */
export function attemptSummary(distribution: Overview['attemptDistribution']): AttemptSummary {
  const shots = ATTEMPT_BINS.map(() => 0)
  const attempts = ATTEMPT_BINS.map(() => 0)
  let heavyShots = 0
  let heavyAttempts = 0
  for (const bucket of distribution) {
    const bin = Math.min(bucket.attempts, ATTEMPT_BINS.length) - 1
    if (bin < 0) continue
    shots[bin] = (shots[bin] ?? 0) + bucket.shots
    attempts[bin] = (attempts[bin] ?? 0) + bucket.shots * bucket.attempts
    if (bucket.attempts >= RETRY_AT_LEAST) {
      heavyShots += bucket.shots
      heavyAttempts += bucket.shots * bucket.attempts
    }
  }
  const totalShots = shots.reduce((sum, value) => sum + value, 0)
  const totalAttempts = attempts.reduce((sum, value) => sum + value, 0)
  return {
    attemptShares: attempts.map((value) => (totalAttempts === 0 ? 0 : value / totalAttempts)),
    heavy:
      heavyShots === 0
        ? null
        : { attemptShare: heavyAttempts / totalAttempts, shotShare: heavyShots / totalShots },
    shotShares: shots.map((value) => (totalShots === 0 ? 0 : value / totalShots)),
    shots,
    totalShots,
  }
}

/** 审计总览的 mock：按小时确定地造一段历史活动，再按请求的时间窗切期、算上一期与 7 / 30 日均线。

单测与 dev:mock 共用。分期按运行环境的本地时区算：前端传的 timezone 就是浏览器（单测里是 Node）的本地时区。
每 29 天里有连续 3 天没人发起运行（非活跃日）；片长只从本月 1 日起有数据，整段在那之前的时间窗是「暂无片长数据」。
粒度按跨度定：两天以内按小时，120 天以内按天，更长按周。

均线与补窗只求演示自洽，不是后端口径的参考实现；测试要断言数字，用 overviewFixture 喂自己的数据。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import {
  zOverviewOut,
  type zMetricsOut,
  type zMovingAverageOut,
  type zMovingAveragesOut,
  type zTrendPointOut,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser, mockGovernor } from './auth-user'

type Overview = z.output<typeof zOverviewOut>
type Metrics = z.output<typeof zMetricsOut>
type MovingAverage = z.output<typeof zMovingAverageOut>
type MovingAverages = z.output<typeof zMovingAveragesOut>
type TrendPoint = z.output<typeof zTrendPointOut>
type Bucket = Overview['window']['bucket']

const HOUR_MS = 3_600_000
/** 最早造到多少天前；更早的时间窗是空的。 */
const HISTORY_DAYS = 200
/** 均线窗里至少要有几个活跃日，不够就往前补。 */
const MIN_ACTIVE_DAYS = 3

const PEOPLE = [mockAuthUser.username, mockGovernor.username, 'lin.xia', 'zhou.ye', 'song.ke']
const PEOPLE_WEIGHT = [30, 12, 26, 18, 14]
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
const HOUR_WEIGHT = [0.5, 1.2, 1.4, 0.5, 0.6, 1.3, 1.4, 1.4, 1.2, 0.8, 0.5, 0.35, 0.25, 0.1]
const GOODS = ['童鞋', '滑板鞋', '跑鞋', '帆布鞋', '凉鞋', '徒步鞋', '老爹鞋', '雨靴']
const USES = ['主图视频', '种草短片', '上新视频', '卖点讲解', '开箱', '穿搭']
const CLIP_SECONDS = [5, 8, 10, 12, 15]

// ——— 本地日历 ———

const startOfDay = (at: number): number => {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const addDays = (at: number, days: number): number => {
  const d = new Date(at)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

const startOfMonth = (at: number): number => {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** 本地日期的序号，跨夏令时也是整数，用作每天的随机种子。 */
const dayNumber = (dayStart: number): number => {
  const d = new Date(dayStart)
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
}

const iso = (at: number) => new Date(at).toISOString()

// ——— 确定性随机 ———

const mulberry32 = (seed: number) => {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pickWeighted = <T>(
  random: () => number,
  items: readonly T[],
  weights: readonly number[],
): T => {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let rest = random() * total
  for (const [index, item] of items.entries()) {
    rest -= weights[index] ?? 0
    if (rest <= 0) return item
  }
  const last = items.at(-1)
  if (last === undefined) throw new Error('pickWeighted 需要至少一项')
  return last
}

const poisson = (random: () => number, lambda: number): number => {
  const limit = Math.exp(-lambda)
  let count = 0
  let product = 1
  do {
    count += 1
    product *= random()
  } while (product > limit)
  return count - 1
}

/** 由两个整数确定地拼一个 v4 形状的 UUID。 */
const uuidOf = (day: number, index: number): string => {
  const hex = (value: number, width: number) =>
    (value >>> 0).toString(16).padStart(width, '0').slice(-width)
  const mix = mulberry32(day * 131 + index)
  const part = () => Math.floor(mix() * 0xffffffff)
  return `${hex(part(), 8)}-${hex(part(), 4)}-4${hex(part(), 3)}-8${hex(part(), 3)}-${hex(part(), 8)}${hex(part(), 4)}`
}

// ——— 可加的一格 ———

type Sum = { total: number; count: number }

type Cell = {
  runs: number
  /** 发起运行的人，按 PEOPLE 下标记位。 */
  users: number
  /** 出过片的人，按 PEOPLE 下标记位。 */
  producers: number
  deliveredTasks: number
  orphans: number
  completedVideos: number
  shots: number
  attempts: number
  oneTakeShots: number
  deliveredShots: number
  effectiveShots: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  requests: number
  activeCycle: Sum
  wallCycle: Sum
  agentRun: Sum
  upstream: Sum
  video: Sum
  lengthVideos: number
  lengthSeconds: number
  discarded: number
  /** 下标是出片次数，值是镜数。 */
  histogram: number[]
}

type HeavyShot = {
  at: number
  conversationId: string
  title: string
  userName: string
  shot: number
  attempts: number
}

const emptyCell = (): Cell => ({
  runs: 0,
  users: 0,
  producers: 0,
  deliveredTasks: 0,
  orphans: 0,
  completedVideos: 0,
  shots: 0,
  attempts: 0,
  oneTakeShots: 0,
  deliveredShots: 0,
  effectiveShots: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  requests: 0,
  activeCycle: { total: 0, count: 0 },
  wallCycle: { total: 0, count: 0 },
  agentRun: { total: 0, count: 0 },
  upstream: { total: 0, count: 0 },
  video: { total: 0, count: 0 },
  lengthVideos: 0,
  lengthSeconds: 0,
  discarded: 0,
  histogram: [],
})

const addSum = (into: Sum, from: Sum) => {
  into.total += from.total
  into.count += from.count
}

const addCell = (into: Cell, from: Cell) => {
  into.runs += from.runs
  into.users |= from.users
  into.producers |= from.producers
  into.deliveredTasks += from.deliveredTasks
  into.orphans += from.orphans
  into.completedVideos += from.completedVideos
  into.shots += from.shots
  into.attempts += from.attempts
  into.oneTakeShots += from.oneTakeShots
  into.deliveredShots += from.deliveredShots
  into.effectiveShots += from.effectiveShots
  into.input += from.input
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  into.output += from.output
  into.requests += from.requests
  addSum(into.activeCycle, from.activeCycle)
  addSum(into.wallCycle, from.wallCycle)
  addSum(into.agentRun, from.agentRun)
  addSum(into.upstream, from.upstream)
  addSum(into.video, from.video)
  into.lengthVideos += from.lengthVideos
  into.lengthSeconds += from.lengthSeconds
  into.discarded += from.discarded
  from.histogram.forEach((shots, attempts) => {
    into.histogram[attempts] = (into.histogram[attempts] ?? 0) + (shots ?? 0)
  })
}

// ——— 按天造数据 ———

type Day = { hours: Map<number, Cell>; total: Cell; heavy: HeavyShot[] }

/** 一段对话的活动，全部记在它开始的那个小时里。 */
const simulateConversation = (
  random: () => number,
  cell: Cell,
  {
    day,
    index,
    hourStart,
    withLength,
  }: { day: number; index: number; hourStart: number; withLength: boolean },
  heavy: HeavyShot[],
) => {
  const person = pickWeighted(random, [0, 1, 2, 3, 4], PEOPLE_WEIGHT)
  const runs = 1 + poisson(random, 2)
  cell.runs += runs
  cell.users |= 1 << person
  for (let run = 0; run < runs; run += 1) {
    cell.agentRun.total += 45 + random() * 420
    cell.agentRun.count += 1
  }
  const title = `${GOODS[(day + index) % GOODS.length]}${USES[(day * 3 + index) % USES.length]}`
  const conversationId = uuidOf(day, index)
  const total = 950_000 * Math.exp(0.55 * (random() - 0.5) * 2)
  const cacheReadShare = 0.62 + random() * 0.2
  const cacheWriteShare = 0.04 + random() * 0.04
  const outputShare = 0.05 + random() * 0.06
  const tokens = {
    cacheRead: Math.round(total * cacheReadShare),
    cacheWrite: Math.round(total * cacheWriteShare),
    input: Math.round(total * Math.max(0.03, 1 - cacheReadShare - cacheWriteShare - outputShare)),
    output: Math.round(total * outputShare),
  }
  cell.input += tokens.input
  cell.cacheRead += tokens.cacheRead
  cell.cacheWrite += tokens.cacheWrite
  cell.output += tokens.output
  cell.requests += Math.max(1, Math.round(total / 38_000))

  // 约一成的对话只跑了 agent、没出片。
  if (random() < 0.12) return
  const shotCount = pickWeighted(random, [1, 2, 3, 4], [0.3, 0.35, 0.22, 0.13])
  let delivered = false
  for (let shot = 1; shot <= shotCount; shot += 1) {
    const attempts = pickWeighted(random, [1, 2, 3, 4, 5, 6], [0.52, 0.3, 0.1, 0.04, 0.025, 0.015])
    const seconds = pickWeighted(random, CLIP_SECONDS, [0.3, 0.3, 0.2, 0.1, 0.1])
    let succeeded = 0
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (random() < 0.08) continue
      succeeded += 1
      const upstream = 190 * Math.exp(0.45 * (random() - 0.5) * 2)
      cell.completedVideos += 1
      cell.upstream.total += upstream
      cell.upstream.count += 1
      cell.video.total += upstream + 8 + random() * 50
      cell.video.count += 1
      if (withLength) {
        cell.lengthVideos += 1
        cell.lengthSeconds += seconds
      }
    }
    // 一镜成功过多条时，除最后一条以外都算废片。
    if (withLength && succeeded > 1) cell.discarded += (succeeded - 1) * seconds
    cell.shots += 1
    cell.attempts += attempts
    cell.histogram[attempts] = (cell.histogram[attempts] ?? 0) + 1
    if (attempts === 1 && succeeded === 1) cell.oneTakeShots += 1
    if (succeeded > 0) {
      delivered = true
      cell.deliveredShots += 1
      if (random() < 0.62) cell.effectiveShots += 1
    }
    if (attempts >= 3) {
      heavy.push({
        at: hourStart,
        attempts,
        conversationId,
        shot,
        title,
        userName: PEOPLE[person] ?? '',
      })
    }
  }
  cell.producers |= 1 << person
  if (!delivered) return
  if (random() < 0.05) cell.deliveredTasks += 1
  else cell.orphans += 1
  const active = 1500 + random() * 3900
  cell.activeCycle.total += active
  cell.activeCycle.count += 1
  // 约一成隔天回来重出，墙钟时长拖出长尾。
  cell.wallCycle.total += active * (random() < 0.1 ? 20 + random() * 30 : 1 + random() * 2.5)
  cell.wallCycle.count += 1
}

const dayCache = new Map<string, Day>()

const dayOf = (dayStart: number, now: number): Day => {
  const lengthFrom = startOfMonth(now)
  const key = `${dayStart}:${lengthFrom}`
  const cached = dayCache.get(key)
  if (cached !== undefined) return cached
  const day: Day = { heavy: [], hours: new Map(), total: emptyCell() }
  const number = dayNumber(dayStart)
  const tooOld = dayStart < addDays(startOfDay(now), -HISTORY_DAYS)
  const inactive = number % 29 >= 9 && number % 29 <= 11
  if (!tooOld && !inactive && dayStart <= now) {
    const random = mulberry32(number * 7919)
    const weekday = new Date(dayStart).getDay()
    const rate = weekday === 0 || weekday === 6 ? 1.4 : 4
    const count = poisson(random, rate)
    for (let index = 0; index < count; index += 1) {
      const hour = pickWeighted(random, HOURS, HOUR_WEIGHT)
      const hourStart = new Date(dayStart).setHours(hour)
      const cell = day.hours.get(hour) ?? emptyCell()
      day.hours.set(hour, cell)
      simulateConversation(
        random,
        cell,
        { day: number, hourStart, index, withLength: dayStart >= lengthFrom },
        day.heavy,
      )
    }
    for (const cell of day.hours.values()) addCell(day.total, cell)
  }
  dayCache.set(key, day)
  return day
}

/** [from, to) 里的活动：整天用当天合计，被截断的那一天按小时取。 */
const collect = (from: number, to: number, now: number): Cell => {
  const into = emptyCell()
  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    const data = dayOf(day, now)
    if (day >= from && addDays(day, 1) <= to) {
      addCell(into, data.total)
      continue
    }
    for (const [hour, cell] of data.hours) {
      const at = new Date(day).setHours(hour)
      if (at >= from && at < to) addCell(into, cell)
    }
  }
  return into
}

const activeDaysIn = (from: number, to: number, now: number): number => {
  let count = 0
  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
    if (dayOf(day, now).total.users !== 0) count += 1
  }
  return count
}

// ——— 指标 ———

const bitCount = (mask: number) => mask.toString(2).replaceAll('0', '').length

const spreadOf = (sum: Sum, medianRatio: number, p90Ratio: number) => {
  if (sum.count === 0) return null
  const avg = sum.total / sum.count
  return { avg, count: sum.count, median: avg * medianRatio, p90: avg * p90Ratio }
}

const totalTokensOf = (cell: Cell) => cell.input + cell.cacheRead + cell.cacheWrite + cell.output
const deliveriesOf = (cell: Cell) => cell.deliveredTasks + cell.orphans
const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator

const metricsOf = (cell: Cell): Metrics => {
  const deliveries = deliveriesOf(cell)
  const readIn = cell.input + cell.cacheRead + cell.cacheWrite
  return {
    activeCycleSeconds: spreadOf(cell.activeCycle, 0.85, 1.8),
    activeUsers: bitCount(cell.users),
    agentRunSeconds: spreadOf(cell.agentRun, 0.9, 1.7),
    attempts: cell.attempts,
    attemptsPerShot: ratio(cell.attempts, cell.shots),
    completedVideos: cell.completedVideos,
    cycleSeconds: spreadOf(cell.wallCycle, 0.5, 3),
    deliveredConversations: deliveries,
    deliveredOrphanConversations: cell.orphans,
    deliveredShots: cell.deliveredShots,
    deliveredTasks: cell.deliveredTasks,
    deliveries,
    discardedLengthSeconds: cell.discarded,
    effectiveRate: ratio(cell.effectiveShots, cell.deliveredShots),
    effectiveShots: cell.effectiveShots,
    lengthSeconds: cell.lengthSeconds,
    lengthVideos: cell.lengthVideos,
    oneTakeRate: ratio(cell.oneTakeShots, cell.shots),
    oneTakeShots: cell.oneTakeShots,
    producers: bitCount(cell.producers),
    runs: cell.runs,
    shots: cell.shots,
    tokensPerDelivery: ratio(totalTokensOf(cell), deliveries),
    upstreamSeconds: spreadOf(cell.upstream, 0.9, 1.5),
    usage: {
      cacheHitRate: ratio(cell.cacheRead, readIn),
      cacheReadTokens: cell.cacheRead,
      cacheWriteTokens: cell.cacheWrite,
      inputTokens: cell.input,
      outputTokens: cell.output,
      requests: cell.requests,
      totalTokens: totalTokensOf(cell),
    },
    videoSeconds: spreadOf(cell.video, 0.9, 1.5),
  }
}

// ——— 均线 ———

type AverageContext = { now: number; floor: number }

/** 窗起点：往前推 days 天（含 end 所在那天），活跃日不够就再往前补。 */
const windowStart = (days: number, end: number, { now, floor }: AverageContext): number => {
  let from = addDays(startOfDay(end - 1), -(days - 1))
  while (from > floor && activeDaysIn(from, end, now) < MIN_ACTIVE_DAYS) from = addDays(from, -1)
  return from
}

const averageOf = (value: number | null, from: number, to: number): MovingAverage => ({
  since: iso(from),
  until: iso(to),
  value,
})

/** 件数类：窗里各活跃日日值的平均。 */
const countAverage = (
  pick: (cell: Cell) => number,
  days: number,
  end: number,
  context: AverageContext,
): MovingAverage => {
  const from = windowStart(days, end, context)
  const values: number[] = []
  for (let day = from; day < end; day = addDays(day, 1)) {
    const cell = collect(day, Math.min(addDays(day, 1), end), context.now)
    if (cell.users !== 0) values.push(pick(cell))
  }
  const value =
    values.length === 0 ? null : values.reduce((sum, item) => sum + item, 0) / values.length
  return averageOf(value, from, end)
}

/** 比率类：把整个窗当一格重算，样本不够再往前补；返回窗的起点与那一格。 */
const sampledWindow = (
  sample: (cell: Cell) => number,
  needed: number,
  days: number,
  end: number,
  context: AverageContext,
) => {
  let from = windowStart(days, end, context)
  let cell = collect(from, end, context.now)
  while (from > context.floor && sample(cell) < needed) {
    from = addDays(from, -1)
    cell = collect(from, end, context.now)
  }
  return { cell, from }
}

const movingAveragesOf = (
  days: number,
  end: number,
  bucket: Bucket,
  context: AverageContext,
): MovingAverages => {
  const shots = sampledWindow((cell) => cell.shots, 30, days, end, context)
  const deliveries = sampledWindow(deliveriesOf, 10, days, end, context)
  const cycles = sampledWindow((cell) => cell.activeCycle.count, 10, days, end, context)
  const videos = sampledWindow((cell) => cell.upstream.count, 30, days, end, context)
  const perDelivery = (pick: (cell: Cell) => number) =>
    averageOf(ratio(pick(deliveries.cell), deliveriesOf(deliveries.cell)), deliveries.from, end)
  // 件数类的均线只在按天时有：每小时的柱配日均线没有意义。
  const count = (pick: (cell: Cell) => number) =>
    bucket === 'day' ? countAverage(pick, days, end, context) : null
  return {
    activeCycleSeconds: averageOf(
      ratio(cycles.cell.activeCycle.total, cycles.cell.activeCycle.count),
      cycles.from,
      end,
    ),
    attemptsPerShot: averageOf(ratio(shots.cell.attempts, shots.cell.shots), shots.from, end),
    cacheReadTokensPerDelivery: perDelivery((cell) => cell.cacheRead),
    cacheWriteTokensPerDelivery: perDelivery((cell) => cell.cacheWrite),
    deliveries: count(deliveriesOf),
    effectiveRate: averageOf(
      ratio(shots.cell.effectiveShots, shots.cell.deliveredShots),
      shots.from,
      end,
    ),
    inputTokensPerDelivery: perDelivery((cell) => cell.input),
    lengthSeconds: count((cell) => cell.lengthSeconds),
    oneTakeRate: averageOf(ratio(shots.cell.oneTakeShots, shots.cell.shots), shots.from, end),
    outputTokensPerDelivery: perDelivery((cell) => cell.output),
    producers: count((cell) => bitCount(cell.producers)),
    tokensPerDelivery: perDelivery(totalTokensOf),
    totalTokens: count(totalTokensOf),
    upstreamSeconds: averageOf(
      ratio(videos.cell.upstream.total, videos.cell.upstream.count),
      videos.from,
      end,
    ),
  }
}

// ——— 组装 ———

const calendarDays = (since: number, until: number) =>
  Math.round((startOfDay(until - 1) - startOfDay(since)) / 86_400_000) + 1

const bucketFor = (days: number): Bucket => (days <= 2 ? 'hour' : days <= 120 ? 'day' : 'week')

/** 时间窗里每一期的起点；按周时首期从所在周的周一算起。 */
const periodStarts = (since: number, until: number, bucket: Bucket): number[] => {
  const starts: number[] = []
  if (bucket === 'hour') {
    for (let at = since; at < until; at += HOUR_MS) starts.push(at)
    return starts
  }
  const weekday = (new Date(since).getDay() + 6) % 7
  let at = bucket === 'week' ? addDays(startOfDay(since), -weekday) : startOfDay(since)
  while (at < until) {
    starts.push(at)
    at = addDays(at, bucket === 'week' ? 7 : 1)
  }
  return starts
}

const nextPeriod = (start: number, bucket: Bucket) =>
  bucket === 'hour' ? start + HOUR_MS : addDays(start, bucket === 'week' ? 7 : 1)

/** 按请求的时间窗算一份总览；now 可注入方便测试。 */
export const mockOverviewOf = (query: URLSearchParams, now: number = Date.now()): Overview => {
  const since = new Date(query.get('since') ?? '').getTime()
  const requestedUntil = query.get('until')
  const until = Math.min(requestedUntil === null ? now : new Date(requestedUntil).getTime(), now)
  const days = calendarDays(since, until)
  const bucket = bucketFor(days)
  const previousSince = addDays(since, -days)
  const previousUntil = addDays(until, -days)
  const context: AverageContext = { floor: Math.min(previousSince, addDays(since, -60)), now }
  const current = collect(since, until, now)
  const series: TrendPoint[] = periodStarts(since, until, bucket).map((start) => {
    const end = Math.min(nextPeriod(start, bucket), until)
    const cell = collect(Math.max(start, since), end, now)
    const withAverages = bucket !== 'week'
    return {
      inactive: bucket === 'day' && dayOf(start, now).total.users === 0,
      ma30: withAverages ? movingAveragesOf(30, end, bucket, context) : null,
      ma7: withAverages ? movingAveragesOf(7, end, bucket, context) : null,
      metrics: metricsOf(cell),
      periodStart: iso(start),
    }
  })
  const heavy: HeavyShot[] = []
  for (let day = startOfDay(since); day < until; day = addDays(day, 1)) {
    heavy.push(...dayOf(day, now).heavy.filter((shot) => shot.at >= since && shot.at < until))
  }
  return {
    attemptDistribution: current.histogram.flatMap((shots, attempts) =>
      shots > 0 ? [{ attempts, shots }] : [],
    ),
    current: { activeDays: activeDaysIn(since, until, now), metrics: metricsOf(current) },
    previous: {
      activeDays: activeDaysIn(previousSince, previousUntil, now),
      metrics: metricsOf(collect(previousSince, previousUntil, now)),
    },
    series,
    topShots: heavy
      .sort((a, b) => b.attempts - a.attempts || b.at - a.at)
      .slice(0, 3)
      .map(({ attempts, conversationId, shot, title, userName }) => ({
        attempts,
        conversationId,
        shot,
        title,
        userName,
      })),
    window: {
      bucket,
      generatedAt: iso(now),
      previousSince: iso(previousSince),
      previousUntil: iso(previousUntil),
      since: iso(since),
      timezone: query.get('timezone') ?? 'UTC',
      until: iso(until),
    },
  }
}

export const overviewHandler = http.get('*/api/audit/overview', ({ request }) => {
  const query = new URL(request.url).searchParams
  if (Number.isNaN(new Date(query.get('since') ?? '').getTime())) {
    return HttpResponse.json({ detail: 'since 必填' }, { status: 422 })
  }
  // 按生成的 schema 过一遍，mock 形状漂移时在这里就报出来。
  return HttpResponse.json(zOverviewOut.parse(mockOverviewOf(query)))
})

// ——— 单测 fixture ———

/** 全零的一格指标，给只关心某几个字段的用例当底座。 */
export const emptyAuditMetrics = (): Metrics => ({
  activeCycleSeconds: null,
  activeUsers: 0,
  agentRunSeconds: null,
  attempts: 0,
  attemptsPerShot: null,
  completedVideos: 0,
  cycleSeconds: null,
  deliveredConversations: 0,
  deliveredOrphanConversations: 0,
  deliveredShots: 0,
  deliveredTasks: 0,
  deliveries: 0,
  discardedLengthSeconds: 0,
  effectiveRate: null,
  effectiveShots: 0,
  lengthSeconds: 0,
  lengthVideos: 0,
  oneTakeRate: null,
  oneTakeShots: 0,
  producers: 0,
  runs: 0,
  shots: 0,
  tokensPerDelivery: null,
  upstreamSeconds: null,
  usage: {
    cacheHitRate: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    totalTokens: 0,
  },
  videoSeconds: null,
})

type FixturePoint = { metrics?: Partial<Metrics>; inactive?: boolean }

type FixtureOptions = {
  bucket?: Bucket
  current?: Partial<Metrics>
  currentActiveDays?: number
  previous?: Partial<Metrics>
  previousActiveDays?: number
  /** 缺省七期、全零、都是活跃日。 */
  points?: FixturePoint[]
}

/** 每条均线都取 1，窗就是这一期往前的七天；按小时时件数类为空，按周整组为空。 */
const fixtureAverages = (end: number, bucket: Bucket): MovingAverages => {
  const line = averageOf(1, addDays(end, -7), end)
  const count = bucket === 'day' ? line : null
  return {
    activeCycleSeconds: line,
    attemptsPerShot: line,
    cacheReadTokensPerDelivery: line,
    cacheWriteTokensPerDelivery: line,
    deliveries: count,
    effectiveRate: line,
    inputTokensPerDelivery: line,
    lengthSeconds: count,
    oneTakeRate: line,
    outputTokensPerDelivery: line,
    producers: count,
    tokensPerDelivery: line,
    totalTokens: count,
    upstreamSeconds: line,
  }
}

/** 一份形状完整的总览：本期从 2026 年 9 月 1 日本地零点起，按 bucket 排 points 期。 */
export const overviewFixture = ({
  bucket = 'day',
  current = {},
  currentActiveDays = 7,
  previous = {},
  previousActiveDays = 7,
  points = Array.from({ length: 7 }, () => ({})),
}: FixtureOptions = {}): Overview => {
  const since = new Date(2026, 8, 1).getTime()
  const starts = points.map((_, index) =>
    bucket === 'hour'
      ? since + index * HOUR_MS
      : addDays(since, index * (bucket === 'week' ? 7 : 1)),
  )
  const until = nextPeriod(starts.at(-1) ?? since, bucket)
  const span = calendarDays(since, until)
  return {
    attemptDistribution: [],
    current: { activeDays: currentActiveDays, metrics: { ...emptyAuditMetrics(), ...current } },
    previous: {
      activeDays: previousActiveDays,
      metrics: { ...emptyAuditMetrics(), ...previous },
    },
    series: points.map((point, index) => {
      const start = starts[index] ?? since
      const end = nextPeriod(start, bucket)
      return {
        inactive: point.inactive ?? false,
        ma30: bucket === 'week' ? null : fixtureAverages(end, bucket),
        ma7: bucket === 'week' ? null : fixtureAverages(end, bucket),
        metrics: { ...emptyAuditMetrics(), ...point.metrics },
        periodStart: iso(start),
      }
    }),
    topShots: [],
    window: {
      bucket,
      generatedAt: iso(until),
      previousSince: iso(addDays(since, -span)),
      previousUntil: iso(since),
      since: iso(since),
      timezone: 'Asia/Singapore',
      until: iso(until),
    },
  }
}

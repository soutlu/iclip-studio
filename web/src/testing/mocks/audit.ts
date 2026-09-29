/** 审计清单的 mock：按人与按任务执行；总览另见 audit-overview.ts。

单测与 dev:mock 共用。以此刻为准往前确定地造一批任务执行（一段对话一行），再给对话 mock 里的每段对话各添一行、
身份取自那段对话（从清单点进去打得开），按请求的时间窗、人、排序与游标切出来；
按人是同一批任务执行按人汇总。造出的那批里刻意放了四种异常、已删除、没成片与多模型用量的对话，
还有一个只跑过、没出过片的人，按人表的空值排在他身上。

聚合只求演示自洽，不是后端口径的参考实现：测试要断言数字就用下面的 fixture 喂自己的数据。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import {
  zAuditExecutionsOut,
  zAuditPeopleOut,
  type zExecutionOut,
  type zExecutionShotOut,
  type zExecutionThresholdsOut,
  type zMetricsOut,
  type zModelUsageOut,
  type zPersonOut,
  type zSpreadOut,
} from '@/shared/api/generated/zod.gen'
import {
  emptyAuditMetrics,
  FIXTURE_SINCE,
  GOODS,
  mockPeriodsOf,
  mulberry32,
  overviewHandler,
  PEOPLE,
  PEOPLE_WEIGHT,
  pickWeighted,
  USES,
  uuidOf,
} from './audit-overview'
import { mockAuthUser, mockGovernor } from './auth-user'
import { mockConversations } from './conversations'

type Execution = z.output<typeof zExecutionOut>
type ExecutionsPage = z.output<typeof zAuditExecutionsOut>
type Shot = z.output<typeof zExecutionShotOut>
type Thresholds = z.output<typeof zExecutionThresholdsOut>
type Metrics = z.output<typeof zMetricsOut>
type ModelUsage = z.output<typeof zModelUsageOut>
type Person = z.output<typeof zPersonOut>
type PeopleReport = z.output<typeof zAuditPeopleOut>
type Spread = z.output<typeof zSpreadOut>
type Usage = Metrics['usage']
type Anomaly = Execution['anomalies'][number]
type SortKey = NonNullable<ReturnType<typeof sortKeyOf>>

const HOUR_MS = 3_600_000
/** 造多少段、每段隔多久：约 4.3 小时一段，全部落在近 30 天里，一页 50 段翻得到第三页。 */
const EXECUTION_COUNT = 160
const SPACING_MS = 4.3 * HOUR_MS

/** 只跑过、没出过片的人。 */
const IDLE_PERSON = 'he.huan'

const TASKS = [
  { id: uuidOf(7000, 1), title: '秋冬童鞋主图视频' },
  { id: uuidOf(7000, 2), title: '滑板鞋种草短片' },
  { id: uuidOf(7000, 3), title: '跑鞋新品上市' },
]

/** 这三段挂同一张单、一条成片都没有：需求单卡住。标题故意很长，看截断。 */
const STUCK_TASK = { id: uuidOf(7000, 9), title: '儿童雨靴春季上新短视频（三段都没出片的需求单）' }
const STUCK_TASK_INDEXES = new Set([20, 21, 22])

/** 第五段有一条出片挂了十几个小时（视频悬挂）；没出结果的不算进镜头带，只在异常里看得到。 */
const STUCK_PENDING_ID = uuidOf(8000, 4)

const THRESHOLDS = { retryAtLeast: 3, spendTimes: 3, stuckHours: 1, taskConversations: 3 }

const iso = (at: number) => new Date(at).toISOString()

const flatSpread = (seconds: number, count = 1): Spread => ({
  avg: seconds,
  count,
  median: seconds,
  p90: seconds,
})

const spreadOf = (values: readonly number[]): Spread | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0
  return {
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    count: sorted.length,
    median: at(0.5),
    p90: at(0.9),
  }
}

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item])
  return groups
}

const usageOf = (total: number, random: () => number): Usage => {
  const cacheRead = Math.round(total * (0.62 + random() * 0.2))
  const cacheWrite = Math.round(total * (0.04 + random() * 0.04))
  const output = Math.round(total * (0.05 + random() * 0.06))
  const input = Math.max(0, total - cacheRead - cacheWrite - output)
  return {
    cacheHitRate: ratio(cacheRead, input + cacheRead + cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: input,
    outputTokens: output,
    requests: Math.max(1, Math.round(total / 38_000)),
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

const addUsage = (a: Usage, b: Usage): Usage => {
  const input = a.inputTokens + b.inputTokens
  const cacheRead = a.cacheReadTokens + b.cacheReadTokens
  const cacheWrite = a.cacheWriteTokens + b.cacheWriteTokens
  return {
    cacheHitRate: ratio(cacheRead, input + cacheRead + cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: input,
    outputTokens: a.outputTokens + b.outputTokens,
    requests: a.requests + b.requests,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

const shotsOf = (index: number, random: () => number, idle: boolean): Shot[] => {
  if (idle) return []
  // 卡住的那张单：每段出了两次都失败，一镜也不算。
  if (STUCK_TASK_INDEXES.has(index)) return []
  const count = pickWeighted(random, [0, 1, 2, 3, 4], [0.06, 0.3, 0.32, 0.2, 0.12])
  const shots = Array.from({ length: count }, (_, position): Shot => {
    const tries = pickWeighted(
      random,
      [1, 2, 3, 4, 5, 6, 8],
      [0.5, 0.27, 0.11, 0.05, 0.03, 0.02, 0.02],
    )
    // 约一成失败，失败的不算。
    const attempts = Array.from({ length: tries }).filter(() => random() >= 0.1).length
    return {
      attempts,
      effective: attempts > 0 && random() < 0.6,
      oneTake: attempts === 1,
      shot: position + 1,
    }
  })
  // 一次都没成功的镜不算镜，镜号照原样留空。
  return shots.filter((shot) => shot.attempts > 0)
}

/** 对话 mock 里一段真实对话的身份；带着它造出的那一行指向这段对话，点进去打得开。 */
type Identity = {
  conversationId: string
  createdAt: number
  deletedAt: string | null
  task: { id: string; title: string | null } | null
  title: string
  userName: string
}

/**
 * 第 index 段（0 是最新的）：时间窗之外的事实都在这里定好，异常要看时间窗，另算。
 * 带 identity 时建立时刻、属主、需求单、标题与删除取自那段对话，其余照样按 index 确定地造。
 */
const draftOf = (index: number, now: number, identity?: Identity): Omit<Execution, 'anomalies'> => {
  const random = mulberry32(index * 7919 + 17)
  const createdAt =
    identity?.createdAt ?? now - index * SPACING_MS - Math.floor(random() * 40) * 60_000
  const startedAt = Math.min(now, createdAt + Math.floor(random() * 6) * 60_000)
  const idle = identity === undefined && index % 40 === 13
  const userName =
    identity?.userName ?? (idle ? IDLE_PERSON : pickWeighted(random, PEOPLE, PEOPLE_WEIGHT))
  const task =
    identity !== undefined
      ? identity.task
      : STUCK_TASK_INDEXES.has(index)
        ? STUCK_TASK
        : random() < 0.3
          ? (TASKS[index % TASKS.length] ?? null)
          : null
  const shots = shotsOf(index, random, idle)
  const completed = shots.reduce((sum, shot) => sum + shot.attempts, 0)
  const delivered = completed > 0
  const active = 1500 + random() * 3900
  const deliveredAt = delivered
    ? Math.min(now, startedAt + active * 1000 * (1 + random() * 2))
    : null
  // 约十七段里删掉一段；第 23 段的倍数是消耗离群。
  const deletedAt =
    identity !== undefined
      ? identity.deletedAt
      : index % 17 === 5
        ? iso(Math.min(now, createdAt + 2 * HOUR_MS))
        : null
  const total = Math.round(
    (idle ? 200_000 : 950_000) * Math.exp(0.55 * (random() - 0.5) * 2) * (index % 23 === 7 ? 6 : 1),
  )
  const primary = usageOf(index % 3 === 0 ? Math.round(total * 0.8) : total, random)
  // 每三段有一段另用了一个小模型。
  const usage: ModelUsage[] =
    index % 3 === 0
      ? [
          { modelName: 'qwen3-max', usage: primary },
          { modelName: 'qwen3-plus', usage: usageOf(total - primary.totalTokens, random) },
        ]
      : [{ modelName: 'qwen3-max', usage: primary }]
  const totalUsage = usage.map((item) => item.usage).reduce(addUsage)
  const shotCount = shots.length
  const oneTakeShots = shots.filter((shot) => shot.oneTake).length
  const effectiveShots = shots.filter((shot) => shot.effective).length
  const runs = 1 + (index % 4)
  const metrics: Metrics = {
    ...emptyAuditMetrics(),
    activeCycleSeconds: delivered ? flatSpread(active) : null,
    activeUsers: 1,
    agentRunSeconds: flatSpread(90 + (index % 7) * 40, runs),
    attempts: completed,
    attemptsPerShot: ratio(completed, shotCount),
    completedVideos: completed,
    cycleSeconds:
      deliveredAt === null ? null : flatSpread(Math.max(active, (deliveredAt - startedAt) / 1000)),
    deliveredConversations: delivered ? 1 : 0,
    deliveredOrphanConversations: delivered && task === null ? 1 : 0,
    deliveredTasks: delivered && task !== null ? 1 : 0,
    deliveries: delivered ? 1 : 0,
    effectiveRate: ratio(effectiveShots, shotCount),
    effectiveShots,
    oneTakeRate: ratio(oneTakeShots, shotCount),
    oneTakeShots,
    producers: delivered ? 1 : 0,
    runs,
    shots: shotCount,
    tokensPerDelivery: delivered ? totalUsage.totalTokens : null,
    upstreamSeconds: completed === 0 ? null : flatSpread(190, completed),
    usage: totalUsage,
  }
  return {
    conversationId: identity?.conversationId ?? uuidOf(8000, index),
    createdAt: iso(createdAt),
    deletedAt,
    deliveredAt: deliveredAt === null ? null : iso(deliveredAt),
    metrics,
    shots,
    startedAt: iso(startedAt),
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null,
    title:
      identity?.title ??
      `${GOODS[index % GOODS.length] ?? ''}${USES[Math.floor(index / GOODS.length) % USES.length] ?? ''}`,
    usage,
    userName,
  }
}

/** 与 handlers.addMockUser 同一条规则：两个登录账号用各自的用户名，其他人是 id 的前八位。 */
const usernameOf = (ownerUserId: string): string =>
  ownerUserId === mockAuthUser.id
    ? mockAuthUser.username
    : ownerUserId === mockGovernor.id
      ? mockGovernor.username
      : ownerUserId.slice(0, 8)

/** 按需求单 id 查标题；需求单存在 handlers 里，由它传进来，免得两个模块互相引用。 */
type TaskTitleOf = (taskId: string) => string | null

/** 对话 mock 里的每段对话（墓碑也算，治理者能读）各一行，接在造出的那批后面。 */
const conversationDraftsOf = (now: number, taskTitleOf: TaskTitleOf) =>
  mockConversations.map((conversation, position) =>
    draftOf(EXECUTION_COUNT + position, now, {
      conversationId: conversation.id,
      createdAt: Date.parse(conversation.createdAt),
      deletedAt: conversation.deletedAt,
      task:
        conversation.taskId === null
          ? null
          : { id: conversation.taskId, title: taskTitleOf(conversation.taskId) },
      title: conversation.title,
      userName: usernameOf(conversation.ownerUserId),
    }),
  )

type Window = { since: number; until: number; now: number }

const windowOf = (query: URLSearchParams, now: number): Window | null => {
  const since = Date.parse(query.get('since') ?? '')
  if (Number.isNaN(since)) return null
  const requested = query.get('until')
  return { now, since, until: Math.min(requested === null ? now : Date.parse(requested), now) }
}

/** 建立时刻落在时间窗里的任务执行；按人与按任务执行都从这一批出。 */
const draftsIn = ({ since, until, now }: Window, taskTitleOf: TaskTitleOf) =>
  [
    ...Array.from({ length: EXECUTION_COUNT }, (_, index) => draftOf(index, now)),
    ...conversationDraftsOf(now, taskTitleOf),
  ].filter((draft) => {
    const at = Date.parse(draft.createdAt)
    return at >= since && at < until
  })

/** 一群任务执行合成一格指标：同一需求单只算一件，没挂单的有成片对话各算一件。 */
const metricsOf = (drafts: readonly Omit<Execution, 'anomalies'>[]): Metrics => {
  const delivered = drafts.filter((draft) => draft.deliveredAt !== null)
  const deliveredTasks = new Set(delivered.flatMap((draft) => draft.taskId ?? [])).size
  const orphans = delivered.filter((draft) => draft.taskId === null).length
  const deliveries = deliveredTasks + orphans
  const sum = (pick: (metrics: Metrics) => number) =>
    drafts.reduce((total, draft) => total + pick(draft.metrics), 0)
  const shots = sum((m) => m.shots)
  const usage = drafts
    .map((draft) => draft.metrics.usage)
    .reduce(addUsage, emptyAuditMetrics().usage)
  return {
    ...emptyAuditMetrics(),
    activeCycleSeconds: spreadOf(
      delivered.map((draft) => draft.metrics.activeCycleSeconds?.avg ?? 0),
    ),
    activeUsers: drafts.length === 0 ? 0 : 1,
    attempts: sum((m) => m.attempts),
    attemptsPerShot: ratio(
      sum((m) => m.attempts),
      shots,
    ),
    completedVideos: sum((m) => m.completedVideos),
    cycleSeconds: spreadOf(delivered.map((draft) => draft.metrics.cycleSeconds?.avg ?? 0)),
    deliveredConversations: delivered.length,
    deliveredOrphanConversations: orphans,
    deliveredTasks,
    deliveries,
    effectiveRate: ratio(
      sum((m) => m.effectiveShots),
      shots,
    ),
    effectiveShots: sum((m) => m.effectiveShots),
    oneTakeRate: ratio(
      sum((m) => m.oneTakeShots),
      shots,
    ),
    oneTakeShots: sum((m) => m.oneTakeShots),
    producers: deliveries === 0 ? 0 : 1,
    runs: sum((m) => m.runs),
    shots,
    tokensPerDelivery: ratio(usage.totalTokens, deliveries),
    usage,
  }
}

/** 这个时间窗的四种门槛：消耗离群按全体每件成片平均消耗算，与按不按人筛无关。 */
const thresholdsOf = (drafts: readonly Omit<Execution, 'anomalies'>[]): Thresholds => {
  const perDelivery = metricsOf(drafts).tokensPerDelivery
  return {
    ...THRESHOLDS,
    spendTokens: perDelivery === null ? null : perDelivery * THRESHOLDS.spendTimes,
  }
}

const anomaliesOf = (
  draft: Omit<Execution, 'anomalies'>,
  thresholds: Thresholds,
  stuckTasks: ReadonlySet<string>,
  now: number,
): Anomaly[] => {
  const found: Anomaly[] = []
  if (draft.shots.some((shot) => shot.attempts >= thresholds.retryAtLeast)) found.push('retry')
  const pending = draft.conversationId === STUCK_PENDING_ID
  if (pending && now - Date.parse(draft.startedAt) > thresholds.stuckHours * HOUR_MS) {
    found.push('stuck')
  }
  if (thresholds.spendTokens !== null && draft.metrics.usage.totalTokens > thresholds.spendTokens) {
    found.push('spend')
  }
  if (draft.taskId !== null && stuckTasks.has(draft.taskId)) found.push('task_stuck')
  return found
}

const stuckTasksOf = (drafts: readonly Omit<Execution, 'anomalies'>[]): Set<string> => {
  const byTask = groupBy(
    drafts.filter((draft) => draft.taskId !== null),
    (draft) => draft.taskId ?? '',
  )
  return new Set(
    [...byTask]
      .filter(
        ([, list]) =>
          list.length >= THRESHOLDS.taskConversations &&
          list.every((draft) => draft.deliveredAt === null),
      )
      .map(([taskId]) => taskId),
  )
}

const sortKeyOf = (query: URLSearchParams) => {
  const sort = query.get('sort') ?? 'start'
  return sort === 'start' || sort === 'retries' || sort === 'cycle' || sort === 'tokens'
    ? sort
    : null
}

const SORT_VALUE: Record<SortKey, (execution: Execution) => number | null> = {
  start: (execution) => Date.parse(execution.createdAt),
  retries: (execution) => execution.metrics.attemptsPerShot,
  cycle: (execution) =>
    execution.deliveredAt === null ? null : (execution.metrics.activeCycleSeconds?.avg ?? null),
  tokens: (execution) => execution.metrics.usage.totalTokens,
}

/** 按接口的排序排：空值不管升降都排最后，同值按对话 id 定先后。 */
const sortExecutions = (items: readonly Execution[], key: SortKey, order: 'asc' | 'desc') => {
  const sign = order === 'asc' ? 1 : -1
  const valueOf = SORT_VALUE[key]
  return [...items].sort((x, y) => {
    const a = valueOf(x)
    const b = valueOf(y)
    const tie = x.conversationId.localeCompare(y.conversationId) * sign
    if (a === null || b === null) return a === b ? tie : Number(a === null) - Number(b === null)
    return (a - b) * sign || tie
  })
}

const PAGE_DEFAULT = 20

/** 按请求切一页任务执行；游标记着发它的排序，换了排序还带旧游标就报错，和后端一样。 */
export const mockExecutionsOf = (
  query: URLSearchParams,
  taskTitleOf: TaskTitleOf,
  now: number = Date.now(),
): ExecutionsPage | { error: string } => {
  const window = windowOf(query, now)
  const key = sortKeyOf(query)
  const order = query.get('order') ?? 'desc'
  if (window === null) return { error: 'since 必填' }
  if (key === null || (order !== 'asc' && order !== 'desc')) return { error: '排序参数不对' }
  const drafts = draftsIn(window, taskTitleOf)
  const thresholds = thresholdsOf(drafts)
  const stuckTasks = stuckTasksOf(drafts)
  const userName = query.get('userName')
  const scoped = drafts
    .filter((draft) => userName === null || draft.userName === userName)
    .map((draft) => ({ ...draft, anomalies: anomaliesOf(draft, thresholds, stuckTasks, now) }))
  const prefix = `${key}:${order}:`
  const cursor = query.get('cursor')
  if (cursor !== null && !cursor.startsWith(prefix)) return { error: '游标与排序不符' }
  const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length))
  const limit = Number(query.get('limit') ?? PAGE_DEFAULT)
  const items = sortExecutions(scoped, key, order).slice(offset, offset + limit)
  const end = offset + items.length
  return {
    flagged: scoped.filter((item) => item.anomalies.length > 0).length,
    items,
    nextCursor: end < scoped.length ? `${prefix}${end}` : null,
    thresholds,
    total: scoped.length,
  }
}

/** 按人：时间窗里跑过或出过片的每个人一行，成片多的在前；迷你图按成片时刻分期。 */
export const mockPeopleOf = (
  query: URLSearchParams,
  taskTitleOf: TaskTitleOf,
  now: number = Date.now(),
): PeopleReport | null => {
  const window = windowOf(query, now)
  if (window === null) return null
  const { bucket, periods } = mockPeriodsOf(window.since, window.until)
  const byPerson = groupBy(
    draftsIn(window, taskTitleOf).filter((draft) => draft.userName !== null),
    (draft) => draft.userName ?? '',
  )
  const items = [...byPerson].map(([userName, drafts]): Person => ({
    metrics: metricsOf(drafts),
    trend: periods.map(({ start, end }) => ({
      deliveries: drafts.filter((draft) => {
        const at = draft.deliveredAt === null ? Number.NaN : Date.parse(draft.deliveredAt)
        return at >= start && at < end
      }).length,
      periodStart: iso(start),
    })),
    userName,
  }))
  items.sort(
    (a, b) => b.metrics.deliveries - a.metrics.deliveries || b.metrics.runs - a.metrics.runs,
  )
  return { bucket, items }
}

/** 审计三个读口的 handler；清单里真实对话那几行的需求单标题由 taskTitleOf 查。 */
export const auditHandlers = (taskTitleOf: TaskTitleOf) => [
  overviewHandler,

  http.get('*/api/audit/people', ({ request }) => {
    const report = mockPeopleOf(new URL(request.url).searchParams, taskTitleOf)
    if (report === null) return HttpResponse.json({ detail: 'since 必填' }, { status: 422 })
    // 按生成的 schema 过一遍，mock 形状漂移时在这里就报出来。
    return HttpResponse.json(zAuditPeopleOut.parse(report))
  }),

  http.get('*/api/audit/executions', ({ request }) => {
    const page = mockExecutionsOf(new URL(request.url).searchParams, taskTitleOf)
    if ('error' in page) return HttpResponse.json({ detail: page.error }, { status: 422 })
    return HttpResponse.json(zAuditExecutionsOut.parse(page))
  }),
]

// ——— 单测 fixture ———

/** 缺省门槛：与后端缺省值一致，消耗离群的门槛取 300 万 token。 */
export const MOCK_THRESHOLDS: Thresholds = { ...THRESHOLDS, spendTokens: 3_000_000 }

type ExecutionPatch = Omit<Partial<Execution>, 'metrics'> & { metrics?: Partial<Metrics> }

/** 一段形状完整的任务执行：一镜一次就过、已成片、没有异常；只关心的字段自己覆盖。 */
export const executionFixture = ({ metrics, ...patch }: ExecutionPatch = {}): Execution => ({
  anomalies: [],
  conversationId: crypto.randomUUID(),
  createdAt: '2026-09-01T02:00:00.000Z',
  deletedAt: null,
  deliveredAt: '2026-09-01T03:00:00.000Z',
  metrics: {
    ...emptyAuditMetrics(),
    activeCycleSeconds: flatSpread(1800),
    attempts: 1,
    attemptsPerShot: 1,
    deliveries: 1,
    shots: 1,
    ...metrics,
  },
  shots: [{ attempts: 1, effective: false, oneTake: true, shot: 1 }],
  startedAt: '2026-09-01T02:00:00.000Z',
  taskId: null,
  taskTitle: null,
  title: '一段对话',
  usage: [],
  userName: 'tester',
  ...patch,
})

/** 一页任务执行：总数与异常数缺省按这一页数。 */
export const executionsPageFixture = (
  items: Execution[],
  patch: Partial<ExecutionsPage> = {},
): ExecutionsPage => ({
  flagged: items.filter((item) => item.anomalies.length > 0).length,
  items,
  nextCursor: null,
  thresholds: MOCK_THRESHOLDS,
  total: items.length,
  ...patch,
})

/** 一个人的一行：七天、每天零件的迷你图。 */
export const personFixture = (userName: string, metrics: Partial<Metrics> = {}): Person => ({
  metrics: { ...emptyAuditMetrics(), ...metrics },
  trend: Array.from({ length: 7 }, (_, day) => ({
    deliveries: 0,
    periodStart: iso(FIXTURE_SINCE + day * 24 * HOUR_MS),
  })),
  userName,
})

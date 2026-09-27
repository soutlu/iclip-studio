/** 审计报表的 mock：从内存对话推出一套自洽的对话明细与异常；总览另见 audit-overview.ts。

单测与 dev:mock 共用；数字按对话下标确定地生成，同一组对话每次都算出同样的结果。

这里的聚合只是让演示数据自洽，不是后端口径的参考实现：测试要断言数字就用 `server.use` 喂自己的 fixture，不拿它算出来的值当预期值。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zAnomalyOut,
  zConversationAuditOut,
  zMetricsOut,
  zSpreadOut,
} from '@/shared/api/generated/zod.gen'
import { overviewHandler } from './audit-overview'
import { mockAuthUser, mockGovernor } from './auth-user'
import { mockConversations, type MockConversation } from './conversations'
import { pageBy, type SortKey } from './paging'

type Metrics = z.output<typeof zMetricsOut>
type Spread = z.output<typeof zSpreadOut>
type Report = z.output<typeof zConversationAuditOut>
type Anomaly = z.output<typeof zAnomalyOut>

const HOUR_MS = 60 * 60_000

/** 与 handlers.addMockUser 同一条规则：其他人的用户名是 id 的前八位。 */
const usernameOf = (ownerUserId: string): string =>
  ownerUserId === mockAuthUser.id
    ? mockAuthUser.username
    : ownerUserId === mockGovernor.id
      ? mockGovernor.username
      : ownerUserId.slice(0, 8)

const spread = (values: number[]): Spread | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => {
    const position = (sorted.length - 1) * q
    const low = Math.floor(position)
    const high = Math.ceil(position)
    const lower = sorted[low] ?? 0
    return lower + ((sorted[high] ?? lower) - lower) * (position - low)
  }
  return {
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    count: sorted.length,
    median: at(0.5),
    p90: at(0.9),
  }
}

/** 一组全等的样本：mock 里每段对话只有一个周期、同一批视频耗时相同。 */
const flat = (seconds: number, count: number): Spread | null =>
  count === 0 ? null : { avg: seconds, count, median: seconds, p90: seconds }

const usageOf = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  requests: number,
) => {
  const readIn = input + cacheRead + cacheWrite
  return {
    cacheHitRate: readIn === 0 ? null : cacheRead / readIn,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: input,
    outputTokens: output,
    requests,
    totalTokens: readIn + output,
  }
}

/** 一段对话的明细：镜数、每镜次数、周期都由下标定，第三段起每三段有一镜反复重试。
 *
 * 交付时刻锚在建立时刻上：`updatedAt` 会随改名、换归属、标收尾和删除刷新，拿它当锚点，报表位置和
 * 时间窗归属就会跟着这些操作挪。 */
const reportOf = (conversation: MockConversation, index: number): Report => {
  const shotCount = 2 + (index % 3)
  const deliveredAt = new Date(conversation.createdAt)
  const cycleSeconds = (1.5 + (index % 5) * 0.8) * 3600
  const shots = Array.from({ length: shotCount }, (_, shotIndex) => {
    const attempts = shotIndex === 1 && index % 3 === 2 ? 3 : 1 + ((index + shotIndex) % 2)
    const firstAt = new Date(deliveredAt.getTime() - cycleSeconds * 1000 + shotIndex * 15 * 60_000)
    return {
      attempts,
      // 每三镜里两镜被下载过；mock 里每镜都出成过片，所以出片镜就是全部镜。
      effective: (index + shotIndex) % 3 !== 2,
      firstAt: firstAt.toISOString(),
      oneTake: attempts === 1,
      lastAt: new Date(firstAt.getTime() + (attempts - 1) * 12 * 60_000).toISOString(),
      shot: shotIndex + 1,
    }
  })
  const attempts = shots.reduce((sum, shot) => sum + shot.attempts, 0)
  const completed = shotCount + Math.max(0, attempts - shotCount - 1)
  const effectiveShots = shots.filter((shot) => shot.effective).length
  const usage = usageOf(9000 + index * 1200, 6000 + index * 800, 900, 2200 + index * 150, 6 + index)
  const runs = 1 + (index % 3)
  const metrics: Metrics = {
    activeCycleSeconds: flat(cycleSeconds * 0.6, 1),
    activeUsers: 1,
    agentRunSeconds: flat(180, runs),
    attempts,
    attemptsPerShot: attempts / shotCount,
    completedVideos: completed,
    cycleSeconds: flat(cycleSeconds, 1),
    deliveredConversations: 1,
    deliveredOrphanConversations: conversation.taskId === null ? 1 : 0,
    deliveredShots: shotCount,
    deliveredTasks: conversation.taskId === null ? 0 : 1,
    deliveries: 1,
    discardedLengthSeconds: 0,
    effectiveRate: effectiveShots / shotCount,
    effectiveShots,
    // 出片的片长现在都是空，mock 与线上一致，不计片长。
    lengthSeconds: 0,
    lengthVideos: 0,
    oneTakeRate: shots.filter((shot) => shot.oneTake).length / shotCount,
    oneTakeShots: shots.filter((shot) => shot.oneTake).length,
    producers: 1,
    runs,
    shots: shotCount,
    tokensPerDelivery: usage.totalTokens,
    upstreamSeconds: flat(540, completed),
    usage,
    videoSeconds: flat(600, completed),
  }
  return {
    conversationId: conversation.id,
    deletedAt: conversation.deletedAt,
    deliveredAt: deliveredAt.toISOString(),
    metrics,
    ownerUserId: conversation.ownerUserId,
    shots,
    startedAt: new Date(deliveredAt.getTime() - cycleSeconds * 1000).toISOString(),
    taskId: conversation.taskId,
    title: conversation.title,
    usage: [{ modelName: 'claude-sonnet-5', usage }],
    userName: usernameOf(conversation.ownerUserId),
  }
}

const inScope = (report: Report, query: URLSearchParams): boolean => {
  const since = query.get('since')
  const until = query.get('until')
  const userName = query.get('userName')
  const taskId = query.get('taskId')
  if (since !== null && report.deliveredAt < new Date(since).toISOString()) return false
  if (until !== null && report.deliveredAt >= new Date(until).toISOString()) return false
  if (userName !== null && report.userName !== userName) return false
  if (taskId !== null && report.taskId !== taskId) return false
  return true
}

/** 所有对话都当成出过片的，墓碑也算（治理者能读）。 */
const reportsFor = (query: URLSearchParams): Report[] =>
  mockConversations
    .map((conversation, index) => reportOf(conversation, index))
    .filter((report) => inScope(report, query))
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))

const anomaliesFor = (reports: Report[]): Anomaly[] => {
  const p90 = spread(reports.map((r) => r.metrics.cycleSeconds?.median ?? 0))?.p90 ?? 0
  const base = (report: Report) => ({
    conversationId: report.conversationId,
    generationId: null,
    shot: null,
    taskId: report.taskId,
    threshold: null,
    userName: report.userName,
    value: null,
  })
  const found: Anomaly[] = []
  for (const report of reports) {
    for (const shot of report.shots) {
      if (shot.attempts > 2) {
        found.push({
          ...base(report),
          at: shot.lastAt,
          kind: 'retry',
          shot: shot.shot,
          threshold: 2,
          value: shot.attempts,
        })
      }
    }
    const cycle = report.metrics.cycleSeconds?.median ?? 0
    if (reports.length >= 3 && cycle > p90) {
      found.push({
        ...base(report),
        at: report.deliveredAt,
        kind: 'slow',
        threshold: p90,
        value: cycle,
      })
    }
    if (report.taskId === null) {
      found.push({
        ...base(report),
        at: report.deliveredAt,
        kind: 'no_task',
        value: report.metrics.completedVideos,
      })
    }
    if (report.deletedAt !== null) {
      found.push({
        ...base(report),
        at: report.deletedAt,
        kind: 'deleted',
        value: report.metrics.completedVideos,
      })
    }
  }
  const stuck = reports[0]
  if (stuck !== undefined) {
    found.push({
      ...base(stuck),
      at: new Date(new Date(stuck.deliveredAt).getTime() - 3 * HOUR_MS).toISOString(),
      generationId: crypto.randomUUID(),
      kind: 'stuck',
      shot: 2,
      threshold: 1,
      value: 3.2,
    })
  }
  return found.sort((a, b) => b.at.localeCompare(a.at))
}

/** 两张明细表都按各自的时刻倒序翻页，翻页规则同合同 §6 审计列表。 */
const page = <T>(items: readonly T[], query: URLSearchParams, keyOf: (item: T) => SortKey) =>
  pageBy(items, keyOf, query.get('cursor'), Number(query.get('limit') ?? 20))

export const auditHandlers = [
  overviewHandler,

  http.get('*/api/audit/conversations', ({ request }) => {
    const query = new URL(request.url).searchParams
    return HttpResponse.json(
      page(reportsFor(query), query, (r) => [r.deliveredAt, r.conversationId]),
    )
  }),

  http.get('*/api/audit/anomalies', ({ request }) => {
    const query = new URL(request.url).searchParams
    const kinds = query.getAll('kind')
    const items = anomaliesFor(reportsFor(query)).filter(
      (item) => kinds.length === 0 || kinds.includes(item.kind),
    )
    return HttpResponse.json(
      page(items, query, (a) => [a.at, `${a.kind}:${a.conversationId ?? ''}:${a.shot ?? ''}`]),
    )
  }),
]

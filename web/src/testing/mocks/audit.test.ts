import { describe, expect, it } from 'vitest'
import {
  addDays,
  AUDIT_TIME_ZONE,
  startOfZonedDay,
  startOfZonedMonth,
} from '@/features/audit/audit-time'
import { zAuditExecutionsOut, zOverviewOut } from '@/shared/api/generated/zod.gen'
import { addMockConversation, addMockTask, addMockUser } from './handlers'

describe('审计清单 mock', () => {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const executionsPage = async (params: Record<string, string>) => {
    const query = new URLSearchParams({ since, limit: '50', ...params })
    const response = await fetch(`/api/audit/executions?${query}`)
    return { status: response.status, body: (await response.json()) as unknown }
  }

  const allExecutions = async (sort: string, order: string) => {
    const items = []
    let cursor: string | null = null
    do {
      const { body } = await executionsPage({ sort, order, ...(cursor ? { cursor } : {}) })
      const page = zAuditExecutionsOut.parse(body)
      items.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== null)
    return items
  }

  it('近 30 天里有四种异常、已删除、没成片与多模型用量的对话', async () => {
    const items = await allExecutions('start', 'desc')
    const kinds = new Set(items.flatMap((item) => item.anomalies))
    expect(kinds).toEqual(new Set(['retry', 'stuck', 'spend', 'task_stuck']))
    expect(items.some((item) => item.deletedAt !== null)).toBe(true)
    expect(items.some((item) => item.deliveredAt === null)).toBe(true)
    expect(items.some((item) => item.usage.length > 1)).toBe(true)
  })

  it('对话 mock 里的每段对话各占一行：id、标题、需求单与属主都对得上，属主是名册里的人', async () => {
    const wang = addMockUser('小王')
    const task = addMockTask('通勤鞋履 · 产品展示')
    const conversation = addMockConversation(
      '小王 · 通勤鞋开箱',
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
      wang.id,
    )
    conversation.taskId = task.id

    const items = await allExecutions('start', 'desc')
    expect(items.find((item) => item.conversationId === conversation.id)).toMatchObject({
      taskId: task.id,
      taskTitle: '通勤鞋履 · 产品展示',
      title: '小王 · 通勤鞋开箱',
      userName: wang.username,
    })
  })

  it('按接口排序翻完不重不漏，空值排最后；换了排序还带旧游标就报错', async () => {
    const byStart = await allExecutions('start', 'desc')
    const byCycle = await allExecutions('cycle', 'asc')
    expect(new Set(byCycle.map((item) => item.conversationId))).toEqual(
      new Set(byStart.map((item) => item.conversationId)),
    )
    const firstUndelivered = byCycle.findIndex((item) => item.deliveredAt === null)
    expect(firstUndelivered).toBeGreaterThan(0)
    expect(byCycle.slice(firstUndelivered).every((item) => item.deliveredAt === null)).toBe(true)

    const { body } = await executionsPage({ sort: 'start', order: 'desc' })
    const { nextCursor } = zAuditExecutionsOut.parse(body)
    expect(nextCursor).not.toBeNull()
    const mismatched = await executionsPage({ sort: 'tokens', cursor: nextCursor ?? '' })
    expect(mismatched.status).toBe(422)
  })
})

describe('审计总览 mock', () => {
  const now = new Date()
  const today = startOfZonedDay(now)
  const daysAgo = (days: number) => addDays(today, -days)

  const overviewOf = async (since: Date, until: Date = now) => {
    const query = new URLSearchParams({
      since: since.toISOString(),
      timezone: AUDIT_TIME_ZONE,
      until: until.toISOString(),
    })
    const response = await fetch(`/api/audit/overview?${query}`)
    return zOverviewOut.parse(await response.json())
  }

  it('粒度跟着跨度走：两天内按小时，120 天内按天，更长按周', async () => {
    const hour = await overviewOf(today)
    expect(hour.window.bucket).toBe('hour')
    expect(hour.series[0]?.ma7?.deliveries).toBeNull()
    expect(hour.series[0]?.ma7?.attemptsPerShot).not.toBeNull()

    const day = await overviewOf(daysAgo(29))
    expect(day.window.bucket).toBe('day')
    // 每 29 天里有连续 3 天没人发起运行，30 天的窗一定碰得到。
    expect(day.series.some((point) => point.inactive)).toBe(true)

    const week = await overviewOf(daysAgo(180))
    expect(week.window.bucket).toBe('week')
    expect(week.series.every((point) => point.ma7 === null && point.ma30 === null)).toBe(true)
  })

  it('片长只从本月 1 日起有数据', async () => {
    const lastMonth = await overviewOf(startOfZonedMonth(now, -1), startOfZonedMonth(now))
    expect(lastMonth.current.metrics.lengthVideos).toBe(0)
    expect(lastMonth.current.metrics.completedVideos).toBeGreaterThan(0)
  })
})

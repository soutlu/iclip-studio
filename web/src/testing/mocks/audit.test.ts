import { describe, expect, it } from 'vitest'
import { zOverviewOut } from '@/shared/api/generated/zod.gen'
import { addMockConversation } from './conversations'

type AuditRow = { conversationId: string; deliveredAt: string; deletedAt: string | null }

const auditRowIn = async (conversationId: string, since: string, until: string) => {
  const query = new URLSearchParams({ since, until, limit: '50' })
  const response = await fetch(`/api/audit/conversations?${query}`)
  const { items } = (await response.json()) as { items: AuditRow[] }
  return items.find((item) => item.conversationId === conversationId)
}

describe('审计报表 mock', () => {
  it('删掉对话不挪它的交付时刻，也不挪出原来的时间窗', async () => {
    const conversation = addMockConversation('删掉也不挪位', '2026-09-01T08:00:00.000Z')
    const since = '2026-09-01T00:00:00.000Z'
    const until = '2026-09-02T00:00:00.000Z'
    const before = await auditRowIn(conversation.id, since, until)
    expect(before).toMatchObject({ deletedAt: null })

    const removed = await fetch(`/api/conversations/${conversation.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)

    expect(await auditRowIn(conversation.id, since, until)).toMatchObject({
      deletedAt: expect.any(String),
      deliveredAt: before?.deliveredAt,
    })
  })
})

describe('审计总览 mock', () => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daysAgo = (days: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - days)

  const overviewOf = async (since: Date, until: Date = now) => {
    const query = new URLSearchParams({
      since: since.toISOString(),
      timezone: 'Asia/Singapore',
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
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const lastMonth = await overviewOf(
      new Date(today.getFullYear(), today.getMonth() - 1, 1),
      monthStart,
    )
    expect(lastMonth.current.metrics.lengthVideos).toBe(0)
    expect(lastMonth.current.metrics.completedVideos).toBeGreaterThan(0)
  })
})

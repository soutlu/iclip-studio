import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyAuditMetrics, overviewFixture } from '@/testing/mocks/audit-overview'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { Metrics, Overview } from '../audit.api'
import type { OverviewRange } from '../overview-range'
import { OverviewPanel } from './overview-panel'

// 浏览器在纽约：日期与日历仍按 UTC+8。
beforeAll(() => vi.stubEnv('TZ', 'America/New_York'))
afterAll(() => vi.unstubAllEnvs())
afterEach(() => vi.useRealTimers())

const renderOverview = async (overview: Overview, range: OverviewRange = { preset: '30d' }) => {
  server.use(http.get('*/api/audit/overview', () => HttpResponse.json(overview)))
  const onRangeChange = vi.fn()
  const view = await renderWithProviders(
    <OverviewPanel nameOf={() => undefined} onRangeChange={onRangeChange} range={range} />,
  )
  await screen.findByRole('group', { name: '图例' })
  return { ...view, onRangeChange }
}

const card = (name: string) => screen.getByRole('article', { name })

/** 卡上的环比字悬停写着「与 X–Y 相比」，没有环比就找不到。 */
const deltaOf = (element: HTMLElement) => within(element).queryByTitle(/^与 .+ 相比$/)

const legend = () => screen.getByRole('group', { name: '图例' })

describe('OverviewPanel 环比', () => {
  it('成片数按活跃日日均比，不按总数比', async () => {
    // 12 件 / 4 个活跃日 = 3，10 件 / 5 个活跃日 = 2：日均涨 50%，按总数只涨 20%。
    await renderOverview(
      overviewFixture({
        current: { deliveries: 12 },
        currentActiveDays: 4,
        previous: { deliveries: 10 },
        previousActiveDays: 5,
      }),
    )

    expect(deltaOf(card('成片数'))).toHaveTextContent('升50%')
  })

  it('两期成片都不到 5 件时不比', async () => {
    await renderOverview(
      overviewFixture({ current: { deliveries: 4 }, previous: { deliveries: 3 } }),
    )

    expect(deltaOf(card('成片数'))).toBeNull()
  })

  it.each<{ name: string; enough: Partial<Metrics>; short: Partial<Metrics> }>([
    {
      name: '每镜头重试次数',
      enough: { attemptsPerShot: 1.5, shots: 30 },
      short: { attemptsPerShot: 1.5, shots: 29 },
    },
    {
      name: '单任务平均时长',
      enough: { activeCycleSeconds: { avg: 3600, count: 10, median: 3000, p90: 7200 } },
      short: { activeCycleSeconds: { avg: 3600, count: 9, median: 3000, p90: 7200 } },
    },
    {
      name: '每件成片 · token',
      enough: { deliveries: 10, tokensPerDelivery: 900_000 },
      short: { deliveries: 9, tokensPerDelivery: 900_000 },
    },
  ])('$name：两期样本都够才显示环比', async ({ name, enough, short }) => {
    const previous = { ...enough }
    // 上一期的值差得够远，样本够时一定出环比而不是持平。
    for (const key of ['attemptsPerShot', 'tokensPerDelivery'] as const) {
      if (typeof previous[key] === 'number') previous[key] = previous[key] * 2
    }
    if (previous.activeCycleSeconds) {
      previous.activeCycleSeconds = { ...previous.activeCycleSeconds, avg: 7200 }
    }

    const full = await renderOverview(overviewFixture({ current: enough, previous }))
    expect(deltaOf(card(name))).not.toBeNull()
    full.unmount()

    await renderOverview(overviewFixture({ current: short, previous }))
    expect(deltaOf(card(name))).toBeNull()
  })

  it('素材有效率的环比写百分点，没变就是持平；数字悬停写有效镜与镜数', async () => {
    const shots = { shots: 30 }
    const up = await renderOverview(
      overviewFixture({
        current: { ...shots, effectiveRate: 0.62, effectiveShots: 18 },
        previous: { ...shots, effectiveRate: 0.55 },
      }),
    )
    expect(deltaOf(card('素材有效率'))).toHaveTextContent('升7 个百分点')
    expect(within(card('素材有效率')).getByTitle(/^18 \/ 30 /)).toBeInTheDocument()
    up.unmount()

    await renderOverview(
      overviewFixture({
        current: { ...shots, effectiveRate: 0.55 },
        previous: { ...shots, effectiveRate: 0.55 },
      }),
    )
    expect(deltaOf(card('素材有效率'))).toHaveTextContent('持平')
  })
})

describe('OverviewPanel 片长', () => {
  it('没有片长数据时总时长写横线、图的位置写明暂无', async () => {
    await renderOverview(overviewFixture({ current: { completedVideos: 12, lengthVideos: 0 } }))

    const cost = screen.getByRole('region', { name: '模型消耗' })
    expect(within(cost).getByText('暂无片长数据')).toBeVisible()
    expect(within(cost).queryByRole('img', { name: '总视频生成秒数趋势' })).not.toBeInTheDocument()
  })

  it('有片长时画每期的片长图，分出最终成片与废片', async () => {
    await renderOverview(
      overviewFixture({
        current: {
          completedVideos: 12,
          discardedLengthSeconds: 30,
          lengthSeconds: 120,
          lengthVideos: 12,
        },
      }),
    )

    const cost = screen.getByRole('region', { name: '模型消耗' })
    expect(within(cost).getByRole('img', { name: '总视频生成秒数趋势' })).toBeInTheDocument()
    expect(within(cost).queryByText('暂无片长数据')).not.toBeInTheDocument()
    // 最终成片 = 片长合计 − 废片：120 − 30 = 90 秒。
    expect(within(cost).getByText('最终成片长度').parentElement).toHaveTextContent('1.5 分钟')
  })
})

describe('OverviewPanel 图例', () => {
  it.each([
    { bucket: 'day', averages: true },
    { bucket: 'hour', averages: true },
    { bucket: 'week', averages: false },
  ] as const)('按 $bucket 时均线图例：$averages', async ({ bucket, averages }) => {
    await renderOverview(overviewFixture({ bucket }))

    const lines = [
      within(legend()).queryByText(/7 日均线/),
      within(legend()).queryByText(/30 日均线/),
    ]
    for (const line of lines) {
      if (averages) expect(line).toBeInTheDocument()
      else expect(line).not.toBeInTheDocument()
    }
  })

  it('这一屏有非活跃日才在图例里标出来', async () => {
    const withIdle = await renderOverview(overviewFixture({ points: [{}, { inactive: true }, {}] }))
    expect(within(legend()).getByText('非活跃日')).toBeVisible()
    withIdle.unmount()

    await renderOverview(overviewFixture({ points: [{}, {}, {}] }))
    expect(within(legend()).queryByText('非活跃日')).not.toBeInTheDocument()
  })
})

describe('OverviewPanel 工具条', () => {
  it('写明环比对比的是接口给的上一期', async () => {
    // fixture 本期是 9 月 1 日起七天，上一期往前挪七天。
    await renderOverview(overviewFixture())

    expect(screen.getByText('环比对比 8月25日–31日')).toBeVisible()
  })

  it('快捷档即点即换，日历预设与自定义区间应用后才换', async () => {
    // 只假 Date：此刻 UTC+8 已是 9 月 23 日 00:30，纽约还是 22 日。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-22T16:30:00Z'))
    const user = userEvent.setup()
    const { onRangeChange } = await renderOverview(overviewFixture())

    await user.click(screen.getByRole('radio', { name: '今天' }))
    expect(onRangeChange).toHaveBeenLastCalledWith({ preset: 'today' })

    await user.click(screen.getByRole('button', { name: /^自定义时间范围/ }))
    await user.click(screen.getByRole('button', { name: '上月' }))
    expect(onRangeChange).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '应用' }))
    expect(onRangeChange).toHaveBeenLastCalledWith({ preset: 'lastMonth' })

    // 日历按 UTC+8 的日期：今天是 23 日，24 日起不可选。点起点再点终点：本月 1 日到今天。
    await user.click(screen.getByRole('button', { name: /^自定义时间范围/ }))
    const dialog = screen.getByRole('dialog', { name: '选择时间范围' })
    const button = (name: string) => within(dialog).getByRole('button', { name })
    expect(button('9月23日')).toHaveAttribute('aria-current', 'date')
    expect(button('9月24日')).toBeDisabled()
    await user.click(button('9月1日'))
    expect(button('应用')).toBeDisabled()
    await user.click(button('9月23日'))
    await user.click(button('应用'))
    expect(onRangeChange).toHaveBeenLastCalledWith({
      first: '2026-09-01',
      last: '2026-09-23',
      preset: 'custom',
    })
  })
})

describe('OverviewPanel 读取', () => {
  it('接口失败时给出错误与重试', async () => {
    server.use(
      http.get('*/api/audit/overview', () =>
        HttpResponse.json({ detail: '报表暂时不可用' }, { status: 503 }),
      ),
    )
    await renderWithProviders(
      <OverviewPanel nameOf={() => undefined} onRangeChange={() => {}} range={{ preset: '30d' }} />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('报表暂时不可用')
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible()
  })

  it('出片次数最多的镜写「谁 · 对话名」，名册里有的换成显示名', async () => {
    const overview = {
      ...overviewFixture({ current: { ...emptyAuditMetrics(), shots: 3 } }),
      attemptDistribution: [{ attempts: 6, shots: 1 }],
      topShots: [
        {
          attempts: 6,
          conversationId: '22222222-2222-4222-8222-222222222222',
          shot: 2,
          title: '跑鞋开箱',
          userName: 'zhou.ye',
        },
      ],
    }
    server.use(http.get('*/api/audit/overview', () => HttpResponse.json(overview)))
    await renderWithProviders(
      <OverviewPanel
        nameOf={(userName) => (userName === 'zhou.ye' ? '周野' : undefined)}
        onRangeChange={() => {}}
        range={{ preset: '30d' }}
      />,
    )

    const quality = await screen.findByRole('region', { name: '出片质量' })
    expect(within(quality).getByText('周野 · 跑鞋开箱')).toBeVisible()
  })
})

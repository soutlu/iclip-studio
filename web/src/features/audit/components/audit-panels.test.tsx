import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { emptyAuditMetrics } from '@/testing/mocks/audit-overview'
import { addMockConversation, mockAuthUser, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_AUDIT_SCOPE, type AnomalyKind, type AuditScope, type Metrics } from '../audit.api'
import { AnomaliesPanel } from './anomalies-panel'
import { ConversationsPanel } from './conversations-panel'

const nameOf = (userName: string) =>
  userName === mockAuthUser.username
    ? '测试用户'
    : userName === mockGovernor.username
      ? '治理者'
      : undefined
const TASK_ID = '11111111-1111-4111-8111-111111111111'
const taskTitleOf = (taskId: string) => (taskId === TASK_ID ? '夏季亚麻系列' : undefined)
const ALL_TIME: AuditScope = { ...DEFAULT_AUDIT_SCOPE, range: 'all' }
/** 滚动容器在路由的 `<main>` 上；单测不排版，可控的 IntersectionObserver 替身也不看它。 */
const noScroller = () => null

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString()

/** 记下某个列表接口每次请求的游标。 */
const recordCursors = (path: string) => {
  const cursors: (string | null)[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith(path)) cursors.push(url.searchParams.get('cursor'))
  })
  return cursors
}

/** 等一会儿，给本不该发出的请求留出发出的时间。 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

afterEach(() => vi.unstubAllGlobals())

/** 全零的一格指标，给只关心某一段的用例当底座。 */
const EMPTY_METRICS = emptyAuditMetrics()

/** 三段对话：第三段（下标 2）镜 2 会试三次；第二段没挂需求单；第一段是治理者的。 */
const seed = () => {
  const first = addMockConversation('秋季新品短片', hoursAgo(2), mockGovernor.id)
  first.taskId = TASK_ID
  const second = addMockConversation('无单的试拍', hoursAgo(5))
  const third = addMockConversation('亚麻系列 B 版', hoursAgo(30))
  third.taskId = TASK_ID
  return { first, second, third }
}

describe('ConversationsPanel', () => {
  it('列出有成片的对话，展开看到每镜出片次数与按模型用量', async () => {
    const { third } = seed()
    const user = userEvent.setup()
    await renderWithProviders(
      <ConversationsPanel
        getScrollElement={noScroller}
        nameOf={nameOf}
        scope={ALL_TIME}
        taskTitleOf={taskTitleOf}
      />,
    )

    const list = await screen.findByRole('region', { name: '对话明细' })
    const rows = within(list).getAllByRole('listitem')
    const [firstRow, secondRow] = rows
    expect(rows).toHaveLength(3)
    if (firstRow === undefined || secondRow === undefined) throw new Error('列表应有三行')
    expect(within(firstRow).getByRole('link', { name: '秋季新品短片' })).toHaveAttribute(
      'href',
      expect.stringContaining('/c/'),
    )
    expect(within(firstRow).getByText('夏季亚麻系列')).toBeVisible()
    expect(within(secondRow).getByText('没挂需求单')).toBeVisible()

    const thirdRow = rows.find((row) => within(row).queryByText(third.title) !== null)
    if (thirdRow === undefined) throw new Error('第三段对话应在列表里')
    await user.click(within(thirdRow).getByRole('button', { name: '展开镜头明细' }))

    const shots = within(thirdRow).getByRole('list', { name: '镜头出片次数' })
    expect(
      within(shots).getByRole('listitem', { name: /第 2 镜，出了 3 次，没有一次通过/ }),
    ).toBeVisible()
    expect(within(thirdRow).getByRole('list', { name: '按模型用量' })).toHaveTextContent(
      'claude-sonnet-5',
    )
  })

  it('每段对话给出有效率，没有出片镜的是破折号；镜头带标出有人下载过的镜', async () => {
    const user = userEvent.setup()
    const at = hoursAgo(3)
    const shot = (index: number, effective: boolean) => ({
      attempts: 1,
      effective,
      firstAt: at,
      lastAt: at,
      oneTake: true,
      shot: index,
    })
    const report = (
      conversationId: string,
      title: string,
      metrics: Metrics,
      shots: ReturnType<typeof shot>[],
    ) => ({
      conversationId,
      deletedAt: null,
      deliveredAt: at,
      metrics,
      ownerUserId: mockAuthUser.id,
      shots,
      startedAt: at,
      taskId: null,
      title,
      usage: [],
      userName: mockAuthUser.username,
    })
    server.use(
      http.get('*/api/audit/conversations', () =>
        HttpResponse.json({
          items: [
            report(
              '22222222-2222-4222-8222-222222222222',
              '四镜里一镜被下载',
              {
                ...EMPTY_METRICS,
                attempts: 4,
                attemptsPerShot: 1,
                completedVideos: 4,
                deliveredShots: 4,
                effectiveRate: 0.25,
                effectiveShots: 1,
                oneTakeRate: 1,
                oneTakeShots: 4,
                shots: 4,
              },
              [shot(1, true), shot(2, false), shot(3, false), shot(4, false)],
            ),
            // 成片不带镜号：没有出片镜，有效率算不出来。
            report('33333333-3333-4333-8333-333333333333', '不带镜号的成片', EMPTY_METRICS, []),
          ],
          nextCursor: null,
        }),
      ),
    )
    await renderWithProviders(
      <ConversationsPanel
        getScrollElement={noScroller}
        nameOf={nameOf}
        scope={ALL_TIME}
        taskTitleOf={taskTitleOf}
      />,
    )

    const list = await screen.findByRole('region', { name: '对话明细' })
    const [withShots, withoutShots] = within(list).getAllByRole('listitem')
    if (withShots === undefined || withoutShots === undefined) throw new Error('列表应有两行')
    /** 每行摘要里某一项的值：dt 是名字，紧跟的 dd 是值。 */
    const statOf = (row: HTMLElement, label: string) =>
      within(row).getByText(label, { selector: 'dt' }).nextElementSibling
    expect(statOf(withShots, '有效率')).toHaveTextContent('25.0%')
    expect(statOf(withoutShots, '有效率')).toHaveTextContent('—')

    await user.click(within(withShots).getByRole('button', { name: '展开镜头明细' }))
    const shots = within(withShots).getByRole('list', { name: '镜头出片次数' })
    const downloaded = within(shots).getByRole('listitem', { name: /^第 1 镜.*，有人下载过$/ })
    expect(within(downloaded).getByTitle('有人下载过')).toBeVisible()
    const untouched = within(shots).getByRole('listitem', { name: /^第 2 镜.*，没人下载过$/ })
    expect(within(untouched).queryByTitle('有人下载过')).not.toBeInTheDocument()
  })

  it('没有对话时说明这个范围里没有成片', async () => {
    await renderWithProviders(
      <ConversationsPanel
        getScrollElement={noScroller}
        nameOf={nameOf}
        scope={ALL_TIME}
        taskTitleOf={taskTitleOf}
      />,
    )

    expect(await screen.findByText('这个范围里没有出过片的对话')).toBeVisible()
  })

  it('一页二十段，页脚滚到底部一屏以内才读下一页，读完页脚收起', async () => {
    for (let index = 0; index < 25; index += 1) addMockConversation(`第${index}段`, hoursAgo(index))
    const cursors = recordCursors('/audit/conversations')
    const viewport = stubIntersectionObserver()
    await renderWithProviders(
      <ConversationsPanel
        getScrollElement={noScroller}
        nameOf={nameOf}
        scope={ALL_TIME}
        taskTitleOf={taskTitleOf}
      />,
    )

    const list = await screen.findByRole('region', { name: '对话明细' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(20)
    await settle()
    expect(cursors).toEqual([null])

    await viewport.scroll(true)
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(25))
    expect(cursors).toHaveLength(2)
    expect(cursors[1]).not.toBeNull()
    expect(within(list).queryByRole('status')).not.toBeInTheDocument()
  })
})

/** 种类筛选由上层持有，这里替路由层握住它。 */
function AnomaliesWithKinds() {
  const [kinds, setKinds] = useState<AnomalyKind[]>([])
  return (
    <AnomaliesPanel
      getScrollElement={noScroller}
      kinds={kinds}
      nameOf={nameOf}
      onKindsChange={setKinds}
      scope={ALL_TIME}
      taskTitleOf={taskTitleOf}
    />
  )
}

describe('AnomaliesPanel', () => {
  it('列出异常并按种类筛', async () => {
    seed()
    const user = userEvent.setup()
    await renderWithProviders(<AnomaliesWithKinds />)

    const list = await screen.findByRole('region', { name: '异常列表' })
    expect(within(list).getByText('反复重试')).toBeVisible()
    expect(within(list).getByText('没挂需求单')).toBeVisible()
    expect(within(list).getByText(/第 2 镜出了 3 次/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /反复重试/ }))

    await waitFor(() => {
      const filtered = screen.getByRole('region', { name: '异常列表' })
      expect(within(filtered).queryByText('没挂需求单')).not.toBeInTheDocument()
      expect(within(filtered).getByText('反复重试')).toBeVisible()
    })
  })

  it('页脚滚到底部一屏以内才读下一页，读完页脚收起', async () => {
    const orphan = (hours: number) => ({
      at: hoursAgo(hours),
      conversationId: null,
      generationId: null,
      kind: 'no_task' as const,
      shot: null,
      taskId: null,
      threshold: null,
      userName: mockAuthUser.username,
      value: hours,
    })
    server.use(
      http.get('*/api/audit/anomalies', ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('cursor') === null
            ? { items: [orphan(1), orphan(2)], nextCursor: 'p2' }
            : { items: [orphan(3)], nextCursor: null },
        ),
      ),
    )
    const cursors = recordCursors('/audit/anomalies')
    const viewport = stubIntersectionObserver()
    await renderWithProviders(<AnomaliesWithKinds />)

    const list = await screen.findByRole('region', { name: '异常列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    await settle()
    expect(cursors).toEqual([null])

    await viewport.scroll(true)
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3))
    expect(cursors).toEqual([null, 'p2'])
    expect(within(list).getByText(/出了 3 条成片/)).toBeVisible()
    expect(within(list).queryByRole('status')).not.toBeInTheDocument()
  })
})

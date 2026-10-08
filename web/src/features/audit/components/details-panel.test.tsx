import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { executionFixture, executionsPageFixture, personFixture } from '@/testing/mocks/audit'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_EXECUTION_SORT, type ExecutionsPage, type Person } from '../audit.api'
import { DetailsPanel } from './details-panel'

const nameOf = (userName: string) => (userName === 'lin.xia' ? '林夏' : undefined)
/** 滚动容器在路由的 `<main>` 上；单测不排版，可控的 IntersectionObserver 替身也不看它。 */
const noScroller = () => null

/** 时间范围、按人筛选与排序在路由的查询串里，这里替路由层握住它们。 */
function Harness() {
  const [userName, setUserName] = useState<string | null>(null)
  const [sort, setSort] = useState(DEFAULT_EXECUTION_SORT)
  return (
    <DetailsPanel
      getScrollElement={noScroller}
      nameOf={nameOf}
      onRangeChange={() => {}}
      onSortChange={setSort}
      onUserNameChange={setUserName}
      range={{ preset: '30d' }}
      sort={sort}
      userName={userName}
    />
  )
}

/** 喂按人与按任务执行两个接口，记下按任务执行每次请求的查询串。 */
const serve = ({
  people = [],
  executions,
}: {
  people?: Person[]
  executions: (query: URLSearchParams) => ExecutionsPage
}) => {
  const requests: URLSearchParams[] = []
  server.use(
    http.get('*/api/audit/people', () => HttpResponse.json({ bucket: 'day', items: people })),
    http.get('*/api/audit/executions', ({ request }) => {
      const query = new URL(request.url).searchParams
      requests.push(query)
      return HttpResponse.json(executions(query))
    }),
  )
  return requests
}

const renderDetails = async () => {
  const view = await renderWithProviders(<Harness />)
  await screen.findByRole('table', { name: '按任务执行次数' })
  return view
}

/** 等一会儿，给本不该发出的请求留出发出的时间。 */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

/** 表里某一列的单元格：按表头的可访问名找列号。 */
const cellOf = (table: HTMLElement, row: HTMLElement, column: string) => {
  const headers = within(table).getAllByRole('columnheader')
  const index = headers.findIndex((header) => header.textContent?.startsWith(column))
  const cell = within(row).getAllByRole('cell')[index]
  if (cell === undefined) throw new Error(`找不到「${column}」列`)
  return cell
}

const textNodesOf = (root: Node) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Node[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node)
  return nodes
}

afterEach(() => vi.unstubAllGlobals())

describe('按人', () => {
  it('点表头在前端排序，同一列再点换方向，空值不管升降都排最后', async () => {
    const people = [
      // 成片最多，但没带镜号：每镜头重试次数是空的。
      personFixture('he.huan', { attemptsPerShot: null, deliveries: 9 }),
      personFixture('lin.xia', { attemptsPerShot: 2, deliveries: 5 }),
      personFixture('zhou.ye', { attemptsPerShot: 1.2, deliveries: 8 }),
    ]
    let peopleRequests = 0
    serve({ executions: () => executionsPageFixture([]) })
    server.use(
      http.get('*/api/audit/people', () => {
        peopleRequests += 1
        return HttpResponse.json({ bucket: 'day', items: people })
      }),
    )
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)

    const table = await screen.findByRole('table', { name: '按人' })
    const order = () =>
      bodyRows(table).map(
        (row) =>
          people.find(({ userName }) => within(row).queryByText(userName) !== null)?.userName,
      )
    // 缺省成片数降序。
    expect(order()).toEqual(['he.huan', 'zhou.ye', 'lin.xia'])

    const header = within(table).getByRole('button', { name: '每镜头重试次数' })
    await user.click(header)
    expect(order()).toEqual(['lin.xia', 'zhou.ye', 'he.huan'])
    await user.click(header)
    expect(order()).toEqual(['zhou.ye', 'lin.xia', 'he.huan'])
    // 排序在前端做，不重新请求。
    expect(peopleRequests).toBe(1)
  })
})

describe('按人筛选', () => {
  it('选了人，按人表只留他，按任务执行带上用户名重新读', async () => {
    const rows = [
      executionFixture({ title: '林夏的一段', userName: 'lin.xia' }),
      executionFixture({ title: '周野的一段', userName: 'zhou.ye' }),
    ]
    const requests = serve({
      people: [personFixture('lin.xia', { deliveries: 3 }), personFixture('zhou.ye')],
      executions: (query) => {
        const userName = query.get('userName')
        return executionsPageFixture(
          rows.filter((row) => userName === null || row.userName === userName),
        )
      },
    })
    const user = userEvent.setup()
    await renderDetails()

    await user.click(screen.getByRole('button', { name: '按人筛选' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '林夏' }))

    expect(screen.getByRole('button', { name: '按人筛选：林夏' })).toBeVisible()
    const people = screen.getByRole('table', { name: '按人' })
    expect(bodyRows(people)).toHaveLength(1)
    expect(within(people).getByText('林夏')).toBeVisible()
    const executions = screen.getByRole('table', { name: '按任务执行次数' })
    await waitFor(() => expect(bodyRows(executions)).toHaveLength(1))
    expect(within(executions).getByRole('link', { name: '林夏的一段' })).toBeVisible()
    expect(requests.map((query) => query.get('userName'))).toEqual([null, 'lin.xia'])
  })

  it('选中的人不在这个范围的名单里就清掉', async () => {
    const requests = serve({
      people: [personFixture('zhou.ye')],
      executions: () => executionsPageFixture([executionFixture({ userName: 'zhou.ye' })]),
    })
    const onUserNameChange = vi.fn()
    await renderWithProviders(
      <DetailsPanel
        getScrollElement={noScroller}
        nameOf={nameOf}
        onRangeChange={() => {}}
        onSortChange={() => {}}
        onUserNameChange={onUserNameChange}
        range={{ preset: '30d' }}
        sort={DEFAULT_EXECUTION_SORT}
        userName="lin.xia"
      />,
    )

    await waitFor(() => expect(onUserNameChange).toHaveBeenCalledWith(null))
    expect(screen.getByRole('button', { name: '按人筛选' })).toBeVisible()
    expect(bodyRows(screen.getByRole('table', { name: '按人' }))).toHaveLength(1)
    await waitFor(() => expect(requests.at(-1)?.get('userName')).toBeNull())
  })
})

describe('按任务执行次数', () => {
  /** 两页：第一页 2 段带游标，第二页 1 段；游标记着发它的排序。 */
  const twoPages = (query: URLSearchParams) => {
    const tag = `${query.get('sort')}:${query.get('order')}`
    return query.get('cursor') === null
      ? executionsPageFixture([executionFixture(), executionFixture()], {
          nextCursor: `${tag}:p2`,
          total: 3,
        })
      : executionsPageFixture([executionFixture()], { total: 3 })
  }

  it('一页 50 段，滚到接近底部才读下一页，读完页脚收起', async () => {
    const requests = serve({ executions: twoPages })
    const viewport = stubIntersectionObserver()
    await renderDetails()

    const table = screen.getByRole('table', { name: '按任务执行次数' })
    expect(bodyRows(table)).toHaveLength(2)
    await settle()
    expect(requests.map((query) => query.get('cursor'))).toEqual([null])
    expect(requests[0]?.get('limit')).toBe('50')

    await viewport.scroll(true)
    await waitFor(() => expect(bodyRows(table)).toHaveLength(3))
    expect(requests.map((query) => query.get('cursor'))).toEqual([null, 'start:desc:p2'])
    expect(screen.queryByText(/已显示/)).not.toBeInTheDocument()
  })

  it('点表头按新排序从第一页重读，同一列再点换方向', async () => {
    const requests = serve({ executions: twoPages })
    const viewport = stubIntersectionObserver()
    const user = userEvent.setup()
    await renderDetails()
    await viewport.scroll(true)
    await waitFor(() => expect(requests).toHaveLength(2))
    await viewport.scroll(false)

    const table = screen.getByRole('table', { name: '按任务执行次数' })
    const header = within(table).getByRole('button', { name: '运行时长' })
    await user.click(header)
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]?.get('sort')).toBe('cycle')
    expect(requests[2]?.get('order')).toBe('desc')
    expect(requests[2]?.has('cursor')).toBe(false)
    expect(within(table).getByRole('columnheader', { name: '运行时长' })).toHaveAttribute(
      'aria-sort',
      'descending',
    )

    await user.click(header)
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3]?.get('order')).toBe('asc')
    expect(requests[3]?.has('cursor')).toBe(false)
  })

  it('点整行或在行上按 Enter / 空格展开镜头带与按模型用量；点对话名是打开对话，不展开', async () => {
    const execution = executionFixture({
      shots: [
        { attempts: 1, effective: true, oneTake: true, shot: 1 },
        { attempts: 3, effective: false, oneTake: false, shot: 2 },
        { attempts: 8, effective: false, oneTake: false, shot: 4 },
      ],
      title: '秋季新品短片',
      usage: [
        { modelName: 'qwen3-max', usage: executionFixture().metrics.usage },
        { modelName: 'qwen3-plus', usage: executionFixture().metrics.usage },
      ],
    })
    serve({ executions: () => executionsPageFixture([execution]) })
    const user = userEvent.setup()
    const { router } = await renderDetails()

    const row = screen.getByRole('row', { name: /秋季新品短片/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(within(row).getByText('是'))
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const shots = screen.getByRole('list', { name: '镜头带' })
    expect(
      within(shots).getByRole('listitem', { name: '第 1 镜，成功 1 次，一次通过' }),
    ).toBeVisible()
    expect(within(shots).getByRole('listitem', { name: '第 2 镜，成功 3 次' })).toBeVisible()
    // 每次成功一个点，最多画六个，多的写成 +N。
    const dotsOf = (item: HTMLElement) => item.querySelectorAll('i').length
    expect(dotsOf(within(shots).getByRole('listitem', { name: '第 2 镜，成功 3 次' }))).toBe(3)
    const many = within(shots).getByRole('listitem', { name: '第 4 镜，成功 8 次' })
    expect(dotsOf(many)).toBe(6)
    expect(within(many).getByText('+2')).toBeVisible()
    expect(
      within(screen.getByRole('list', { name: '按模型用量' })).getAllByRole('listitem'),
    ).toHaveLength(2)

    await user.click(within(row).getByText('是'))
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: '镜头带' })).not.toBeInTheDocument()

    row.focus()
    await user.keyboard('{Enter}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(row).toHaveAttribute('aria-expanded', 'false')

    await user.click(within(row).getByRole('link', { name: '秋季新品短片' }))
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/c/${execution.conversationId}`),
    )
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('异常图标放在对应那项数据前，悬停说明带接口给的门槛', async () => {
    const thresholds = {
      retryAtLeast: 4,
      spendTimes: 5,
      spendTokens: 2_500_000,
      stuckHours: 2,
      taskConversations: 6,
    }
    serve({
      executions: () =>
        executionsPageFixture(
          [
            executionFixture({
              anomalies: ['retry', 'stuck', 'spend', 'task_stuck'],
              taskTitle: '儿童雨靴',
              title: '四种都有',
            }),
          ],
          { thresholds },
        ),
    })
    const user = userEvent.setup()
    await renderDetails()

    const table = screen.getByRole('table', { name: '按任务执行次数' })
    const row = screen.getByRole('row', { name: /四种都有/ })
    /** 图标在数据前面：单元格里它前头没有字，后头是那项数据。 */
    const expectFlagFirst = (column: string, name: RegExp) => {
      const cell = cellOf(table, row, column)
      const flag = within(cell).getByRole('img', { name })
      const textOn = (side: number) =>
        textNodesOf(cell)
          .filter((node) => flag.compareDocumentPosition(node) & side)
          .map((node) => node.textContent)
          .join('')
      expect(textOn(Node.DOCUMENT_POSITION_PRECEDING)).toBe('')
      expect(textOn(Node.DOCUMENT_POSITION_FOLLOWING)).not.toBe('')
      return flag
    }
    const retry = expectFlagFirst('每镜头重试次数', /^反复重试：单镜成功生成 4 次及以上$/)
    expectFlagFirst('成片', /^视频悬挂：提交上游超过 2 小时尚未返回结果$/)
    expectFlagFirst('token 消耗', /^消耗离群：.*5 倍（250 万 token）$/)
    expectFlagFirst('需求单', /^需求单卡住：已关联 6 段以上对话/)
    expect(within(cellOf(table, row, '运行时长')).queryByRole('img')).not.toBeInTheDocument()

    await user.hover(retry)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('单镜成功生成 4 次及以上')
  })

  it.each([
    { flagged: 0, title: '共 12 次' },
    { flagged: 3, title: '共 12 次 · 3 次有异常' },
  ])('标题旁写总数，有异常时再写几次有异常：$title', async ({ flagged, title }) => {
    // 总数与异常数说的是整个范围，不是这一页。
    serve({ executions: () => executionsPageFixture([executionFixture()], { flagged, total: 12 }) })
    await renderDetails()

    const region = screen.getByRole('region', { name: '按任务执行次数' })
    expect(within(region).getByText(/^共 \d+ 次/)).toHaveTextContent(new RegExp(`^${title}$`))
  })
})

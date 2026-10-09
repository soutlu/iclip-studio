import { act, cleanup, render as renderDom, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addMockCollection,
  addMockConversation,
  addMockTask,
  loginAs,
  mockAuthUser,
  mockCollections,
} from '@/testing/mocks/handlers'
import { useLiveConversations } from '@/features/conversations'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { Toaster } from '@/shared/ui/toast'
import { SidebarConversations } from './-sidebar-conversations'
import { mockConversations } from '@/testing/mocks/conversations'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { SERVER_HELLO, sessionEnvelope } from '@/testing/ws'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 全局帧订阅在应用里挂在 AppSidebar 顶层；这里照样在对话区外面挂一次，帧才进得了缓存。 */
function LiveFrames() {
  useLiveConversations()
  return null
}

/** 按分钟递增建立时间，验证列表倒序。 */
const seedConversations = (count: number, collectionId: string | null = null) =>
  Array.from({ length: count }, (_, index) => {
    const conversation = addMockConversation(
      `第${index}段`,
      new Date(Date.UTC(2026, 7, 29, 0, index)).toISOString(),
    )
    conversation.collectionId = collectionId
    return conversation
  })

/**
 * session_id 位于信封；运行帧省略 last_turn_reason。
 * 服务端提交之后才发帧，单行补读读到的就是帧说的事实：这里同步改 mock 里那一行（开跑时照 touch_run 抹掉收尾标记）。
 */
const workChanged = (
  conversationId: string,
  payload: {
    busy: boolean
    last_turn_reason?: 'completed' | 'failed' | 'aborted'
    pending_interaction?: 'none' | 'approval' | 'question'
  },
) => {
  const row = mockConversations.find((one) => one.id === conversationId)
  if (row !== undefined) {
    row.activity = {
      ...row.activity,
      busy: payload.busy,
      lastTurnReason: payload.last_turn_reason ?? row.activity.lastTurnReason,
      pendingInteraction: payload.pending_interaction ?? 'none',
    }
    if (payload.busy) row.completedAt = null
  }
  return workFrame(conversationId, payload)
}

/** 开跑记录运行：服务端写下新的 lastRunId、抹掉收尾标记，再发一帧 updated 带出整行。 */
const runStarted = (conversationId: string, runId: string) => {
  const row = mockConversations.find((one) => one.id === conversationId)
  if (row === undefined) throw new Error('没有这段对话')
  const before = row.lastSeq
  row.lastRunId = runId
  row.completedAt = null
  return {
    ...sessionEnvelope(conversationId),
    type: 'event.session.updated',
    session_id: conversationId,
    payload: { ...row, lastSeq: before },
  }
}

const workFrame = (
  conversationId: string,
  payload: {
    busy: boolean
    last_turn_reason?: 'completed' | 'failed' | 'aborted'
    pending_interaction?: 'none' | 'approval' | 'question'
  },
) => ({
  ...sessionEnvelope(conversationId),
  type: 'event.session.work_changed',
  session_id: conversationId,
  payload: { pending_interaction: 'none', ...payload },
})

const render = async (initialPath = '/', permissions = mockAuthUser.permissions) => {
  loginAs(mockAuthUser, { permissions })
  const user = userEvent.setup()
  const onStartInCollection = vi.fn()
  const { router, socket } = await renderWithProviders(
    <>
      <LiveFrames />
      <SidebarConversations onStartInCollection={onStartInCollection} />
    </>,
    { initialPath },
  )
  return { onStartInCollection, router, socket, user }
}

/** 服务端改了一行之后发的 updated 帧，带出整行；行内 lastSeq 是写入之前的水位。 */
const rowUpdated = (row: (typeof mockConversations)[number]) => {
  const before = row.lastSeq
  return {
    ...sessionEnvelope(row.id),
    type: 'event.session.updated',
    session_id: row.id,
    payload: { ...row, lastSeq: before },
  }
}

/** 记下某个路径的 GET 次数。 */
const countReads = (pathname: string) => {
  const reads = { count: 0 }
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET' && new URL(request.url).pathname === pathname) reads.count += 1
  })
  return reads
}

/** 种 50 段未归类对话（三页：20、20、10），列表末尾常在视野里，挂上后自动读完三页。 */
const renderWithAllPagesLoaded = async () => {
  const rows = seedConversations(50)
  stubIntersectionObserver({ inRange: true })
  const rendered = await render()
  await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(50))
  return { ...rendered, rows }
}

/** 合集上方的三档筛选：点一档。「运行中」有任务在跑时可访问名带后缀，按前缀找。 */
const pickFilter = async (user: ReturnType<typeof userEvent.setup>, option: string) => {
  const filter = await screen.findByRole('radiogroup', { name: '任务筛选' })
  await user.click(within(filter).getByRole('radio', { name: new RegExp(`^${option}`) }))
}

/** 把对话标成此刻在跑：服务端的「运行中」档按它筛。 */
const markBusy = (conversation: (typeof mockConversations)[number]) => {
  conversation.activity = { ...conversation.activity, busy: true }
}

describe('SidebarConversations', () => {
  it('首次请求期间显示加载，失败后显示错误并可重试，不误报空列表', async () => {
    let finishRequest: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => {
      finishRequest = resolve
    })
    let attempts = 0
    server.use(
      http.get('*/api/conversations', () => {
        attempts += 1
        return attempts === 1
          ? firstResponse
          : HttpResponse.json({
              collections: [],
              ungroupedCount: 0,
              ungrouped: { items: [], nextCursor: null },
            })
      }),
    )
    const { user } = await render()
    expect(await screen.findByText('正在加载任务…')).toBeVisible()
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument()
    finishRequest?.(HttpResponse.json({ detail: '对话服务暂不可用' }, { status: 503 }))

    expect(await screen.findByRole('alert')).toHaveTextContent('对话服务暂不可用')
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新加载任务' }))

    expect(await screen.findByText('暂无任务')).toBeVisible()
    expect(screen.getByText('暂无合集')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('缺少 agent:read 时明确提示无权限，不查询侧栏或误报空列表', async () => {
    const listed: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === '/api/conversations') listed.push(request.url)
    })
    await render('/', ['tasks:read'])

    expect(await screen.findByText('当前账号没有查看任务权限')).toBeVisible()
    expect(listed).toEqual([])
    expect(screen.queryByText('暂无任务')).not.toBeInTheDocument()
  })

  it('只读用户能打开对话，但没有重命名、归属、删除和合集管理入口', async () => {
    const collection = addMockCollection('只读合集')
    const conversation = addMockConversation('可阅读的对话')
    const { router, user } = await render('/', ['agent:read', 'collections:read'])

    await user.click(await screen.findByRole('link', { name: conversation.title }))
    expect(router.state.location.pathname).toBe(`/c/${conversation.id}`)
    expect(
      screen.queryByRole('button', { name: `${conversation.title} 的更多操作` }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: `${collection.name} 的操作` }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: `在「${collection.name}」里新建任务` }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建合集' })).not.toBeInTheDocument()
  })

  it('能发起任务时合集行上有「在合集里新建任务」，排在 ⋯ 左边；点它把合集交给应用侧栏', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const { onStartInCollection, user } = await render()

    const start = await screen.findByRole('button', { name: '在「夏季亚麻系列」里新建任务' })
    const more = screen.getByRole('button', { name: '夏季亚麻系列 的操作' })
    expect(start.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.click(start)

    expect(onStartInCollection).toHaveBeenCalledTimes(1)
    expect(onStartInCollection).toHaveBeenCalledWith(collection.id)
    // 只有这一个入口，⋯ 菜单里不另放。
    await user.click(more)
    expect(await screen.findByRole('menu')).not.toHaveTextContent('新建任务')
  })

  it('服务端拒绝读取时显示权限错误，不把拒绝解释为空列表', async () => {
    server.use(
      http.get('*/api/conversations', () =>
        HttpResponse.json({ detail: '权限已变更' }, { status: 403 }),
      ),
    )
    await render()

    expect(await screen.findByRole('alert')).toHaveTextContent('当前账号没有查看任务权限')
    expect(screen.queryByRole('heading', { name: '任务' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载任务' })).toBeEnabled()
  })

  it('没有候选读取权限时保留现有关联，禁止误改且不请求候选接口', async () => {
    const collection = addMockCollection('现有关联')
    const task = addMockTask('现有需求单')
    const conversation = addMockConversation('保持归属')
    conversation.collectionId = collection.id
    conversation.taskId = task.id
    const candidateRequests: string[] = []
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname
      if (path === '/api/collections' || path === '/api/tasks') candidateRequests.push(path)
    })
    const { user } = await render('/', ['agent:read', 'agent:run'])
    await user.click(await screen.findByRole('button', { name: '现有关联 (1)' }))
    await user.click(screen.getByRole('button', { name: '保持归属 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '移到合集…' }))
    const dialog = await screen.findByRole('dialog', { name: '任务归属' })

    const collectionSelect = within(dialog).getByRole('combobox', { name: '合集' })
    const taskSelect = within(dialog).getByRole('combobox', { name: '需求单' })
    expect(collectionSelect).toBeDisabled()
    expect(collectionSelect).toHaveValue(collection.id)
    expect(taskSelect).toBeDisabled()
    expect(taskSelect).toHaveValue(task.id)
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled()
    expect(candidateRequests).toEqual([])
  })

  it('候选读取失败时只禁用失败字段，重新加载成功后允许选择', async () => {
    const collection = addMockCollection('可选合集')
    addMockConversation('等待候选')
    let failed = true
    server.use(
      http.get('*/api/collections', () =>
        failed
          ? HttpResponse.json({ detail: '合集暂不可用' }, { status: 503 })
          : HttpResponse.json({ items: [collection] }),
      ),
    )
    const { user } = await render()
    await user.click(await screen.findByRole('button', { name: '等待候选 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '移到合集…' }))
    const dialog = await screen.findByRole('dialog', { name: '任务归属' })
    await within(dialog).findByText('读取合集失败，请重试')
    expect(within(dialog).getByRole('combobox', { name: '合集' })).toBeDisabled()
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: '需求单' })).toBeEnabled(),
    )

    failed = false
    await user.click(within(dialog).getByRole('button', { name: '重新加载合集' }))

    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: '合集' })).toBeEnabled(),
    )
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '合集' }), collection.id)
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('筛选接线到服务端：运行中只列此刻在跑的，已完成按属主标记', async () => {
    markBusy(addMockConversation('正在跑', new Date(Date.UTC(2026, 7, 29, 0, 0)).toISOString()))
    addMockConversation('还在弄', new Date(Date.UTC(2026, 7, 29, 0, 1)).toISOString())
    const finished = addMockConversation(
      '收尾了',
      new Date(Date.UTC(2026, 7, 29, 0, 2)).toISOString(),
    )
    finished.completedAt = new Date(Date.UTC(2026, 7, 29, 1, 0)).toISOString()
    // 记录实际请求，验证筛选参数传递到服务端。
    const listed: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/conversations?')) listed.push(request.url)
    })
    const { user } = await render()

    expect(await screen.findByRole('link', { name: '收尾了' })).toBeVisible()
    expect(screen.getAllByRole('link')).toHaveLength(3)

    await pickFilter(user, '运行中')

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: '收尾了' })).not.toBeInTheDocument(),
    )
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['正在跑'])
    expect(listed.at(-1)).toContain('state=running')

    await pickFilter(user, '已完成')

    expect(await screen.findByRole('link', { name: '收尾了' })).toBeVisible()
    expect(screen.queryByRole('link', { name: '正在跑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '还在弄' })).not.toBeInTheDocument()
    expect(listed.at(-1)).toContain('state=done')
  })

  it('筛选三档平铺在合集上方，选中项跟着换、键盘可选；有对话在跑时「运行中」带上提示', async () => {
    const [conversation] = seedConversations(1)
    const { socket, user } = await render()
    await screen.findByText('第0段')

    const filter = screen.getByRole('radiogroup', { name: '任务筛选' })
    expect(
      within(filter)
        .getAllByRole('radio')
        .map((item) => item.textContent),
    ).toEqual(['全部', '运行中', '已完成'])
    // 筛选同时管合集与任务区，排在合集之前；任务标题行里不再有筛选。
    const collections = screen.getByRole('heading', { name: '合集' })
    expect(
      filter.compareDocumentPosition(collections) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^任务筛选/ })).not.toBeInTheDocument()
    expect(within(filter).getByRole('radio', { name: '全部' })).toBeChecked()

    // 再点已选中的一档不会清空筛选；方向键在三档间移动，空格选中。
    await user.click(within(filter).getByRole('radio', { name: '全部' }))
    expect(within(filter).getByRole('radio', { name: '全部' })).toBeChecked()
    await user.keyboard('{ArrowRight}')
    expect(within(filter).getByRole('radio', { name: '运行中' })).toHaveFocus()
    await user.keyboard(' ')
    // 换档后列表按新档位重读，筛选不重挂：选中当场切换，焦点留在选中项上，方向键接着可用。
    const radio = (name: string) => within(filter).getByRole('radio', { name })
    expect(radio('运行中')).toBeChecked()
    expect(radio('全部')).not.toBeChecked()
    expect(radio('运行中')).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(radio('已完成')).toHaveFocus()
    await user.keyboard(' ')
    expect(radio('已完成')).toBeChecked()
    expect(radio('运行中')).not.toBeChecked()
    expect(screen.getByRole('radiogroup', { name: '任务筛选' })).toBe(filter)

    await pickFilter(user, '全部')
    await screen.findByText('第0段')
    socket.deliver(workChanged(conversation?.id ?? '', { busy: true }))
    expect(await within(filter).findByRole('radio', { name: '运行中，有任务在跑' })).toBeVisible()
  })

  it('换档时拓扑还在读：筛选留在原处、选中项当场切换并留住焦点，加载提示出在它下方；读到后列表出现', async () => {
    const running = addMockConversation('正在跑')
    markBusy(running)
    addMockConversation('闲着的')
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      // 只扣住「运行中」那一档的拓扑；放行后交给默认处理器照常作答。
      http.get('*/api/conversations', async ({ request }) => {
        if (new URL(request.url).searchParams.get('state') !== 'running') return undefined
        await held
        return undefined
      }),
    )
    const { user } = await render()
    expect(await screen.findByRole('link', { name: '闲着的' })).toBeVisible()
    const filter = screen.getByRole('radiogroup', { name: '任务筛选' })

    await user.click(within(filter).getByRole('radio', { name: '全部' }))
    await user.keyboard('{ArrowRight} ')

    const runningRadio = within(filter).getByRole('radio', { name: /^运行中/ })
    expect(screen.getByRole('radiogroup', { name: '任务筛选' })).toBe(filter)
    expect(runningRadio).toBeChecked()
    expect(runningRadio).toHaveFocus()
    const loading = await screen.findByText('正在加载任务…')
    expect(loading).toHaveAttribute('role', 'status')
    expect(filter.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('link', { name: '闲着的' })).not.toBeInTheDocument()

    release?.()

    expect(await screen.findByRole('link', { name: '正在跑' })).toBeVisible()
    expect(screen.queryByText('正在加载任务…')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '闲着的' })).not.toBeInTheDocument()
    expect(runningRadio).toHaveFocus()
  })

  it('键盘从对话链接 Tab 到 ⋯ 按钮，行尾状态仍留在原处可读', async () => {
    const [conversation] = seedConversations(1)
    if (conversation !== undefined) {
      conversation.activity = {
        busy: false,
        lastTurnReason: 'failed',
        pendingInteraction: 'none',
        videoGeneration: 'running',
      }
    }
    const { user } = await render()
    const link = await screen.findByRole('link', { name: '第0段' })

    link.focus()
    await user.tab()

    const more = screen.getByRole('button', { name: '第0段 的更多操作' })
    expect(more).toHaveFocus()
    expect(screen.getByText('上次失败')).toBeVisible()
    expect(screen.getByRole('img', { name: '视频生成中' })).toBeVisible()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('menuitem', { name: '重命名' })).toHaveFocus()
  })

  it('行菜单标记完成：角标出现，再点一次取消', async () => {
    addMockConversation('春季鞋款分镜', new Date(Date.UTC(2026, 7, 29, 0, 0)).toISOString())
    const { user } = await render()

    await user.click(await screen.findByRole('button', { name: '春季鞋款分镜 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '标记完成' }))

    expect(await screen.findByLabelText('已完成')).toBeVisible()

    await user.click(await screen.findByRole('button', { name: '春季鞋款分镜 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '取消完成' }))

    await waitFor(() => expect(screen.queryByLabelText('已完成')).not.toBeInTheDocument())
  })

  it('行菜单删除先弹确认：取消不发删除请求，确认后才删掉那一行', async () => {
    const conversation = addMockConversation('要删的那段')
    const deletes: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'DELETE') deletes.push(new URL(request.url).pathname)
    })
    const { user } = await render()

    await user.click(await screen.findByRole('button', { name: '要删的那段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除这个任务？' })
    expect(within(dialog).getByText('要删的那段')).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(deletes).toEqual([])
    expect(screen.getByRole('link', { name: '要删的那段' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '要删的那段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: '删除这个任务？' })).getByRole('button', {
        name: '删除',
      }),
    )

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByRole('link', { name: '要删的那段' })).not.toBeInTheDocument()
    expect(deletes).toEqual([`/api/conversations/${conversation.id}`])
  })

  it('删除失败时弹窗留着并报错，那一行还在', async () => {
    addMockConversation('删不掉的那段')
    server.use(
      http.delete('*/api/conversations/:conversationId', () =>
        HttpResponse.json({ detail: '对话服务暂不可用' }, { status: 503 }),
      ),
    )
    // 应用里 Toaster 挂在根上；这里单独挂一个接住失败提示。
    renderDom(<Toaster />)
    const { user } = await render()

    await user.click(await screen.findByRole('button', { name: '删不掉的那段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog', { name: '删除这个任务？' })
    await user.click(within(dialog).getByRole('button', { name: '删除' }))

    expect(await screen.findByText(/对话服务暂不可用/)).toBeVisible()
    expect(dialog).toBeVisible()

    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: '删不掉的那段' })).toBeVisible()
  })

  it('标了完成又开跑：角标随开跑帧收掉，不等这一轮跑完', async () => {
    const [conversation] = seedConversations(1)
    const { socket, user } = await render()

    await user.click(await screen.findByRole('button', { name: '第0段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '标记完成' }))
    expect(await screen.findByLabelText('已完成')).toBeVisible()

    // 后端 touch_run 抹掉标记但不发帧，行上要照开跑与收尾互斥自己收掉。
    socket.deliver(workChanged(conversation?.id ?? '', { busy: true }))

    expect(await screen.findByLabelText('进行中')).toBeVisible()
    await waitFor(() => expect(screen.queryByLabelText('已完成')).not.toBeInTheDocument())
  })

  it('任务区：第一页 20 条，滚到列表末尾自动接上剩下的，接着归进同一个时间分组', async () => {
    seedConversations(21)
    const viewport = stubIntersectionObserver()
    await render()

    expect(await screen.findAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(20)
    expect(screen.queryByRole('button', { name: /更多任务/ })).not.toBeInTheDocument()

    await viewport.scroll(true)

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21))
    // 种子都在一个月前：后一页不另起一个「更早」标题。
    expect(screen.getAllByRole('group', { name: '更早' })).toHaveLength(1)
    expect(
      within(screen.getByRole('group', { name: '更早' })).getAllByRole('link', {
        name: /^第\d+段$/,
      }),
    ).toHaveLength(21)
  })

  it('任务区按建立时间插时间分组标题，顺序照服务端，空组不出现', async () => {
    const now = new Date()
    // 用本地日历日构造，避开跨零点与夏令时。
    const daysAgo = (days: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12).toISOString()
    addMockConversation('上个月的', daysAgo(40))
    addMockConversation('三天前的', daysAgo(3))
    addMockConversation('刚建的', now.toISOString())
    await render()

    await screen.findByRole('link', { name: '刚建的' })
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      '刚建的',
      '三天前的',
      '上个月的',
    ])
    const rowsIn = (name: string) =>
      within(screen.getByRole('group', { name }))
        .getAllByRole('link')
        .map((link) => link.textContent)
    expect(rowsIn('今天')).toEqual(['刚建的'])
    expect(rowsIn('7 天内')).toEqual(['三天前的'])
    expect(rowsIn('更早')).toEqual(['上个月的'])
    expect(screen.queryByRole('group', { name: '昨天' })).not.toBeInTheDocument()
  })

  it('合集收着不读分页；展开就把多页一并读全，换筛选后仍展开，分页按新档位读', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    seedConversations(25, collection.id).forEach(markBusy)
    const pageReads = countReads(`/api/conversations/by-collection/${collection.id}`)
    const pageStates: (string | null)[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === `/api/conversations/by-collection/${collection.id}`)
        pageStates.push(url.searchParams.get('state'))
    })
    const { user } = await render()

    const toggle = await screen.findByRole('button', { name: '夏季亚麻系列 (25)' })
    expect(pageReads.count).toBe(0)
    await user.click(toggle)

    // 第一页取自拓扑，后面两页各读一次。
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(25))
    expect(pageReads.count).toBe(2)
    expect(screen.queryByRole('button', { name: /更多任务/ })).not.toBeInTheDocument()

    await pickFilter(user, '运行中')
    expect(await screen.findByRole('button', { name: '夏季亚麻系列 (25)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(25))
    expect(pageStates.at(-1)).toBe('running')

    await pickFilter(user, '全部')
    expect(await screen.findByRole('button', { name: '夏季亚麻系列 (25)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(25)
  })

  it('合集收着时里面新建了一段：再展开就从头重拉已读的页，新的一段在里面', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    seedConversations(11, collection.id)
    const cursors: (string | null)[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === `/api/conversations/by-collection/${collection.id}`) {
        cursors.push(url.searchParams.get('cursor'))
      }
    })
    const { socket, user } = await render()

    await user.click(await screen.findByRole('button', { name: '夏季亚麻系列 (11)' }))
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(11))
    expect(cursors).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '夏季亚麻系列 (11)' }))

    const created = addMockConversation('合集里新建的')
    created.collectionId = collection.id
    socket.deliver({
      ...sessionEnvelope(created.id),
      type: 'event.session.created',
      session_id: created.id,
      payload: { ...created },
    })
    // 拓扑重拉后计数跟上；合集收着，分页不重拉。
    const toggle = await screen.findByRole('button', { name: '夏季亚麻系列 (12)' })
    expect(cursors).toHaveLength(1)
    await user.click(toggle)

    expect(await screen.findByRole('link', { name: '合集里新建的' })).toBeVisible()
    expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(11)
    expect(cursors.slice(1)).toEqual([null, expect.any(String)])
  })

  it('展开着的合集在收起合集列表、刷新页面之后仍展开', async () => {
    const entries = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
    })
    const collections = Array.from({ length: 4 }, (_, index) => addMockCollection(`合集${index}`))
    // 合集按建立时间倒序，最早建的那个排第四，默认收在「全部合集」里。
    const oldest = collections[0]
    if (oldest === undefined) throw new Error('没有合集')
    seedConversations(1, oldest.id)
    const { user } = await render()

    await user.click(await screen.findByRole('button', { name: '全部合集' }))
    await user.click(screen.getByRole('button', { name: '合集0 (1)' }))
    expect(await screen.findByRole('link', { name: '第0段' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '收起合集' }))
    await user.click(screen.getByRole('button', { name: '全部合集' }))
    expect(screen.getByRole('button', { name: '合集0 (1)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('link', { name: '第0段' })).toBeVisible()

    cleanup()
    const reloaded = await render()
    await reloaded.user.click(await screen.findByRole('button', { name: '全部合集' }))
    expect(screen.getByRole('button', { name: '合集0 (1)' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('link', { name: '第0段' })).toBeVisible()
  })

  it('合集默认只露前 3 个，「全部合集」展开全部，「收起合集」再收回 3 个', async () => {
    Array.from({ length: 5 }, (_, index) => addMockCollection(`合集${index}`))
    const { user } = await render()

    expect(await screen.findAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: '全部合集' }))

    expect(screen.getAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(5)
    expect(screen.queryByRole('button', { name: '全部合集' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '收起合集' }))

    expect(screen.getAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(3)
    expect(screen.getByRole('button', { name: '全部合集' })).toBeVisible()
  })

  it('合集不超过 3 个时不出「全部合集」', async () => {
    Array.from({ length: 3 }, (_, index) => addMockCollection(`合集${index}`))
    await render()

    expect(await screen.findAllByRole('button', { name: /^合集\d+ \(0\)$/ })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '全部合集' })).not.toBeInTheDocument()
  })

  it.each(['ungrouped', 'collection'])(
    '%s 分页失败保留已读内容，原位置重试后接上剩余对话',
    async (bucket) => {
      const collection = bucket === 'collection' ? addMockCollection('分页合集') : null
      const count = collection ? 11 : 21
      const rows = seedConversations(count, collection?.id)
      let failed = true
      server.use(
        http.get(
          collection
            ? `*/api/conversations/by-collection/${collection.id}`
            : '*/api/conversations/ungrouped',
          () =>
            failed
              ? HttpResponse.json({ detail: '下一页暂不可用' }, { status: 503 })
              : HttpResponse.json({ items: rows.slice(0, 1), nextCursor: null }),
        ),
      )
      stubIntersectionObserver({ inRange: true })
      const { user } = await render()
      if (collection)
        await user.click(
          await screen.findByRole('button', { name: `${collection.name} (${count})` }),
        )

      expect(await screen.findByRole('alert')).toHaveTextContent('下一页暂不可用')
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(count - 1)
      failed = false
      await user.click(screen.getByRole('button', { name: /^重新加载.*更多任务$/ }))

      await waitFor(() =>
        expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(count),
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /更多任务/ })).not.toBeInTheDocument()
    },
  )

  it.each(['ungrouped', 'collection'])(
    '%s 下一页与首页重叠时，每段对话只展示一次',
    async (bucket) => {
      const collection = bucket === 'collection' ? addMockCollection('分页合集') : null
      const count = collection ? 11 : 21
      const rows = seedConversations(count, collection?.id)
      server.use(
        http.get(
          collection
            ? `*/api/conversations/by-collection/${collection.id}`
            : '*/api/conversations/ungrouped',
          () => HttpResponse.json({ items: rows.slice(0, 2).reverse(), nextCursor: null }),
        ),
      )
      stubIntersectionObserver({ inRange: true })
      const { user } = await render()
      if (collection)
        await user.click(
          await screen.findByRole('button', { name: `${collection.name} (${count})` }),
        )

      await waitFor(() =>
        expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(count),
      )
      expect(screen.getAllByRole('link', { name: '第1段' })).toHaveLength(1)
      expect(screen.getByRole('link', { name: '第0段' })).toBeVisible()
    },
  )

  it('归属弹窗把对话移进合集后，侧栏跟着变，拓扑只重拉一次', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const [conversation] = seedConversations(1)
    let topologyReads = 0
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && new URL(request.url).pathname === '/api/conversations') {
        topologyReads += 1
      }
    })
    const { user } = await render()
    await screen.findByText('第0段')

    await user.click(screen.getByRole('button', { name: '第0段 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '移到合集…' }))
    const dialog = await screen.findByRole('dialog', { name: '任务归属' })
    await user.selectOptions(within(dialog).getByLabelText('合集'), collection.id)
    const readsBeforeSave = topologyReads
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(conversation?.collectionId).toBe(collection.id))
    expect(await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })).toBeVisible()
    // 合集收着，那一行离开任务区后侧栏上就看不到了。
    expect(screen.queryByRole('link', { name: '第0段' })).not.toBeInTheDocument()
    // 刷新只由归属 mutation 做一遍；路由的保存回调再刷一遍会取消在途重拉、多发一次请求。
    expect(topologyReads - readsBeforeSave).toBe(1)
  })

  it('服务端给对话起了名，侧栏那一行当场跟着改', async () => {
    const [conversation] = seedConversations(1)
    const { socket } = await render()
    await screen.findByText('第0段')

    socket.deliver({
      ...sessionEnvelope(conversation?.id ?? ''),
      type: 'session.meta.updated',
      payload: { session_id: conversation?.id ?? '', title: '夜景延时素材生成' },
    })

    expect(await screen.findByText('夜景延时素材生成')).toBeVisible()
    expect(screen.queryByText('第0段')).not.toBeInTheDocument()
  })

  it('行上带着出片在跑就画摄像机角标；视频帧到了重拉列表，跑完角标收掉，与轮次角标互不干扰', async () => {
    const [conversation] = seedConversations(1)
    const id = conversation?.id ?? ''
    if (conversation !== undefined) {
      conversation.activity = {
        busy: true,
        lastTurnReason: null,
        pendingInteraction: 'none',
        videoGeneration: 'queued',
      }
    }
    const { socket } = await render()
    expect(await screen.findByLabelText('视频排队中')).toBeVisible()
    expect(screen.getByLabelText('进行中')).toBeVisible()

    // 轮次帧只改轮次那几项，不把行上的出片状态冲掉；收场后的重拉也返回同一事实。
    if (conversation !== undefined) {
      conversation.activity = { ...conversation.activity, busy: false, lastTurnReason: 'completed' }
    }
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))
    await waitFor(() => expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument())
    expect(screen.getByLabelText('视频排队中')).toBeVisible()

    if (conversation !== undefined) conversation.activity.videoGeneration = 'running'
    socket.deliver({
      ...sessionEnvelope(id),
      type: 'event.generation.changed',
      session_id: id,
      payload: {
        id: crypto.randomUUID(),
        kind: 'video',
        operation: 'generate',
        status: 'submitted',
      },
    })
    expect(await screen.findByLabelText('视频生成中')).toBeVisible()

    if (conversation !== undefined) conversation.activity.videoGeneration = 'none'
    socket.deliver({
      ...sessionEnvelope(id),
      type: 'event.generation.changed',
      session_id: id,
      payload: {
        id: crypto.randomUUID(),
        kind: 'video',
        operation: 'generate',
        status: 'completed',
      },
    })
    await waitFor(() => expect(screen.queryByLabelText('视频生成中')).not.toBeInTheDocument())
  })

  it('服务端说这段对话跑起来了，那一行就转圈；跑完了转圈收掉', async () => {
    const [conversation] = seedConversations(1)
    const { socket } = await render()
    await screen.findByText('第0段')

    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()

    socket.deliver(workChanged(conversation?.id ?? '', { busy: true }))
    expect(await screen.findByLabelText('进行中')).toBeVisible()

    socket.deliver(workChanged(conversation?.id ?? '', { busy: false }))
    await waitFor(() => expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument())
  })

  it('行尾等人与失败直接写短词；悬停整行出提示条，按行尾顺序列出这一行的全部状态', async () => {
    const [waiting, busy] = seedConversations(2)
    if (waiting !== undefined) {
      waiting.activity = {
        busy: true,
        lastTurnReason: null,
        pendingInteraction: 'question',
        videoGeneration: 'none',
      }
    }
    if (busy !== undefined) {
      busy.activity = {
        busy: true,
        lastTurnReason: null,
        pendingInteraction: 'none',
        videoGeneration: 'running',
      }
    }
    const { user } = await render()

    expect(await screen.findByText('等待回答')).toBeVisible()
    expect(screen.getByRole('img', { name: '进行中' })).toBeVisible()
    expect(screen.getByRole('img', { name: '视频生成中' })).toBeVisible()

    await user.hover(screen.getByRole('link', { name: busy?.title ?? '' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('进行中 · 视频生成中')
    // jsdom 没有几何，移开时 Radix 的悬停宽限区收不起上一条提示，先按 Esc 关掉。
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    await user.hover(screen.getByRole('link', { name: waiting?.title ?? '' }))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/^等待回答$/))
  })

  it('行尾状态跟着帧上的活儿换：等待审批、上次失败，跑完了什么都不画', async () => {
    const [conversation] = seedConversations(1)
    const id = conversation?.id ?? ''
    const { socket } = await render()
    await screen.findByText('第0段')

    socket.deliver(workChanged(id, { busy: true, pending_interaction: 'approval' }))
    expect(await screen.findByText('等待审批')).toBeVisible()
    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()

    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'failed' }))
    expect(await screen.findByText('上次失败')).toBeVisible()

    // 同步更新 MSW 列表状态，使推送后的重拉返回一致事实。
    if (conversation !== undefined) {
      conversation.activity = {
        busy: false,
        lastTurnReason: 'completed',
        pendingInteraction: 'none',
        videoGeneration: 'none',
      }
    }
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))
    await waitFor(() => expect(screen.queryByText('上次失败')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('进行中')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('有新回复')).not.toBeInTheDocument()
  })

  it('从没打开过的对话不画未读点：行上带的 completed 与收场帧都不算', async () => {
    const done = addMockConversation('跑完了')
    done.lastRunId = 'run-1'
    done.activity = {
      busy: false,
      lastTurnReason: 'completed',
      pendingInteraction: 'none',
      videoGeneration: 'none',
    }
    const { socket } = await render()
    await screen.findByText('跑完了')

    expect(screen.queryByLabelText('有新回复')).not.toBeInTheDocument()

    socket.deliver(workChanged(done.id, { busy: false, last_turn_reason: 'completed' }))
    await waitFor(() => expect(screen.queryByLabelText('有新回复')).not.toBeInTheDocument())
  })

  it('看着它闲下来之后走开，它又跑完一次：那一行画点，打开就灭', async () => {
    const [conversation] = seedConversations(1)
    const id = conversation?.id ?? ''
    const { router, socket } = await render(`/c/${id}`)
    await screen.findByText('第0段')
    expect(screen.queryByLabelText('有新回复')).not.toBeInTheDocument()

    await act(() => router.navigate({ to: '/' }))
    // 离开后它又跑了一轮：开跑帧、带新 lastRunId 的 updated 帧，再是收场帧。
    socket.deliver(workChanged(id, { busy: true }))
    socket.deliver(runStarted(id, 'run-2'))
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))
    expect(await screen.findByLabelText('有新回复')).toBeVisible()

    await act(() => router.navigate({ params: { conversationId: id }, to: '/c/$conversationId' }))
    await waitFor(() => expect(screen.queryByLabelText('有新回复')).not.toBeInTheDocument())
  })

  it('打开着的对话在折叠的合集里、那一行没渲染出来，照样记得住：展开之后点在', async () => {
    const collection = addMockCollection('夏季亚麻系列')
    const [conversation] = seedConversations(1, collection.id)
    const id = conversation?.id ?? ''
    const { router, socket, user } = await render(`/c/${id}`)
    await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })
    expect(screen.queryByText('第0段')).not.toBeInTheDocument()

    await act(() => router.navigate({ to: '/' }))
    socket.deliver(workChanged(id, { busy: true }))
    socket.deliver(runStarted(id, 'run-2'))
    socket.deliver(workChanged(id, { busy: false, last_turn_reason: 'completed' }))

    await user.click(screen.getByRole('button', { name: '夏季亚麻系列 (1)' }))
    expect(await screen.findByText('第0段')).toBeVisible()
    expect(await screen.findByLabelText('有新回复')).toBeVisible()
  })

  it('另一个窗口新建的对话当场出现，删掉的当场消失', async () => {
    seedConversations(1)
    const { socket } = await render()
    await screen.findByText('第0段')

    const created = addMockConversation('另一个窗口建的')
    socket.deliver({
      ...sessionEnvelope(created.id),
      type: 'event.session.created',
      session_id: created.id,
      payload: { ...created },
    })
    expect(await screen.findByRole('link', { name: '另一个窗口建的' })).toBeVisible()

    // 服务端已落墓碑；帧一到行就从视图里消失，不等重拉。
    created.deletedAt = new Date().toISOString()
    socket.deliver({
      ...sessionEnvelope(created.id),
      type: 'event.session.deleted',
      session_id: created.id,
      payload: { session_id: created.id },
    })
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: '另一个窗口建的' })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('link', { name: '第0段' })).toBeVisible()
  })

  it('别人的对话跑完了：自己侧栏不重拉，已接上的分页也不收起', async () => {
    seedConversations(21)
    const theirs = addMockConversation('别人的', undefined, '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009')
    const reads = { topology: 0 }
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === '/api/conversations') reads.topology += 1
    })
    stubIntersectionObserver({ inRange: true })
    const { socket } = await render()
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21))
    const before = reads.topology

    socket.deliver(workFrame(theirs.id, { busy: false, last_turn_reason: 'completed' }))
    socket.deliver({
      ...sessionEnvelope(theirs.id),
      type: 'event.generation.changed',
      session_id: theirs.id,
      payload: {
        id: crypto.randomUUID(),
        kind: 'video',
        operation: 'generate',
        status: 'submitted',
      },
    })
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(reads.topology).toBe(before)
    expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21)
  })

  it('滚动接上来的那一行收到帧也跟着转圈', async () => {
    const rows = seedConversations(21)
    stubIntersectionObserver({ inRange: true })
    const { socket } = await render()

    await waitFor(() => expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(21))

    // 最旧对话位于滚动接上的第二页。
    socket.deliver(workChanged(rows[0]?.id ?? '', { busy: true }))

    expect(await screen.findByLabelText('进行中')).toBeVisible()
  })

  it('筛「已完成」时把一段取消完成，重拉之后它不在这一档里了', async () => {
    const conversation = addMockConversation('收尾了')
    conversation.completedAt = new Date().toISOString()
    const { user } = await render()

    await pickFilter(user, '已完成')
    expect(await screen.findByRole('link', { name: '收尾了' })).toBeVisible()

    await user.click(await screen.findByRole('button', { name: '收尾了 的更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '取消完成' }))

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: '收尾了' })).not.toBeInTheDocument(),
    )
    expect(conversation.completedAt).toBeNull()
  })

  describe('已接上的分页在列表刷新后不收起', () => {
    it('「全部」下只换了收尾标记：不重拉任务区，行原样留着', async () => {
      const { rows, socket } = await renderWithAllPagesLoaded()
      const listReads = countReads('/api/conversations/ungrouped')
      const topologyReads = countReads('/api/conversations')
      const tail = rows[0]
      if (tail === undefined) throw new Error('没有对话')

      tail.completedAt = new Date().toISOString()
      socket.deliver(rowUpdated(tail))
      expect(await screen.findByLabelText('已完成')).toBeVisible()
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

      expect(listReads.count).toBe(0)
      expect(topologyReads.count).toBe(0)
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(50)
    })

    it('别处新建了一段：三页原位从头重拉，重拉期间行都在，原第一页末行挪到第二页仍可见', async () => {
      const { socket } = await renderWithAllPagesLoaded()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const cursors: (string | null)[] = []
      // 不返回响应就落到默认 handler：先记下、挂住，放行后照常分页。
      server.use(
        http.get('*/api/conversations/ungrouped', async ({ request }) => {
          cursors.push(new URL(request.url).searchParams.get('cursor'))
          await gate
        }),
      )

      const created = addMockConversation('另一个窗口建的')
      socket.deliver({
        ...sessionEnvelope(created.id),
        type: 'event.session.created',
        session_id: created.id,
        payload: { ...created },
      })

      await waitFor(() => expect(cursors).toHaveLength(1))
      // 从头读：第一页不带游标。
      expect(cursors[0]).toBeNull()
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(50)
      expect(screen.getByRole('link', { name: '第30段' })).toBeVisible()

      release()
      expect(await screen.findByRole('link', { name: '另一个窗口建的' })).toBeVisible()
      expect(cursors).toHaveLength(3)
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(50)
      expect(screen.getByRole('link', { name: '第30段' })).toBeVisible()
    })

    it('接上来的一行被移进合集：重拉之后它离开任务区，其余行都在', async () => {
      const collection = addMockCollection('夏季亚麻系列')
      const { rows, socket } = await renderWithAllPagesLoaded()
      const tail = rows[0]
      if (tail === undefined) throw new Error('没有对话')

      tail.collectionId = collection.id
      socket.deliver(rowUpdated(tail))

      await waitFor(() =>
        expect(screen.queryByRole('link', { name: '第0段' })).not.toBeInTheDocument(),
      )
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(49)
      expect(await screen.findByRole('button', { name: '夏季亚麻系列 (1)' })).toBeVisible()
    })

    it('断线重连：任务区原位重拉三页，行都在', async () => {
      const { socket } = await renderWithAllPagesLoaded()
      const listReads = countReads('/api/conversations/ungrouped')
      const handshake = socket.onmessage

      socket.onclose?.()
      // 断开时摘掉旧回调，退避约一秒后重新连上、换上新的消息回调，再回服务端招呼。
      await waitFor(
        () => {
          expect(socket.onmessage).not.toBeNull()
          expect(socket.onmessage).not.toBe(handshake)
        },
        { timeout: 3000 },
      )
      socket.deliver(SERVER_HELLO)

      await waitFor(() => expect(listReads.count).toBe(3))
      await waitFor(() =>
        expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(50),
      )
    }, 10_000)

    it('筛「运行中」时接上来的一段跑完了：重拉之后它离开这一档，其余行都在', async () => {
      const rows = seedConversations(25)
      rows.forEach(markBusy)
      const ungroupedStates: (string | null)[] = []
      server.events.on('request:start', ({ request }) => {
        const url = new URL(request.url)
        if (url.pathname === '/api/conversations/ungrouped')
          ungroupedStates.push(url.searchParams.get('state'))
      })
      const viewport = stubIntersectionObserver({ inRange: true })
      const { socket, user } = await render()
      await pickFilter(user, '运行中')
      await waitFor(() =>
        expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(25),
      )
      // 任务区第二页按当前档位读。
      expect(ungroupedStates.at(-1)).toBe('running')
      // 滚离列表末尾：之后列表只能靠重拉保住第二页，不会再自动接上。
      await viewport.scroll(false)
      const tail = rows[0]
      if (tail === undefined) throw new Error('没有对话')

      socket.deliver(workChanged(tail.id, { busy: false, last_turn_reason: 'completed' }))

      await waitFor(() =>
        expect(screen.queryByRole('link', { name: '第0段' })).not.toBeInTheDocument(),
      )
      expect(screen.getAllByRole('link', { name: /^第\d+段$/ })).toHaveLength(24)
    })
  })
})

describe('侧栏原位编辑', () => {
  type User = ReturnType<typeof userEvent.setup>

  /** 记下改名与新建合集的请求，断言发了什么、有没有发。 */
  const recordWrites = () => {
    const writes: { body: unknown; method: string; path: string }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (request.method !== 'PATCH' && request.method !== 'POST') return
      const path = new URL(request.url).pathname
      if (!/^\/api\/(conversations\/[^/]+|collections(\/[^/]+)?)$/.test(path)) return
      writes.push({ body: await request.clone().json(), method: request.method, path })
    })
    return writes
  }

  const startRename = async (user: User, title: string) => {
    await user.click(await screen.findByRole('button', { name: `${title} 的更多操作` }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    return screen.findByRole('textbox', { name: `重命名 ${title}` })
  }

  it('对话改名：进入时聚焦并全选原名，输入即替换，回车保存后行回到链接并接回焦点', async () => {
    const conversation = addMockConversation('春季鞋款分镜')
    const writes = recordWrites()
    const { user } = await render()

    const input = await startRename(user, '春季鞋款分镜')
    expect(input).toHaveFocus()
    expect(input).toHaveValue('春季鞋款分镜')
    expect([
      (input as HTMLInputElement).selectionStart,
      (input as HTMLInputElement).selectionEnd,
    ]).toEqual([0, '春季鞋款分镜'.length])
    await user.keyboard('  夏季凉鞋分镜 {Enter}')

    expect(await screen.findByRole('link', { name: '夏季凉鞋分镜' })).toHaveFocus()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(writes).toEqual([
      {
        body: { title: '夏季凉鞋分镜' },
        method: 'PATCH',
        path: `/api/conversations/${conversation.id}`,
      },
    ])
  })

  it('对话改名：点到别处失焦也保存', async () => {
    addMockConversation('春季鞋款分镜')
    const writes = recordWrites()
    const { user } = await render()

    await startRename(user, '春季鞋款分镜')
    await user.keyboard('秋季短靴')
    await user.click(screen.getByRole('heading', { name: '任务' }))

    // 焦点是用户自己移走的，保存完不抢回标题链接。
    expect(await screen.findByRole('link', { name: '秋季短靴' })).toBeVisible()
    expect(screen.getByRole('link', { name: '秋季短靴' })).not.toHaveFocus()
    expect(writes).toHaveLength(1)
  })

  it('对话改名：点在编辑行里输入框以外的地方，仍在编辑、不保存', async () => {
    addMockConversation('春季鞋款分镜')
    const writes = recordWrites()
    const { user } = await render()

    const input = await startRename(user, '春季鞋款分镜')
    await user.keyboard('秋季短靴')
    // 输入框只有一行字高，编辑行的上下留白属于同一块输入面。
    const surface = input.parentElement
    if (!surface) throw new Error('编辑行缺少外层输入面')
    await user.click(surface)

    expect(input).toHaveFocus()
    expect(input).toHaveValue('秋季短靴')
    expect(writes).toEqual([])
  })

  it.each([
    { case: 'Esc 放弃已输入的新名', keys: '秋季短靴{Escape}' },
    { case: '清空后回车', keys: '{Backspace}{Enter}' },
    { case: '只输入空白后回车', keys: '   {Enter}' },
    { case: '名字没变直接回车', keys: '{Enter}' },
  ])('对话改名：$case，退出编辑、不发请求、原名不变，焦点回到标题链接', async ({ keys }) => {
    addMockConversation('春季鞋款分镜')
    const writes = recordWrites()
    const { user } = await render()

    await startRename(user, '春季鞋款分镜')
    await user.keyboard(keys)

    expect(await screen.findByRole('link', { name: '春季鞋款分镜' })).toHaveFocus()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(writes).toEqual([])
  })

  it('对话改名失败：留在编辑态并说明原因，回车重试成功后退出', async () => {
    addMockConversation('春季鞋款分镜')
    server.use(
      http.patch(
        '*/api/conversations/:conversationId',
        () => HttpResponse.json({ detail: '对话服务暂不可用' }, { status: 503 }),
        { once: true },
      ),
    )
    renderDom(<Toaster />)
    const writes = recordWrites()
    const { user } = await render()

    await startRename(user, '春季鞋款分镜')
    await user.keyboard('秋季短靴{Enter}')

    const input = screen.getByRole('textbox', { name: '重命名 春季鞋款分镜' })
    await waitFor(() => expect(input).toBeInvalid())
    expect(input).toHaveValue('秋季短靴')
    expect(input).toHaveFocus()
    expect(input).toHaveAccessibleDescription(/对话服务暂不可用/)
    // 行下说明之外，toast 也报出原因。
    expect(screen.getAllByText(/对话服务暂不可用/).length).toBeGreaterThan(1)

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('link', { name: '秋季短靴' })).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(writes).toHaveLength(2)
  })

  it('对话改名失败后 Esc 放弃：退出编辑，保留原名', async () => {
    addMockConversation('春季鞋款分镜')
    server.use(
      http.patch('*/api/conversations/:conversationId', () =>
        HttpResponse.json({ detail: '对话服务暂不可用' }, { status: 503 }),
      ),
    )
    const { user } = await render()

    await startRename(user, '春季鞋款分镜')
    await user.keyboard('秋季短靴{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: '重命名 春季鞋款分镜' })).toBeInvalid(),
    )
    await user.keyboard('{Escape}')

    expect(await screen.findByRole('link', { name: '春季鞋款分镜' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    { case: 'Esc', keys: '秋季{Escape}' },
    { case: '空名回车', keys: '{Enter}' },
  ])('新建合集的编辑行：$case 时撤掉这一行，不发请求，焦点回到「+」', async ({ keys }) => {
    const writes = recordWrites()
    const { user } = await render()
    await screen.findByText('暂无合集')

    await user.click(screen.getByRole('button', { name: '新建合集' }))
    expect(screen.getByRole('textbox', { name: '新合集名称' })).toHaveFocus()
    await user.keyboard(keys)

    expect(screen.queryByRole('textbox', { name: '新合集名称' })).not.toBeInTheDocument()
    expect(screen.getByText('暂无合集')).toBeVisible()
    expect(screen.getByRole('button', { name: '新建合集' })).toHaveFocus()
    expect(writes).toEqual([])
  })

  it('新建合集失败：编辑行留着并说明原因，回车重试后建成', async () => {
    server.use(
      http.post(
        '*/api/collections',
        () => HttpResponse.json({ detail: '合集服务暂不可用' }, { status: 503 }),
        { once: true },
      ),
    )
    const { user } = await render()
    await screen.findByText('暂无合集')

    await user.click(screen.getByRole('button', { name: '新建合集' }))
    await user.keyboard('春季童鞋{Enter}')

    const draft = screen.getByRole('textbox', { name: '新合集名称' })
    await waitFor(() => expect(draft).toBeInvalid())
    expect(screen.getByRole('alert')).toHaveTextContent('合集服务暂不可用')
    expect(mockCollections).toHaveLength(0)

    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: '春季童鞋 (0)' })).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

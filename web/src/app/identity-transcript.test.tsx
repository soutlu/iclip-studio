import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeTree } from '@/routeTree.gen'
import { queryClient } from '@/shared/api/query-client'
import { refreshSessionUser } from '@/shared/auth'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { WorkbenchOpenRequestProvider, WorkbenchRegistryProvider } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { FakeTranscriptServer, type SeedStream } from '@/testing/transcript-server'
import { IdentityTranscriptProvider } from './identity-transcript'
import { workbenchRegistry } from './workbench-registry'

type Account = typeof mockAuthUser

const accountA: Account = { ...mockAuthUser, displayName: '账号甲', username: 'account-a' }
const accountB: Account = {
  ...mockAuthUser,
  displayName: '账号乙',
  id: '22222222-2222-4222-8222-222222222222',
  username: 'account-b',
}

const CONVERSATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONVERSATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWNERS: Record<string, string> = {
  [CONVERSATION_A]: accountA.id,
  [CONVERSATION_B]: accountB.id,
}

/** 只有一句回复的一轮历史。 */
const turnSaying = (text: string) =>
  [
    {
      content: [{ text: '问一句', type: 'text' }],
      kind: 'turn',
      ordinal: 1,
      origin: { kind: 'user' },
      state: 'completed',
      steps: [
        {
          frames: [{ frameId: 't1.1.f1', kind: 'text', role: 'assistant', text }],
          kind: 'step',
          ordinal: 1,
          state: 'completed',
          stepId: 't1.1',
          turnId: 't1',
        },
      ],
      turnId: 't1',
    },
  ] as unknown as SeedStream['items']

/**
 * MSW 持有服务端会话：登录接口按用户名认甲乙，退出清掉。transcript 由假服务端按身份核可见性，
 * REST 页按请求时的身份，订阅按连接握手时的身份；甲乙各自只看得见自己的那段对话。
 */
const serveAccounts = (initial: Account | null) => {
  let current = initial
  const fake = new FakeTranscriptServer({
    access: {
      canView: (viewer, conversationId) => viewer !== null && OWNERS[conversationId] === viewer,
      viewer: () => current?.id ?? null,
    },
  })
  fake.seed(CONVERSATION_A, 'main', { items: turnSaying('甲的私密内容'), title: '甲的对话' })
  fake.seed(CONVERSATION_B, 'main', { items: turnSaying('乙自己的内容'), title: '乙的对话' })
  server.use(
    ...fake.handlers(),
    http.get('*/api/users/me', () =>
      current
        ? HttpResponse.json({ user: current })
        : HttpResponse.json({ detail: '未登录' }, { status: 401 }),
    ),
    http.post('*/api/auth/login', async ({ request }) => {
      const form = new URLSearchParams(await request.text())
      current = form.get('username') === accountA.username ? accountA : accountB
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('*/api/auth/logout', () => {
      current = null
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return {
    fake,
    pageReads: (conversationId: string) =>
      fake.pageRequests.filter((request) => request.conversationId === conversationId).length,
    switchTo: (account: Account) => {
      current = account
    },
  }
}

/** 照 App 的 Provider 顺序装配，只把路由换成内存历史、订阅连接换成假服务端。 */
const renderApp = async (fake: FakeTranscriptServer, initialPath: string) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree,
  })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <IdentityTranscriptProvider createSocket={fake.createSocket}>
        <WorkbenchRegistryProvider registry={workbenchRegistry}>
          <WorkbenchOpenRequestProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </WorkbenchOpenRequestProvider>
        </WorkbenchRegistryProvider>
      </IdentityTranscriptProvider>
    </QueryClientProvider>,
  )
  return { router, user: userEvent.setup() }
}

type User = ReturnType<typeof userEvent.setup>

const logout = async (user: User) => {
  await user.click(await screen.findByRole('button', { name: '用户菜单' }))
  await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))
}

/** 在已经打开或由侧栏打开的登录弹窗里用账号密码登录，等弹窗关上。 */
const loginInDialog = async (user: User, account: Account) => {
  const dialog = await screen.findByRole('dialog', { name: /登录 Cue/ })
  await user.type(within(dialog).getByRole('textbox', { name: '用户名' }), account.username)
  await user.type(within(dialog).getByLabelText('密码'), 'test-password')
  await user.click(within(dialog).getByRole('button', { name: '登录' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: /登录 Cue/ })).not.toBeInTheDocument(),
  )
}

/** 让假服务端排在宏任务里的帧（握手、回执）都送到并处理完。 */
const flushNetwork = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

const subscribedTo = (received: readonly { type?: string; payload?: { session_id?: string } }[]) =>
  received.flatMap((frame) =>
    frame.type === 'subscribe_v2' && frame.payload?.session_id !== undefined
      ? [frame.payload.session_id]
      : [],
  )

/** 服务端给某段对话改了名：全局帧发给此刻开着的每条连接。 */
const announceTitle = (fake: FakeTranscriptServer, conversationId: string, title: string) => {
  fake.broadcast({
    epoch: 'event-epoch',
    owner_user_id: OWNERS[conversationId],
    payload: { session_id: conversationId, title },
    seq: 1,
    type: 'session.meta.updated',
  })
}

// 单例 queryClient 带着登录缓存，游客草稿暂存在 sessionStorage，窄屏用例改了视口宽度，每例都还原。
afterEach(() => {
  queryClient.clear()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('换了登录身份时订阅连接与 transcript 状态按身份换代，界面树不动', () => {
  it('甲退出、乙登录：甲读过的对话按乙重新读、显示读不到；乙自己的对话订阅在乙握手的连接上', async () => {
    const accounts = serveAccounts(accountA)
    const { router, user } = await renderApp(accounts.fake, `/c/${CONVERSATION_A}`)
    await waitFor(() => expect(screen.getByText('甲的私密内容')).toBeVisible())
    expect(accounts.pageReads(CONVERSATION_A)).toBe(1)

    await logout(user)
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    await user.click(await screen.findByRole('button', { name: '登录' }))
    await loginInDialog(user, accountB)
    expect(router.state.location.pathname).toBe('/')

    await act(() =>
      router.navigate({ params: { conversationId: CONVERSATION_A }, to: '/c/$conversationId' }),
    )
    await waitFor(() => expect(screen.getByText('这段对话不存在，或者不是你的')).toBeVisible())
    expect(screen.queryByText('甲的私密内容')).not.toBeInTheDocument()
    expect(accounts.pageReads(CONVERSATION_A)).toBe(2)

    await act(() =>
      router.navigate({ params: { conversationId: CONVERSATION_B }, to: '/c/$conversationId' }),
    )
    await waitFor(() => expect(screen.getByText('乙自己的内容')).toBeVisible())
    await waitFor(() =>
      expect(subscribedTo(accounts.fake.connections().at(-1)?.received ?? [])).toContain(
        CONVERSATION_B,
      ),
    )
    await flushNetwork()
    // 订阅回执回来之后仍是乙的对话，没有按甲的握手身份被判看不见。
    expect(screen.getByText('乙自己的内容')).toBeVisible()
    expect(screen.queryByText('这段对话不存在，或者不是你的')).not.toBeInTheDocument()

    // 甲握手的、退出后的游客、乙登录后的，各一条；前两条已关。
    const connections = accounts.fake.connections()
    expect(connections.map(({ open, viewer }) => ({ open, viewer }))).toEqual([
      { open: false, viewer: accountA.id },
      { open: false, viewer: null },
      { open: true, viewer: accountB.id },
    ])
    expect(subscribedTo(connections[0]?.received ?? [])).toEqual([CONVERSATION_A])
    expect(subscribedTo(connections[2]?.received ?? [])).toEqual([CONVERSATION_B])
  })

  it('首次探测出身份不算换人：打开页面只建一条连接', async () => {
    const accounts = serveAccounts(accountA)
    await renderApp(accounts.fake, '/')
    await screen.findByRole('button', { name: '用户菜单' })
    await flushNetwork()

    expect(accounts.fake.connections().map(({ open, viewer }) => ({ open, viewer }))).toEqual([
      { open: true, viewer: accountA.id },
    ])
  })

  it('接口复核发现已换成乙时人留在甲的对话页：正文与甲那边收到的改名都不再显示，页面原地换成读不到', async () => {
    const accounts = serveAccounts(accountA)
    await renderApp(accounts.fake, `/c/${CONVERSATION_A}`)
    await waitFor(() => expect(screen.getByText('甲的私密内容')).toBeVisible())
    announceTitle(accounts.fake, CONVERSATION_A, '甲改过的名字')
    await waitFor(() => expect(screen.getByRole('heading', { name: '甲改过的名字' })).toBeVisible())
    const main = screen.getByRole('main')
    accounts.switchTo(accountB)

    await act(async () => {
      await refreshSessionUser()
    })

    await waitFor(() => expect(screen.getByText('这段对话不存在，或者不是你的')).toBeVisible())
    expect(screen.queryByText('甲的私密内容')).not.toBeInTheDocument()
    expect(screen.queryByText('甲改过的名字')).not.toBeInTheDocument()
    // 换的是连接与读取状态，应用壳与页面没有重新挂载。
    expect(screen.getByRole('main')).toBe(main)
    await flushNetwork()
    expect(accounts.fake.connections().map(({ open, viewer }) => ({ open, viewer }))).toEqual([
      { open: false, viewer: accountA.id },
      { open: true, viewer: accountB.id },
    ])
  })

  it('游客写好的草稿点发送后登录：登录之后输入框里还是那段话，人留在首页', async () => {
    const accounts = serveAccounts(null)
    const { router, user } = await renderApp(accounts.fake, '/')
    const editor = await screen.findByLabelText('输入消息')
    pasteTextIntoComposer(editor, '春季新款的分镜脚本')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await loginInDialog(user, accountB)

    await waitFor(() =>
      expect(screen.getByLabelText('输入消息')).toHaveTextContent('春季新款的分镜脚本'),
    )
    expect(router.state.location.pathname).toBe('/')
    expect(accounts.fake.connections().at(-1)?.viewer).toBe(accountB.id)
  })

  it('窄屏展开侧栏后在侧栏里登录：登录完侧栏仍然展开，连接换成乙握手的', async () => {
    vi.stubGlobal('innerWidth', 390)
    const accounts = serveAccounts(null)
    const { user } = await renderApp(accounts.fake, '/')
    await user.click(await screen.findByRole('button', { name: '展开侧边栏' }))
    const sidebar = screen.getByRole('complementary', { name: '侧边栏' })
    await user.click(within(sidebar).getByRole('button', { name: '登录' }))

    await loginInDialog(user, accountB)

    await waitFor(() =>
      expect(within(sidebar).getByRole('button', { name: '用户菜单' })).toBeVisible(),
    )
    expect(screen.getByRole('complementary', { name: '侧边栏' })).toBe(sidebar)
    expect(within(sidebar).getByRole('button', { name: '折叠侧边栏' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '展开侧边栏' })).not.toBeInTheDocument()
    expect(accounts.fake.connections().at(-1)?.viewer).toBe(accountB.id)
  })
})

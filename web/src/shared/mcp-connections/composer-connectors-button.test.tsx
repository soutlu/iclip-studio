import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@/shared/ui/composer'
import { Toaster, toast } from '@/shared/ui/toast'
import { setMockMcpConnections } from '@/testing/mocks/mcp-connections'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ComposerConnectorsButton } from './composer-connectors-button'
import type { McpConnectionsScope } from './mcp-connections.api'
import { announceSignInResult, recallSignIn } from './sign-in-handoff'

type State = 'connected' | 'invalid' | 'none'

const ALL_SERVICES = ['pickfu', 'feishu-docs', 'brand-assets']

const connection = (serverId: string, name: string, state: State, account: string | null) => ({
  account,
  connectedAt: state === 'none' ? null : '2026-11-09T08:00:00Z',
  description: '',
  name,
  scopes: null,
  serverId,
  state,
})

const serveConnections = (items: ReturnType<typeof connection>[]) =>
  server.use(http.get('*/api/mcp-connections', () => HttpResponse.json({ items })))

/** 记下已经答复的连接列表请求，好在「读完了」之后再断言按钮有没有。 */
const recordListReads = () => {
  const reads: URL[] = []
  server.events.on('response:mocked', ({ request }) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/mcp-connections') reads.push(url)
  })
  return reads
}

const renderComposer = async ({
  attachments = true,
  scope = { agentId: 'replica' },
}: { attachments?: boolean; scope?: McpConnectionsScope } = {}) => {
  const rendered = await renderWithProviders(
    <>
      <Toaster />
      <Composer
        attachmentsEnabled={attachments}
        leading={<ComposerConnectorsButton scope={scope} />}
        onSubmit={vi.fn()}
      />
    </>,
  )
  return { ...rendered, user: userEvent.setup() }
}

const connectorButton = () => screen.findByRole('button', { name: /^连接器/ })

const openConnectors = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await connectorButton())
  return screen.findByRole('menu')
}

const connectPickFu = async (user: ReturnType<typeof userEvent.setup>) => {
  const menu = await openConnectors(user)
  await user.click(within(menu).getByRole('menuitem', { name: '连接 PickFu' }))
}

type FakeWindow = {
  closed: boolean
  close: () => void
  focus: () => void
  location: { href: string }
}

const stubWindowOpen = () => {
  const windows: FakeWindow[] = []
  const open = vi.spyOn(window, 'open').mockImplementation(() => {
    const popup: FakeWindow = {
      close: vi.fn(() => {
        popup.closed = true
      }),
      closed: false,
      focus: vi.fn(),
      location: { href: 'about:blank' },
    }
    windows.push(popup)
    return popup as unknown as Window
  })
  return { open, windows }
}

/** 等被关掉的 Toast 走完退场并卸载，留下的才是用户接着看到的。 */
const settleToasts = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })

afterEach(() => {
  toast.dismiss()
})

describe('连接器按钮', () => {
  it('当前 Agent 没有使用自有账户的服务时没有连接器按钮，「+」直接打开文件选择', async () => {
    setMockMcpConnections({ agents: { replica: [] } })
    const reads = recordListReads()
    const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { user } = await renderComposer()
    await waitFor(() => expect(reads).toHaveLength(1))
    await act(async () => {})

    expect(screen.queryByRole('button', { name: /^连接器/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加附件' }))
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick.mock.contexts[0]).toHaveProperty('type', 'file')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('连接读取中或读取失败时都没有连接器按钮', async () => {
    let fail = false
    server.use(
      http.get('*/api/mcp-connections', async () => {
        if (fail) return HttpResponse.json({ detail: '出错了' }, { status: 500 })
        await delay('infinite')
        return HttpResponse.json({ items: [] })
      }),
    )
    const pending = await renderComposer()
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /^连接器/ })).not.toBeInTheDocument()
    pending.unmount()

    fail = true
    const reads = recordListReads()
    await renderComposer()
    await waitFor(() => expect(reads).toHaveLength(1))
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /^连接器/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加附件' })).toBeInTheDocument()
  })

  it('按对话问到 404（不是我能发消息的对话）时没有连接器按钮', async () => {
    setMockMcpConnections({ agents: { replica: ALL_SERVICES } })
    const reads = recordListReads()
    const conversationId = crypto.randomUUID()
    await renderComposer({ scope: { conversationId } })
    await waitFor(() => expect(reads).toHaveLength(1))
    await act(async () => {})

    expect(reads[0]?.search).toBe(`?conversationId=${conversationId}`)
    expect(screen.queryByRole('button', { name: /^连接器/ })).not.toBeInTheDocument()
  })

  it('点开向上列出每个服务：图标、名称、我的连接状态与一个操作，没有别的项', async () => {
    serveConnections([
      connection('pickfu', 'PickFu', 'none', null),
      connection('brand-assets', '品牌资产库', 'connected', 'demo@example.com'),
      connection('feishu-docs', '飞书文档', 'connected', null),
      connection('notion', 'Notion', 'invalid', 'demo@example.com'),
    ])
    const { user } = await renderComposer()
    const menu = await openConnectors(user)

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['连接 PickFu', '断开 品牌资产库', '断开 飞书文档', '重新连接 Notion'])
    expect(menu).toHaveTextContent(
      'PickFu未连接连接' +
        '品牌资产库demo@example.com已连接断开' +
        '飞书文档已连接断开' +
        'Notion连接已失效重新连接',
    )
    expect(within(menu).queryByRole('heading')).not.toBeInTheDocument()
  })

  it('有服务连接已失效时按钮名称说明这一点；只是未连接不提示', async () => {
    serveConnections([
      connection('pickfu', 'PickFu', 'none', null),
      connection('brand-assets', '品牌资产库', 'connected', 'demo@example.com'),
    ])
    const first = await renderComposer()
    expect(await connectorButton()).toHaveAccessibleName('连接器')
    first.unmount()

    serveConnections([
      connection('pickfu', 'PickFu', 'invalid', null),
      connection('brand-assets', '品牌资产库', 'connected', 'demo@example.com'),
    ])
    await renderComposer()
    expect(await connectorButton()).toHaveAccessibleName('连接器，有连接已失效')
  })

  it('悬停提示「连接器」，点开列表后提示收起，不压在列表上', async () => {
    serveConnections([connection('pickfu', 'PickFu', 'none', null)])
    const { user } = await renderComposer()
    const button = await connectorButton()

    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('连接器')
    await user.click(button)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    // 列表开着时指针仍停在按钮上，提示不能因为指针在按钮上移动而重新出现。
    fireEvent.pointerLeave(button)
    fireEvent.pointerMove(button)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument()
  })

  it('键盘：Tab 到按钮，Enter 打开并落在第一个操作上，方向键换操作、Enter 执行，Esc 关闭后焦点回到按钮', async () => {
    setMockMcpConnections({
      agents: { replica: ALL_SERVICES },
      users: { tester: { 'brand-assets': { account: 'demo@example.com', state: 'connected' } } },
    })
    const disconnected: string[] = []
    server.events.on('response:mocked', ({ request }) => {
      if (request.method === 'DELETE') disconnected.push(new URL(request.url).pathname)
    })
    const { user } = await renderComposer({ attachments: false })
    const button = await connectorButton()

    await user.click(screen.getByLabelText('输入消息'))
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '连接 PickFu' })).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: '断开 品牌资产库' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(disconnected).toEqual(['/api/mcp-connections/brand-assets']))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
  })
})

describe('连接与断开', () => {
  it('连接：点击时先同步开窗口，再要连接地址并把窗口转过去；重开列表显示连接中，「取消」关窗口并留在列表里', async () => {
    setMockMcpConnections({ agents: { replica: ['pickfu'] } })
    const authorized: string[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/mcp-connections/:serverId/authorize', async ({ params }) => {
        authorized.push(String(params['serverId']))
        await gate
        return HttpResponse.json({
          authorizationUrl: 'https://auth.example/authorize?state=s-pickfu&client_id=iclip',
        })
      }),
    )
    const { open, windows } = stubWindowOpen()
    const { user } = await renderComposer()

    await connectPickFu(user)
    expect(open).toHaveBeenCalledTimes(1)
    expect(windows[0]?.location.href).toBe('about:blank')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(authorized).toEqual(['pickfu']))

    release()
    await waitFor(() =>
      expect(windows[0]?.location.href).toBe(
        'https://auth.example/authorize?state=s-pickfu&client_id=iclip',
      ),
    )
    expect(recallSignIn('s-pickfu')).toMatchObject({ name: 'PickFu', serverId: 'pickfu' })

    const menu = await openConnectors(user)
    expect(within(menu).getByText('正在连接，请在新窗口中完成')).toBeVisible()
    await user.click(within(menu).getByRole('menuitem', { name: '取消连接 PickFu' }))
    expect(windows[0]?.close).toHaveBeenCalledTimes(1)
    expect(within(menu).getByRole('menuitem', { name: '连接 PickFu' })).toBeInTheDocument()
    expect(within(menu).getByText('未连接')).toBeVisible()
  })

  it('回调页报告连接成功：重读连接并提示「X 已连接」', async () => {
    setMockMcpConnections({ agents: { replica: ['pickfu'] } })
    const reads = recordListReads()
    const { windows } = stubWindowOpen()
    const { user } = await renderComposer()

    await connectPickFu(user)
    await waitFor(() => expect(windows[0]?.location.href).toContain('/mcp/callback?state='))
    const state = new URL(windows[0]?.location.href ?? '').searchParams.get('state') ?? ''
    const pending = recallSignIn(state)
    expect(pending).toMatchObject({ name: 'PickFu', serverId: 'pickfu' })
    const readsBefore = reads.length

    setMockMcpConnections({
      agents: { replica: ['pickfu'] },
      users: { tester: { pickfu: { account: 'demo@example.com', state: 'connected' } } },
    })
    announceSignInResult({
      name: 'PickFu',
      ok: true,
      serverId: 'pickfu',
      tabId: pending?.tabId ?? null,
    })

    expect(await screen.findByText('PickFu 已连接')).toBeVisible()
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore))
    const menu = await openConnectors(user)
    expect(within(menu).getByText('demo@example.com')).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: '断开 PickFu' })).toBeInTheDocument()
    expect(within(menu).queryByText('正在连接，请在新窗口中完成')).not.toBeInTheDocument()
  })

  it.each([
    ['mcp_client_required', 'PickFu 尚未配置完成，无法连接；请联系管理员'],
    ['mcp_callback_unconfigured', 'PickFu 尚未配置完成，无法连接；请联系管理员'],
    ['mcp_oauth_unsupported', 'PickFu 尚未配置完成，无法连接；请联系管理员'],
    ['mcp_oauth_unavailable', 'PickFu 连接失败，请重试'],
  ])(
    '要连接地址失败（%s）：关掉窗口，留一条带「重试」的错误提示；重试再失败仍有提示',
    async (code, message) => {
      setMockMcpConnections({ agents: { replica: ['pickfu'] } })
      server.use(
        http.post('*/api/mcp-connections/:serverId/authorize', () =>
          HttpResponse.json({ code, detail: '服务端原因' }, { status: 409 }),
        ),
      )
      const { open, windows } = stubWindowOpen()
      const { user } = await renderComposer()

      await connectPickFu(user)
      expect(await screen.findByText(message)).toBeVisible()
      expect(windows[0]?.close).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('服务端原因')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: '重试' }))
      expect(open).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(windows[1]?.close).toHaveBeenCalledTimes(1))
      await settleToasts()
      expect(screen.getByText(message)).toBeVisible()
    },
  )

  it('浏览器拦截新窗口：不要连接地址，错误提示常驻并可重试；重试仍被拦截时提示还在', async () => {
    setMockMcpConnections({ agents: { replica: ['pickfu'] } })
    const authorized: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/authorize')) authorized.push(request.url)
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { user } = await renderComposer()

    await connectPickFu(user)
    const message = '浏览器拦截了新窗口，无法连接 PickFu；请允许弹出窗口后重试'
    expect(await screen.findByText(message)).toBeVisible()
    // 普通提示 4 秒后消失；要用户处理的这条留着。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4500))
    })
    expect(screen.getByText(message)).toBeVisible()
    expect(authorized).toEqual([])

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(open).toHaveBeenCalledTimes(2)
    await settleToasts()
    expect(screen.getByText(message)).toBeVisible()
  }, 10_000)

  it('断开：发 DELETE，提示「X 已断开」，重读后这一行变回未连接，列表留着', async () => {
    setMockMcpConnections({
      agents: { replica: ['pickfu'] },
      users: { tester: { pickfu: { account: 'demo@example.com', state: 'connected' } } },
    })
    const reads = recordListReads()
    const { user } = await renderComposer()
    const menu = await openConnectors(user)
    const readsBefore = reads.length

    await user.click(within(menu).getByRole('menuitem', { name: '断开 PickFu' }))
    expect(await screen.findByText('PickFu 已断开')).toBeVisible()
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore))
    expect(await within(menu).findByRole('menuitem', { name: '连接 PickFu' })).toBeInTheDocument()
    expect(within(menu).getByText('未连接')).toBeVisible()
  })
})

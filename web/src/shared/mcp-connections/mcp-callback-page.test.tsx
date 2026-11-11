import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { McpCallbackPage, type McpCallbackParams } from './mcp-callback-page'
import {
  openSignInChannel,
  recallSignIn,
  rememberSignIn,
  type SignInResult,
} from './sign-in-handoff'

const PICKFU = { name: 'PickFu', serverId: 'pickfu' }
const OPENER_TAB = 'tab-opener'

/** 发起页记下的这次登录（与发起页走同一个入口）。 */
const rememberPending = (state: string) =>
  rememberSignIn(`https://auth.example/authorize?state=${state}`, PICKFU, OPENER_TAB)

const params = (overrides: Partial<McpCallbackParams> = {}): McpCallbackParams => ({
  code: '123456',
  error: null,
  iss: 'https://auth.example',
  state: 's-1',
  ...overrides,
})

/** 发起连接的页面那一侧：收回调页通过频道发回的结果。 */
const listenAsOpener = () => {
  const results: SignInResult[] = []
  const channel = openSignInChannel()
  channel.onmessage = (event: MessageEvent<SignInResult>) => {
    results.push(event.data)
  }
  channels.push(channel)
  return results
}

const channels: BroadcastChannel[] = []

const serveComplete = (answer: () => Response) => {
  const bodies: unknown[] = []
  server.use(
    http.post('*/api/mcp-connections/complete', async ({ request }) => {
      bodies.push(await request.json())
      return answer()
    }),
  )
  return bodies
}

const conflict = (code: string) => () =>
  HttpResponse.json({ code, detail: '后端说明' }, { status: 409 })

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close()
  localStorage.clear()
})

describe('McpCallbackPage', () => {
  it('成功：把参数原样交给后端一次，显示「X 已连接」，通知发起的标签页，稍后关闭窗口', async () => {
    rememberPending('s-1')
    const results = listenAsOpener()
    const bodies = serveComplete(() =>
      HttpResponse.json({ account: 'demo@example.com', name: 'PickFu', serverId: 'pickfu' }),
    )
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})

    await renderWithProviders(
      <StrictMode>
        <McpCallbackPage params={params()} />
      </StrictMode>,
    )

    expect(await screen.findByRole('heading', { name: 'PickFu 已连接' })).toBeVisible()
    expect(screen.getByText('此窗口将自动关闭')).toBeVisible()
    expect(bodies).toEqual([{ code: '123456', iss: 'https://auth.example', state: 's-1' }])
    await waitFor(() =>
      expect(results).toEqual([
        {
          name: 'PickFu',
          ok: true,
          serverId: 'pickfu',
          tabId: OPENER_TAB,
          type: 'mcp-sign-in-result',
        },
      ]),
    )
    expect(recallSignIn('s-1')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })

  it('一般失败且记得是哪个服务：「X 连接失败，请重试」，通知发起页；「重试」在本窗口重新登录同一个服务', async () => {
    rememberPending('s-1')
    const results = listenAsOpener()
    serveComplete(conflict('mcp_oauth_rejected'))
    const authorized: string[] = []
    server.use(
      http.post('*/api/mcp-connections/:serverId/authorize', ({ params: path }) => {
        authorized.push(String(path['serverId']))
        return HttpResponse.json({
          authorizationUrl: 'https://auth.example/authorize?state=s-2',
        })
      }),
    )
    const open = vi.spyOn(window, 'open')
    const user = userEvent.setup()
    await renderWithProviders(<McpCallbackPage params={params()} />)

    expect(await screen.findByRole('heading', { name: 'PickFu 连接失败，请重试' })).toBeVisible()
    await waitFor(() =>
      expect(results).toEqual([
        {
          name: 'PickFu',
          ok: false,
          serverId: 'pickfu',
          tabId: OPENER_TAB,
          type: 'mcp-sign-in-result',
        },
      ]),
    )
    expect(recallSignIn('s-1')).toBeNull()

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(authorized).toEqual(['pickfu']))
    await waitFor(() => expect(recallSignIn('s-2')).toEqual({ ...PICKFU, tabId: OPENER_TAB }))
    // 本窗口跳转（location.assign）在 jsdom 里无法观察；能看到的是同一服务重新要了地址、记下了新的登录。
    expect(open).not.toHaveBeenCalled()
  })

  it('一般失败但不记得是哪个服务：句子里没有服务名，也没有「重试」', async () => {
    serveComplete(conflict('mcp_oauth_rejected'))
    await renderWithProviders(<McpCallbackPage params={params()} />)

    expect(
      await screen.findByRole('heading', { name: '连接失败，请回到原页面重新连接' }),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回 iClip' })).toBeVisible()
  })

  it.each([
    [
      '这次登录是别人发起的',
      params(),
      conflict('mcp_sign_in_foreign'),
      '当前登录账号与发起连接的账号不一致，无法完成连接；请回到原页面重新连接',
      1,
    ],
    [
      '这次登录已失效',
      params(),
      conflict('mcp_sign_in_expired'),
      '这次连接已超时，请回到原页面重新连接',
      1,
    ],
    ['服务那边取消了', params({ code: null, error: 'access_denied' }), undefined, '已取消连接', 0],
    ['回调缺 code', params({ code: null }), undefined, 'PickFu 连接失败，请重试', 0],
  ])('%s：显示对应的话，并通知发起页失败', async (_, given, answer, title, completes) => {
    rememberPending('s-1')
    const results = listenAsOpener()
    const bodies = serveComplete(answer ?? (() => HttpResponse.json({}, { status: 500 })))
    await renderWithProviders(<McpCallbackPage params={given} />)

    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    await waitFor(() =>
      expect(results).toEqual([
        {
          name: 'PickFu',
          ok: false,
          serverId: 'pickfu',
          tabId: OPENER_TAB,
          type: 'mcp-sign-in-result',
        },
      ]),
    )
    expect(bodies).toHaveLength(completes)
    expect(recallSignIn('s-1')).toBeNull()
  })

  it('回调缺 state：无从知道是哪个服务，不交给后端，提示回原页面重新连接', async () => {
    const bodies = serveComplete(() => HttpResponse.json({}, { status: 500 }))
    await renderWithProviders(<McpCallbackPage params={params({ state: null })} />)

    expect(
      await screen.findByRole('heading', { name: '连接失败，请回到原页面重新连接' }),
    ).toBeVisible()
    expect(bodies).toEqual([])
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
  })
})

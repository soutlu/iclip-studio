import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AUTH_QUERY_KEY_ROOT } from '@/shared/auth'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { LoginDialog } from './login-dialog'

const SSO_UNAVAILABLE = '飞书登录暂不可用，请使用账号密码登录'
const serveSsoProbe = (respond: () => Response | Promise<Response>) =>
  server.use(http.get('*/api/auth/sso/authorize', respond))
const ssoOpen = () => HttpResponse.json({ authorization_url: 'https://sso.example.com/authorize' })

/** 应用壳的用法：点「登录」打开弹窗。 */
function LoginTrigger() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        登录
      </button>
      <LoginDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

describe('LoginDialog', () => {
  it('打开时焦点在用户名输入框，Esc 关闭弹窗', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    serveSsoProbe(() => new HttpResponse(null, { status: 404 }))
    await renderWithProviders(<LoginDialog open onOpenChange={onOpenChange} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    await waitFor(() => expect(within(dialog).getByLabelText('用户名')).toHaveFocus())

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('SSO 开启时显示飞书入口，不出现故障提示', async () => {
    serveSsoProbe(ssoOpen)
    await renderWithProviders(<LoginDialog open onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    expect(await within(dialog).findByRole('button', { name: '使用飞书登录' })).toBeVisible()
    expect(within(dialog).queryByText(SSO_UNAVAILABLE)).not.toBeInTheDocument()
  })

  it('已知 SSO 开启时打开，焦点直接落在飞书登录按钮', async () => {
    const user = userEvent.setup()
    serveSsoProbe(ssoOpen)
    const { queryClient } = await renderWithProviders(<LoginTrigger />)
    queryClient.setQueryData([AUTH_QUERY_KEY_ROOT, 'sso-enabled'], true)

    await user.click(screen.getByRole('button', { name: '登录' }))
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '使用飞书登录' })).toHaveFocus(),
    )
  })

  it('打开后探测才返回 SSO 开启：账号密码区收起，焦点从用户名移到飞书登录按钮', async () => {
    serveSsoProbe(async () => {
      await delay(50)
      return ssoOpen()
    })
    await renderWithProviders(<LoginDialog open onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })
    await waitFor(() => expect(within(dialog).getByLabelText('用户名')).toHaveFocus())

    const ssoButton = await within(dialog).findByRole('button', { name: '使用飞书登录' })

    await waitFor(() => expect(ssoButton).toHaveFocus())
    expect(within(dialog).getByLabelText('用户名')).not.toBeVisible()
  })

  it('SSO 探测 500 时提示飞书登录暂不可用，账号密码仍可登录', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    serveSsoProbe(() => new HttpResponse(null, { status: 500 }))
    await renderWithProviders(<LoginDialog open onOpenChange={onOpenChange} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(SSO_UNAVAILABLE)
    expect(within(dialog).queryByRole('button', { name: '使用飞书登录' })).not.toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('用户名'), 'tester')
    await user.type(within(dialog).getByLabelText('密码'), 'secret')
    await user.click(within(dialog).getByRole('button', { name: '登录' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('探测失败后点重试，恢复即出现飞书入口', async () => {
    const user = userEvent.setup()
    serveSsoProbe(() => new HttpResponse(null, { status: 503 }))
    await renderWithProviders(<LoginDialog open onOpenChange={vi.fn()} />)
    const dialog = await screen.findByRole('dialog', { name: '欢迎登录 Cue' })
    await within(dialog).findByText(SSO_UNAVAILABLE)

    serveSsoProbe(ssoOpen)
    await user.click(within(dialog).getByRole('button', { name: '重试' }))

    expect(await within(dialog).findByRole('button', { name: '使用飞书登录' })).toBeVisible()
    expect(within(dialog).queryByText(SSO_UNAVAILABLE)).not.toBeInTheDocument()
  })
})

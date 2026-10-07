import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { setThemePreference } from '@/shared/lib/theme'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { CueUserMenu } from './cue-user-menu'

/** 已登录用户的头像菜单；后面跟一个页面控件，用来确认焦点不会跑出菜单。 */
async function renderMenu(compact = false) {
  loginAs(mockAuthUser)
  await renderWithProviders(
    <>
      <CueUserMenu compact={compact} />
      <button type="button">页面后续控件</button>
    </>,
  )
  const trigger = screen.getByRole('button', { name: '用户菜单' })
  await waitFor(() => expect(trigger).toHaveAttribute('title', mockAuthUser.displayName))
  return trigger
}

describe('CueUserMenu', () => {
  afterEach(() => {
    setThemePreference('system')
    window.localStorage.clear()
  })

  it('点开后方向键进到菜单项，Tab 不会跳到页面后续控件', async () => {
    const user = userEvent.setup()
    const trigger = await renderMenu()

    await user.click(trigger)
    const first = await screen.findByRole('menuitemradio', { name: '跟随系统' })
    await user.keyboard('{ArrowDown}')
    expect(first).toHaveFocus()
    await user.tab()

    expect(first).toHaveFocus()
    expect(screen.getByRole('button', { name: '页面后续控件', hidden: true })).not.toHaveFocus()
  })

  it.each([false, true])(
    '键盘打开时焦点落在菜单项上，Escape 回到头像，compact=%s',
    async (compact) => {
      const user = userEvent.setup()
      const trigger = await renderMenu(compact)

      trigger.focus()
      await user.keyboard('{Enter}')
      expect(await screen.findByRole('menuitemradio', { name: '跟随系统' })).toHaveFocus()
      await user.keyboard('{Escape}')

      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
      expect(trigger).toHaveFocus()
    },
  )

  it('外观选深色：页面立即变深，菜单不关，选中的换到深色', async () => {
    const user = userEvent.setup()
    const trigger = await renderMenu()

    await user.click(trigger)
    const appearance = await screen.findByRole('group', { name: '外观' })
    const system = within(appearance).getByRole('menuitemradio', { name: '跟随系统' })
    const dark = within(appearance).getByRole('menuitemradio', { name: '深色' })
    expect(system).toHaveAttribute('aria-checked', 'true')
    await user.click(dark)

    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(dark).toHaveAttribute('aria-checked', 'true')
    expect(system).toHaveAttribute('aria-checked', 'false')
  })

  it('点退出登录发出退出请求，会话清空后头像回到通用轮廓', async () => {
    const user = userEvent.setup()
    const logouts: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/api/auth/logout')) {
        logouts.push(request.url)
      }
    })
    const trigger = await renderMenu()

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: '退出登录' }))

    await waitFor(() => expect(logouts).toHaveLength(1))
    await waitFor(() => expect(trigger).toHaveAttribute('title', '用户'))
  })
})

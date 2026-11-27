import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { setThemePreference } from '@/shared/lib/theme'
import { renderWithProviders } from '@/testing/render'
import { ThemeToggle } from './theme-toggle'

const isDark = () => document.documentElement.classList.contains('dark')

describe('顶栏的外观切换', () => {
  afterEach(() => {
    setThemePreference('system')
    document.documentElement.classList.remove('dark')
    window.localStorage.clear()
  })

  it('浅色时点「切换为深色」换成深色，按钮改叫「切换为浅色」；再点回到浅色', async () => {
    setThemePreference('light')
    const user = userEvent.setup()
    await renderWithProviders(<ThemeToggle />)

    await user.click(screen.getByRole('button', { name: '切换为深色' }))
    expect(isDark()).toBe(true)

    await user.click(screen.getByRole('button', { name: '切换为浅色' }))
    expect(isDark()).toBe(false)
    expect(screen.getByRole('button', { name: '切换为深色' })).toBeVisible()
  })
})

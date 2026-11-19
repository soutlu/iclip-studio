import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import type { AudioRole } from './audio-role'
import { MixStyle } from './smart-mix-style'

describe('音色风格 · 更多风格', () => {
  it('下拉里没有快捷小块上已有的风格，选一个交出去', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    // 声音角色走变量传：组件的参数也叫 role，写成字面量会被当成 ARIA 角色检查
    const voice: AudioRole = 'voice'
    await renderWithProviders(<MixStyle active={null} onPick={onPick} role={voice} />)
    const tiles = screen.getAllByRole('radio').map((tile) => tile.textContent)
    expect(tiles).toEqual(['原声', '纯净人声', '消除底噪', '电台播客', '柔和齿音', '电话音色'])

    await user.click(screen.getByRole('button', { name: '更多风格' }))
    const listed = screen.getAllByRole('menuitemradio').map((item) => item.textContent)
    expect(listed.length).toBeGreaterThan(0)
    for (const tile of tiles)
      expect(listed.some((text) => text?.startsWith(tile ?? ''))).toBe(false)

    await user.click(screen.getByRole('menuitemradio', { name: /^花栗鼠/ }))
    expect(onPick).toHaveBeenCalledWith('chipmunk')
  })
})

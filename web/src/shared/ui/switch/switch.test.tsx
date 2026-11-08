import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { Switch } from './switch'

describe('Switch', () => {
  it('是带开关状态的 switch，点击、Space、Enter 都交出取反后的值', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    renderWithTooltip(
      <Switch aria-label="首页可见" checked={false} onCheckedChange={onCheckedChange} />,
    )

    const toggle = screen.getByRole('switch', { name: '首页可见' })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await user.keyboard(' ')
    await user.keyboard('{Enter}')
    expect(onCheckedChange).toHaveBeenNthCalledWith(1, true)
    expect(onCheckedChange).toHaveBeenCalledTimes(3)
  })

  it('被规则拦下时仍可聚焦、状态不变，切换被拦下，悬停弹出原因', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    renderWithTooltip(
      <Switch
        aria-label="拆解助手"
        blockedReason="尚未发布，不能选作子 Agent"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    )

    const toggle = screen.getByRole('switch', { name: '拆解助手' })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).not.toBeDisabled()
    await user.hover(toggle)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('尚未发布，不能选作子 Agent')

    await user.click(toggle)
    await user.keyboard(' ')
    expect(onCheckedChange).not.toHaveBeenCalled()
    expect(toggle).not.toBeChecked()
  })

  it('真正不可用时原生禁用，不响应点击', async () => {
    const user = userEvent.setup()
    const onCheckedChange = vi.fn()
    renderWithTooltip(
      <Switch aria-label="AI 自动打标" checked disabled onCheckedChange={onCheckedChange} />,
    )

    const toggle = screen.getByRole('switch', { name: 'AI 自动打标' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})

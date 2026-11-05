import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SubmitButton, type SubmitPhase } from './submit-button'

const button = (phase: SubmitPhase) => (
  <SubmitButton label="生成第 1 组" leadingIcon="video" phase={phase} />
)

describe('SubmitButton', () => {
  it.each<[SubmitPhase, string]>([
    ['idle', '生成第 1 组'],
    ['sending', '提交中…'],
    ['accepted', '已提交'],
  ])('%s 阶段的可访问名就是可见文案，撑宽度的隐藏层不混进去', (phase, name) => {
    render(button(phase))
    const control = screen.getByRole('button', { name })
    expect(control).toHaveAccessibleName(name)
    expect(within(control).getByText(name, { ignore: '[aria-hidden="true"]' })).toBeVisible()
  })

  it('提交中的文案可以换', () => {
    render(
      <SubmitButton label="生成音乐" leadingIcon="music" pendingLabel="正在提交" phase="sending" />,
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('正在提交')
  })

  it('换阶段还是同一个按钮，焦点不丢', async () => {
    const { rerender } = render(button('idle'))
    const control = screen.getByRole('button')
    await userEvent.tab()
    expect(control).toHaveFocus()

    rerender(button('sending'))
    rerender(button('accepted'))
    rerender(button('idle'))
    expect(screen.getByRole('button')).toBe(control)
    expect(control).toHaveFocus()
  })

  it('其余属性透传给按钮', async () => {
    const onClick = vi.fn()
    render(
      <SubmitButton
        aria-disabled
        label="生成图片"
        leadingIcon="image"
        onClick={onClick}
        phase="sending"
        variant="tonal"
      />,
    )
    const control = screen.getByRole('button')
    expect(control).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(control)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

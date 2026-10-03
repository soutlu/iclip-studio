import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { renderWithTooltip } from '@/testing/render'
import { IconButton } from './icon-button'

describe('IconButton 的提示', () => {
  it('悬停弹出共用提示，文字默认取 label，不再带原生 title', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<IconButton label="折叠对话" name="panel-left" />)

    const button = screen.getByRole('button', { name: '折叠对话' })
    expect(button).not.toHaveAttribute('title')
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('折叠对话')
  })

  it('传了 tooltip 时提示换成它，可访问名称仍是 label', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<IconButton label="复制" name="check" tooltip="已复制" />)

    await user.hover(screen.getByRole('button', { name: '复制' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('已复制')
  })

  it('按 Tab 移到按钮上弹出提示', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<IconButton label="上一帧" name="back" />)

    await user.tab()
    expect(screen.getByRole('button', { name: '上一帧' })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('上一帧')
  })

  it('弹窗自动聚焦到按钮上不弹提示，Esc 直接关掉弹窗', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderWithTooltip(
      <DialogRoot onOpenChange={onOpenChange} open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="需求单详情" />
        </DialogSurface>
      </DialogRoot>,
    )

    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('IconButton 置灰', () => {
  it('置灰用 aria-disabled，按钮仍能聚焦；点击、Enter、Space 都不触发回调', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    renderWithTooltip(<IconButton disabled label="重新生成" name="refresh" onClick={onClick} />)

    const button = screen.getByRole('button', { name: '重新生成' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toHaveAttribute('disabled')

    await user.click(button)
    await user.tab()
    await user.tab({ shift: true })
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('置灰时悬停照样弹提示，文字可以换成原因', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <IconButton disabled label="从这里另开一段对话" name="fork" tooltip="等这一条跑完再分叉" />,
    )

    await user.hover(screen.getByRole('button', { name: '从这里另开一段对话' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('等这一条跑完再分叉')
  })

  it('表单里的提交按钮置灰时点了不提交', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault())
    renderWithTooltip(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <IconButton disabled label="发送" name="send" type="submit" />
      </form>,
    )

    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('恢复可用后点击照常触发回调', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const { rerender } = renderWithTooltip(
      <IconButton disabled label="重新生成" name="refresh" onClick={onClick} />,
    )

    rerender(<IconButton label="重新生成" name="refresh" onClick={onClick} />)
    const button = screen.getByRole('button', { name: '重新生成' })
    expect(button).not.toHaveAttribute('aria-disabled')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

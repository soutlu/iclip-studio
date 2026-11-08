import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { DialogHeader, DialogRoot, DialogSurface } from './dialog'

function OpenedByState() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        打开设置
      </button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogSurface aria-describedby={undefined} returnFocus>
          <DialogHeader closeLabel="关闭" title="设置" />
        </DialogSurface>
      </DialogRoot>
    </>
  )
}

describe('DialogSurface 的焦点回位', () => {
  it.each([
    ['Esc', () => userEvent.keyboard('{Escape}')],
    ['关闭按钮', () => userEvent.click(screen.getByRole('button', { name: '关闭' }))],
  ])('不经触发器打开的弹窗用%s关闭后，焦点回到打开它的按钮', async (_, close) => {
    renderWithTooltip(<OpenedByState />)
    const opener = screen.getByRole('button', { name: '打开设置' })
    await userEvent.click(opener)
    expect(screen.getByRole('dialog', { name: '设置' })).toBeVisible()
    await close()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(opener).toHaveFocus()
  })
})

const fileDrag = () => ({ dropEffect: '', files: [], items: [], types: ['Files'] })

describe('DialogSurface 对文件拖放', () => {
  it('弹窗本体与遮罩都标成禁止落点，drop 带着 defaultPrevented 冒出去', () => {
    renderWithTooltip(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
        </DialogSurface>
      </DialogRoot>,
    )
    const dialog = screen.getByRole('dialog', { name: '编辑图片' })
    const overlay = dialog.previousElementSibling
    if (overlay === null) throw new Error('Radix 把遮罩渲染在弹窗本体前面')
    for (const target of [dialog, overlay]) {
      const dataTransfer = fileDrag()
      fireEvent.dragOver(target, { dataTransfer })
      expect(dataTransfer.dropEffect).toBe('none')
      const drop = createEvent.drop(target, { dataTransfer: fileDrag() })
      fireEvent(target, drop)
      expect(drop.defaultPrevented).toBe(true)
    }
  })

  it('弹窗里自己的拖放区先接管的，弹窗不再改写它的落点效果', () => {
    renderWithTooltip(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
          <div
            data-testid="zone"
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
          />
        </DialogSurface>
      </DialogRoot>,
    )
    const dataTransfer = fileDrag()
    fireEvent.dragOver(screen.getByTestId('zone'), { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')
  })

  it('拖的不是文件时不插手', () => {
    renderWithTooltip(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined}>
          <DialogHeader closeLabel="关闭" title="编辑图片" />
        </DialogSurface>
      </DialogRoot>,
    )
    const dialog = screen.getByRole('dialog', { name: '编辑图片' })
    const dataTransfer = { dropEffect: '', types: ['text/plain'] }
    const over = createEvent.dragOver(dialog, { dataTransfer })
    fireEvent(dialog, over)
    expect(over.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('')
  })
})

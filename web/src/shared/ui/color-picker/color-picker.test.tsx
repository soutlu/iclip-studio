import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ColorPicker } from './color-picker'

/** 像调用方那样把拖动中报出来的颜色传回去。 */
function Harness({
  onChange,
  onCommit,
}: {
  onChange: (hex: string) => void
  onCommit: (hex: string) => void
}) {
  const [value, setValue] = useState('#3366CC')
  return (
    <ColorPicker
      onChange={(hex) => {
        setValue(hex)
        onChange(hex)
      }}
      onCommit={(hex) => {
        setValue(hex)
        onCommit(hex)
      }}
      value={value}
    >
      <button type="button">底色</button>
    </ColorPicker>
  )
}

const open = async () => {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  const user = userEvent.setup()
  render(<Harness onChange={onChange} onCommit={onCommit} />)
  await user.click(screen.getByRole('button', { name: '底色' }))
  return { user, onChange, onCommit, panel: screen.getByRole('dialog', { name: '取色板' }) }
}

/** jsdom 不排版：给方块一个 100 × 100 的位置。 */
const laidOut = (element: HTMLElement) => {
  const rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0 }
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => rect })
  return element
}

const HEX = /^#[0-9A-F]{6}$/

describe('ColorPicker', () => {
  it('拖方块：按下、拖动中都报颜色，松手才提交一次', async () => {
    const { onChange, onCommit } = await open()
    const board = laidOut(screen.getByRole('slider', { name: '饱和度与明度' }))
    fireEvent.mouseDown(board, { button: 0, buttons: 1, clientX: 100, clientY: 0 })
    fireEvent.mouseMove(document, { buttons: 1, clientX: 0, clientY: 0 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2)
    // 最右上是纯色，最左上是白色
    expect(onChange.mock.calls.at(-1)).toEqual(['#FFFFFF'])
    expect(board).toHaveAttribute('aria-valuetext', '#FFFFFF')
    fireEvent.mouseUp(document)
    expect(onCommit.mock.calls).toEqual([['#FFFFFF']])
  })

  it('拖到灰再拖回来，色相还在', async () => {
    const { onCommit } = await open()
    const board = laidOut(screen.getByRole('slider', { name: '饱和度与明度' }))
    fireEvent.mouseDown(board, { button: 0, buttons: 1, clientX: 0, clientY: 50 })
    fireEvent.mouseUp(document)
    expect(onCommit.mock.calls.at(-1)?.[0]).toMatch(/^#([0-9A-F]{2})\1\1$/)
    fireEvent.mouseDown(board, { button: 0, buttons: 1, clientX: 100, clientY: 0 })
    fireEvent.mouseUp(document)
    // #3366CC 的色相是 220°：饱和度、明度拉满是 #0055FF
    expect(onCommit.mock.calls.at(-1)).toEqual(['#0055FF'])
  })

  it('色相条用键盘：方向键报颜色，抬起时提交', async () => {
    const { onChange, onCommit } = await open()
    const hue = screen.getByRole('slider', { name: '色相' })
    // 它按 keyCode 认方向键，user-event 发的按键里没有，这里直接发
    fireEvent.keyDown(hue, { key: 'ArrowRight', keyCode: 39 })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyUp(hue, { key: 'ArrowRight', keyCode: 39 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0]?.[0]).toMatch(HEX)
    expect(onCommit.mock.calls[0]?.[0]).not.toBe('#3366CC')
  })

  it('点预设色直接提交，标成选中；Esc 关上', async () => {
    const { user, onChange, onCommit, panel } = await open()
    const swatches = screen.getAllByRole('button', { pressed: false })
    expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
      '#FFFFFF',
      '#F5EFE6',
      '#E4B790',
      '#FBBF24',
      '#34D399',
      '#93C5FD',
      '#FB7185',
      '#18191D',
    ])
    await user.click(screen.getByRole('button', { name: '#34D399' }))
    expect(onCommit.mock.calls).toEqual([['#34D399']])
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '#34D399' })).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(panel).not.toBeInTheDocument()
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Slider } from './slider'

/** 像调用方那样把拖动中报出来的值传回去。 */
function Harness({
  onChange,
  onCommit,
  ...rest
}: {
  onChange: (value: number) => void
  onCommit: (value: number) => void
  mark?: number
  disabled?: boolean
  onDoubleClick?: () => void
}) {
  const [value, setValue] = useState(20)
  return (
    <Slider
      label="音量"
      max={100}
      min={0}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      onCommit={onCommit}
      value={value}
      valueText={`${value} 格`}
      {...rest}
    />
  )
}

/** jsdom 不排版：给滑杆一个 100px 宽的位置，按下后算它捕获了指针。 */
const laidOut = (root: HTMLElement) => {
  const rect = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 }
  Object.defineProperty(root, 'getBoundingClientRect', { value: () => rect })
  Object.defineProperty(root, 'hasPointerCapture', { value: () => true })
  return root
}

describe('Slider', () => {
  it('拖动中每次挪动都报值，松手只报一次提交', async () => {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    render(<Harness onChange={onChange} onCommit={onCommit} />)
    const thumb = screen.getByRole('slider', { name: '音量' })
    const root = laidOut(thumb.parentElement?.closest<HTMLElement>('[data-orientation]') ?? thumb)

    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 40 })
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 60 })
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 75 })
    expect(onChange.mock.calls).toEqual([[40], [60], [75]])
    await Promise.resolve()
    expect(onCommit).not.toHaveBeenCalled()
    expect(thumb).toHaveAttribute('aria-valuetext', '75 格')

    fireEvent.pointerUp(root, { pointerId: 1, clientX: 75 })
    await waitFor(() => expect(onCommit.mock.calls).toEqual([[75]]))
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('按一下方向键：先报值，再提交一次', async () => {
    const calls: string[] = []
    const user = userEvent.setup()
    render(
      <Harness
        onChange={(value) => calls.push(`值 ${value}`)}
        onCommit={(value) => calls.push(`提交 ${value}`)}
      />,
    )
    screen.getByRole('slider', { name: '音量' }).focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(calls).toEqual(['值 21', '提交 21']))
  })

  it('双击报给调用方；禁用时不报', () => {
    const onDoubleClick = vi.fn()
    const { rerender } = render(
      <Harness onChange={vi.fn()} onCommit={vi.fn()} onDoubleClick={onDoubleClick} />,
    )
    const root = () => {
      const thumb = screen.getByRole('slider', { name: '音量' })
      return thumb.parentElement?.closest<HTMLElement>('[data-orientation]') ?? thumb
    }
    fireEvent.doubleClick(root())
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
    rerender(
      <Harness disabled onChange={vi.fn()} onCommit={vi.fn()} onDoubleClick={onDoubleClick} />,
    )
    fireEvent.doubleClick(root())
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
  })

  it('给了刻度才画刻度', () => {
    const { rerender } = render(<Harness onChange={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.queryByTestId('slider-mark')).toBeNull()
    rerender(<Harness mark={50} onChange={vi.fn()} onCommit={vi.fn()} />)
    expect(screen.getByTestId('slider-mark')).toBeInTheDocument()
  })

  it('禁用时按键、按下都不改值', async () => {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    const user = userEvent.setup()
    render(<Harness disabled onChange={onChange} onCommit={onCommit} />)
    const thumb = screen.getByRole('slider', { name: '音量' })
    expect(thumb).toHaveAttribute('aria-disabled', 'true')
    const root = laidOut(thumb.parentElement?.closest<HTMLElement>('[data-orientation]') ?? thumb)
    thumb.focus()
    await user.keyboard('{ArrowRight}')
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 80 })
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 80 })
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(thumb).toHaveAttribute('aria-valuenow', '20')
  })
})

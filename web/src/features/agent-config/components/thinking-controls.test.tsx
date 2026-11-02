import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThinkingLevel } from '@/shared/ui/thinking-level'
import { renderWithTooltip } from '@/testing/render'
import { ThinkingFader, ThinkingLevelOptions } from './thinking-controls'

const SPARSE_LEVELS: readonly ThinkingLevel[] = ['none', 'low', 'high', 'max']

function FaderHarness({
  initial = 'low',
  levels = SPARSE_LEVELS,
}: {
  initial?: ThinkingLevel | null
  levels?: readonly ThinkingLevel[]
}) {
  const [value, setValue] = useState<ThinkingLevel | null>(initial)
  return <ThinkingFader levels={levels} onChange={setValue} value={value} />
}

describe('ThinkingFader', () => {
  describe('指针拖动', () => {
    beforeEach(() => {
      // jsdom 不排版；三个档位间隔各占 100px，只补浏览器提供的几何和指针信息。
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: 0, width: 300, height: 36 }),
      )
      vi.stubGlobal(
        'PointerEvent',
        class extends MouseEvent {
          readonly pointerId = 1
          readonly pointerType = 'mouse'
          readonly isPrimary = true
        },
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    const capturedThumb = () => {
      const thumb = screen.getByRole('slider', { name: '思考档位' })
      let captured: number | undefined
      Object.assign(thumb, {
        setPointerCapture: (pointerId: number) => {
          captured = pointerId
        },
        hasPointerCapture: (pointerId: number) => captured === pointerId,
        releasePointerCapture: () => {
          captured = undefined
        },
      })
      return thumb
    }

    it('拖动中连续预览但不提交，松开只提交最近的有效档位', () => {
      const onChange = vi.fn()
      renderWithTooltip(<ThinkingFader levels={SPARSE_LEVELS} onChange={onChange} value="low" />)
      const thumb = capturedThumb()

      fireEvent.pointerDown(thumb, { clientX: 100 })
      fireEvent.pointerMove(thumb, { clientX: 130 })
      expect(thumb).toHaveAttribute('aria-valuenow', '1.3')
      fireEvent.pointerMove(thumb, { clientX: 160 })
      expect(thumb).toHaveAttribute('aria-valuenow', '1.6')
      expect(onChange).not.toHaveBeenCalled()

      fireEvent.pointerUp(thumb, { clientX: 160 })
      expect(onChange).toHaveBeenCalledExactlyOnceWith('high')
    })

    it('取消拖动不提交，预览回到原有档位', () => {
      const onChange = vi.fn()
      renderWithTooltip(<ThinkingFader levels={SPARSE_LEVELS} onChange={onChange} value="low" />)
      const thumb = capturedThumb()

      fireEvent.pointerDown(thumb, { clientX: 100 })
      fireEvent.pointerMove(thumb, { clientX: 260 })
      expect(thumb).toHaveAttribute('aria-valuenow', '2.6')
      fireEvent.pointerCancel(thumb)

      expect(onChange).not.toHaveBeenCalled()
      expect(thumb).toHaveAttribute('aria-valuenow', '1')
      expect(thumb).toHaveAttribute('aria-valuetext', '低')
    })
  })

  it('方向键只经过模型支持的档位，Home、End 与边界保持离散取值', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<FaderHarness />)
    const slider = screen.getByRole('slider', { name: '思考档位' })
    slider.focus()

    await user.keyboard('{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuetext', '高')
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(slider).toHaveAttribute('aria-valuetext', '最高')
    await user.keyboard('{Home}{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuetext', '不思考')
    await user.keyboard('{End}')
    expect(slider).toHaveAttribute('aria-valuetext', '最高')
    await user.keyboard('{ArrowLeft}')
    expect(slider).toHaveAttribute('aria-valuetext', '高')
    expect(screen.queryByRole('button', { name: '中' })).not.toBeInTheDocument()
  })

  it('恢复默认后不把默认显示成最低档，仍能点选一个明确档位', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<FaderHarness initial="high" />)

    await user.click(screen.getByRole('button', { name: '恢复默认思考档位' }))
    expect(screen.getByText('默认', { exact: true })).toBeVisible()
    expect(screen.getByRole('slider', { name: '思考档位' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(screen.getByRole('button', { name: '不思考' }))
    expect(screen.getByRole('slider', { name: '思考档位' })).toHaveAttribute(
      'aria-valuetext',
      '不思考',
    )
    expect(screen.queryByText('默认', { exact: true })).not.toBeInTheDocument()
  })

  it('已选档位不再受支持时保留其含义，并允许清回真正默认', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<FaderHarness initial="high" levels={['low']} />)

    expect(screen.getByText('高', { exact: true })).toBeVisible()
    expect(screen.queryByText('默认', { exact: true })).not.toBeInTheDocument()
    const reset = screen.getByRole('button', { name: '恢复默认思考档位' })
    expect(reset).toBeEnabled()
    await user.click(reset)
    expect(screen.getByText('默认', { exact: true })).toBeVisible()
    expect(reset).toBeDisabled()
  })

  it('模型没有可选档位时不提供可操作的滑杆', () => {
    const onChange = vi.fn()
    renderWithTooltip(<ThinkingFader levels={[]} onChange={onChange} value={null} />)

    expect(screen.getByText('默认', { exact: true })).toBeVisible()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('模型只有一个档位时仍可从默认切换到该档位', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<FaderHarness initial={null} levels={['high']} />)

    await user.click(screen.getByRole('button', { name: '高' }))
    const slider = screen.getByRole('slider', { name: '思考档位' })
    expect(slider).toHaveAttribute('aria-valuetext', '高')
    expect(slider).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('ThinkingLevelOptions', () => {
  it('各档位可独立启停，不把不连续的选择扩成区间；禁用时不接受修改', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = renderWithTooltip(
      <ThinkingLevelOptions onChange={onChange} value={['none', 'high']} />,
    )
    expect(screen.getByRole('button', { name: '不思考' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '中' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: '低' }))
    expect(onChange).toHaveBeenLastCalledWith(['none', 'low', 'high'])

    rerender(<ThinkingLevelOptions onChange={onChange} value={['none', 'low', 'high']} />)
    await user.click(screen.getByRole('button', { name: '不思考' }))
    expect(onChange).toHaveBeenLastCalledWith(['low', 'high'])

    rerender(<ThinkingLevelOptions disabled onChange={onChange} value={['low', 'high']} />)
    const highest = screen.getByRole('button', { name: '最高' })
    expect(highest).toBeDisabled()
    await user.click(highest)
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})

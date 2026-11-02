import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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

import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { TurnActions } from './turn-actions'

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

const fullTime = (date: Date): string =>
  `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`

/** 时刻是栏里唯一显示时间文字的按钮。 */
const timeButton = () => screen.getByRole('button', { name: /\d{2}:\d{2}$/ })

/** 触屏点一下：没有悬停，只有按下、抬起和随后的点击。 */
const tap = (user: ReturnType<typeof userEvent.setup>, target: Element) =>
  user.pointer({ keys: '[TouchA]', target })

describe('TurnActions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('复制钮悬停提示「复制」，点了把回复写进剪贴板，再悬停提示「已复制」', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    renderWithTooltip(<TurnActions copyText="最终回复" />)

    const button = screen.getByRole('button', { name: '复制' })
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('复制')

    await user.click(button)
    // 等待剪贴板 Promise 完成后触发的状态微任务。
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('最终回复')

    await user.unhover(button)
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('已复制')
  })

  it('置灰的重新生成、分叉键盘聚焦也提示原因，点击和回车都不触发', async () => {
    const user = userEvent.setup()
    const onFork = vi.fn()
    const onRegenerate = vi.fn()
    renderWithTooltip(
      <TurnActions
        copyText="回复"
        forkDisabled
        onFork={onFork}
        onRegenerate={onRegenerate}
        regenerateDisabled
      />,
    )

    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: '重新生成' })).toHaveFocus()
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('该条消息尚未完成，无法重新生成'),
    )
    await user.keyboard('{Enter}')

    await user.tab()
    expect(screen.getByRole('button', { name: '从此处另开任务' })).toHaveFocus()
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('该条消息尚未完成，无法另开任务'),
    )
    await user.keyboard('{Enter}')

    await user.click(screen.getByRole('button', { name: '重新生成' }))
    await user.click(screen.getByRole('button', { name: '从此处另开任务' }))
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(onFork).not.toHaveBeenCalled()
  })

  it('触屏点一下时刻弹出用量，再点一下收起，点别处也收起', async () => {
    const user = userEvent.setup()
    const ended = new Date()
    renderWithTooltip(
      <>
        <TurnActions
          copyText="回复"
          endedAt={ended.toISOString()}
          usage={{ inputTokens: 2048, outputTokens: 64 }}
        />
        <p>别处</p>
      </>,
    )

    await tap(user, timeButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('输入 2,048 · 缓存 0 · 输出 64')

    await tap(user, timeButton())
    expect(screen.queryByRole('tooltip')).toBeNull()

    await tap(user, timeButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(fullTime(ended))
    await tap(user, screen.getByText('别处'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('时刻能用键盘聚焦，聚焦就弹出完整时刻', async () => {
    const user = userEvent.setup()
    const ended = new Date()
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    await user.tab()
    await user.tab()
    expect(timeButton()).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent(fullTime(ended))
    expect(tooltip).not.toHaveTextContent('输入')
  })
})

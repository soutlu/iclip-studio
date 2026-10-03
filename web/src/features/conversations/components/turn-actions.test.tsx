/** 单测检查文本、提示与回调；hover 显隐由视觉截图验证。 */

import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
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

  it.each(['重新生成', '从这里另开一段对话'])('可用时「%s」悬停提示就是它的名字', async (name) => {
    const user = userEvent.setup()
    renderWithTooltip(<TurnActions copyText="回复" onFork={() => {}} onRegenerate={() => {}} />)

    await user.hover(screen.getByRole('button', { name }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(name)
  })

  it.each([
    ['重新生成', '等这一条跑完再重新生成'],
    ['从这里另开一段对话', '等这一条跑完再分叉'],
  ])('置灰的「%s」悬停时提示原因：%s', async (name, reason) => {
    const user = userEvent.setup()
    renderWithTooltip(
      <TurnActions
        copyText="回复"
        forkDisabled
        onFork={() => {}}
        onRegenerate={() => {}}
        regenerateDisabled
      />,
    )

    await user.hover(screen.getByRole('button', { name }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
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
      expect(screen.getByRole('tooltip')).toHaveTextContent('等这一条跑完再重新生成'),
    )
    await user.keyboard('{Enter}')

    await user.tab()
    expect(screen.getByRole('button', { name: '从这里另开一段对话' })).toHaveFocus()
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('等这一条跑完再分叉'))
    await user.keyboard('{Enter}')

    await user.click(screen.getByRole('button', { name: '重新生成' }))
    await user.click(screen.getByRole('button', { name: '从这里另开一段对话' }))
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(onFork).not.toHaveBeenCalled()
  })

  it('没给分叉回调时不出分叉按钮', () => {
    renderWithTooltip(<TurnActions copyText="回复" />)

    expect(screen.queryByRole('button', { name: '从这里另开一段对话' })).toBeNull()
  })

  it('分叉按钮点一下把这一轮交给回调', async () => {
    const user = userEvent.setup()
    const onFork = vi.fn()
    renderWithTooltip(<TurnActions copyText="回复" onFork={onFork} />)

    await user.click(screen.getByRole('button', { name: '从这里另开一段对话' }))
    expect(onFork).toHaveBeenCalledTimes(1)
  })

  it.each<[TranscriptUsage, string]>([
    [
      { inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 },
      '输入 12,340 · 缓存 4,910 · 输出 1,214',
    ],
    [{ inputTokens: 2048, outputTokens: 64 }, '输入 2,048 · 缓存 0 · 输出 64'],
  ])('用量不常显，悬停时刻弹出完整时刻与用量：%j → %s', async (usage, line) => {
    const user = userEvent.setup()
    const ended = new Date()
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} usage={usage} />)

    expect(screen.queryByText(/输入/)).toBeNull()
    await user.hover(timeButton())
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent(fullTime(ended))
    expect(tooltip).toHaveTextContent(line)
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

  it.each([
    ['缺失', undefined],
    ['解析不出', '垃圾'],
  ])('endedAt %s时时刻不渲染，用量也无处显示', (_, endedAt) => {
    renderWithTooltip(
      <TurnActions copyText="回复" endedAt={endedAt} usage={{ inputTokens: 12340 }} />,
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.querySelector('time')).toBeNull()
    expect(screen.queryByText(/输入/)).toBeNull()
  })

  it('今天完成的时刻只显 HH:mm', () => {
    const ended = new Date()
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(timeButton()).toHaveTextContent(/^\d{2}:\d{2}$/)
  })

  it('昨天完成的时刻补「昨天」前缀', () => {
    const now = new Date()
    const ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 30, 5)
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(timeButton()).toHaveTextContent('昨天 14:30')
  })

  it('更早且同年完成的时刻显 M月d日 HH:mm', () => {
    const now = new Date()
    // 跨年边界改用同年 12 月 31 日，保持日期既非今天也非昨天。
    let ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 8, 9, 7)
    if (ended.getFullYear() !== now.getFullYear()) {
      ended = new Date(now.getFullYear(), 11, 31, 8, 9, 7)
    }
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(timeButton()).toHaveTextContent(/^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
  })

  it('跨自然年完成的时刻补年份，提示里是精确到秒的完整时刻', async () => {
    const user = userEvent.setup()
    const ended = new Date(2020, 0, 2, 3, 4, 5)
    renderWithTooltip(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(timeButton()).toHaveTextContent('2020年1月2日 03:04')
    await user.hover(timeButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('2020/01/02 03:04:05')
  })
})

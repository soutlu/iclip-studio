/** 单测检查文本与 title；hover 显隐由视觉截图验证。 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptUsage } from '@/shared/transcript/vendor'
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

const fullTitle = (date: Date): string =>
  `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`

const TIME_TITLE_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/

describe('TurnActions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('点复制把回复写进剪贴板，按钮提示已复制', async () => {
    const writeText = stubClipboard()
    render(<TurnActions copyText="最终回复" />)

    const button = screen.getByRole('button', { name: '复制' })
    expect(button).toHaveAttribute('title', '复制')
    fireEvent.click(button)
    // 等待剪贴板 Promise 完成后触发的状态微任务。
    await act(async () => {})

    expect(writeText).toHaveBeenCalledWith('最终回复')
    expect(button).toHaveAttribute('title', '已复制')
  })

  it.each<[TranscriptUsage, string]>([
    [
      { inputTokens: 12340, cachedTokens: 4910, outputTokens: 1214 },
      '输入 12,340 · 缓存 4,910 · 输出 1,214',
    ],
    [{ inputTokens: 2048, outputTokens: 64 }, '输入 2,048 · 缓存 0 · 输出 64'],
  ])('用量不常显，并进时刻的悬停提示第二行：%j → %s', (usage, line) => {
    const ended = new Date()
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} usage={usage} />)

    // title 要逐字比对换行，getByTitle 的默认规整会把换行压成空格，所以先按时刻文字取元素。
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toHaveAttribute(
      'title',
      `${fullTitle(ended)}\n${line}`,
    )
    expect(screen.queryByText(/输入/)).toBeNull()
  })

  it('endedAt 缺失时时刻段不渲染，用量也无处显示', () => {
    render(<TurnActions copyText="回复" usage={{ inputTokens: 12340 }} />)

    expect(screen.queryByTitle(TIME_TITLE_RE)).toBeNull()
    expect(screen.queryByTitle(/输入/)).toBeNull()
    expect(screen.queryByText(/输入/)).toBeNull()
  })

  it('endedAt 解析不出时时刻段不渲染，用量也无处显示', () => {
    render(<TurnActions copyText="回复" endedAt="垃圾" usage={{ inputTokens: 12340 }} />)

    expect(screen.queryByTitle(TIME_TITLE_RE)).toBeNull()
    expect(screen.queryByTitle(/输入/)).toBeNull()
    expect(screen.queryByText(/输入/)).toBeNull()
  })

  it('今天完成的时刻只显 HH:mm，没有用量时 title 只有精确完整时刻', () => {
    const ended = new Date()
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    const time = screen.getByTitle(fullTitle(ended))
    expect(time).toHaveTextContent(/^\d{2}:\d{2}$/)
  })

  it('昨天完成的时刻补「昨天」前缀', () => {
    const now = new Date()
    const ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 30, 5)
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(screen.getByTitle(fullTitle(ended))).toHaveTextContent('昨天 14:30')
  })

  it('更早且同年完成的时刻显 M月d日 HH:mm', () => {
    const now = new Date()
    // 跨年边界改用同年 12 月 31 日，保持日期既非今天也非昨天。
    let ended = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 8, 9, 7)
    if (ended.getFullYear() !== now.getFullYear()) {
      ended = new Date(now.getFullYear(), 11, 31, 8, 9, 7)
    }
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    expect(screen.getByTitle(fullTitle(ended))).toHaveTextContent(
      /^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/,
    )
  })

  it('没给分叉回调时不出分叉按钮', () => {
    render(<TurnActions copyText="回复" />)

    expect(screen.queryByRole('button', { name: '从这里另开一段对话' })).toBeNull()
  })

  it('分叉按钮点一下把这一轮交给回调，忙的时候按不动', () => {
    const onFork = vi.fn()
    const { rerender } = render(<TurnActions copyText="回复" onFork={onFork} />)

    fireEvent.click(screen.getByRole('button', { name: '从这里另开一段对话' }))
    expect(onFork).toHaveBeenCalledTimes(1)

    rerender(<TurnActions copyText="回复" forkDisabled onFork={onFork} />)
    expect(screen.getByRole('button', { name: '从这里另开一段对话' })).toBeDisabled()
  })

  it('跨自然年完成的时刻补年份', () => {
    const ended = new Date(2020, 0, 2, 3, 4, 5)
    render(<TurnActions copyText="回复" endedAt={ended.toISOString()} />)

    const time = screen.getByTitle('2020/01/02 03:04:05')
    expect(time).toHaveTextContent('2020年1月2日 03:04')
  })
})

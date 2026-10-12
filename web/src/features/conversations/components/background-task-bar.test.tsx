import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTask } from '@/shared/transcript/vendor'
import { renderWithTooltip } from '@/testing/render'
import { BackgroundTaskBar } from './background-task-bar'

const NOW = new Date('2026-10-11T08:01:20Z')

const task = (taskId: string, fields: Partial<TranscriptTask> = {}): TranscriptTask => ({
  description: `拆解视频 ${taskId}.mp4`,
  detached: true,
  kind: 'tool',
  outputTail: '',
  startedAt: '2026-10-11T08:00:00Z',
  state: 'running',
  taskId,
  ...fields,
})

const tasksOf = (...tasks: TranscriptTask[]): ReadonlyMap<string, TranscriptTask> =>
  new Map(tasks.map((item) => [item.taskId, item]))

describe('BackgroundTaskBar', () => {
  beforeEach(() => {
    // 只假造时钟与计时用的 setInterval；setTimeout 照旧，user-event 的交互才走得动。
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('一个进行中的任务：写「正在」加任务标题，右侧按开始时间每秒计时', () => {
    renderWithTooltip(<BackgroundTaskBar tasks={tasksOf(task('ugg-ref'))} />)

    const bar = screen.getByRole('note', { name: '后台任务' })
    expect(within(bar).getByText('正在拆解视频 ugg-ref.mp4')).toBeInTheDocument()
    expect(within(bar).getByText('1m20s')).toBeInTheDocument()
    expect(within(bar).queryByRole('button')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(within(bar).getByText('1m21s')).toBeInTheDocument()
  })

  it('多个进行中的任务：一行汇总，点开逐项列出各自的计时，再点收起；键盘也能开合', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <BackgroundTaskBar
        tasks={tasksOf(task('ugg-ref'), task('boots-2', { startedAt: '2026-10-11T08:00:38Z' }))}
      />,
    )

    const toggle = screen.getByRole('button', { name: '2 个后台任务进行中' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      '正在拆解视频 ugg-ref.mp41m20s',
      '正在拆解视频 boots-2.mp442s',
    ])

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listitem')).toBeNull()

    toggle.focus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([
    ['已完成的工具任务', task('done', { state: 'completed' })],
    ['失败的工具任务', task('failed', { state: 'failed' })],
    ['进行中的子代理任务', task('sub', { kind: 'subagent' })],
  ])('只有%s时不显示', (_, item) => {
    const { container } = renderWithTooltip(<BackgroundTaskBar tasks={tasksOf(item)} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('混着别的任务时只数进行中的工具任务', () => {
    renderWithTooltip(
      <BackgroundTaskBar
        tasks={tasksOf(
          task('ugg-ref'),
          task('done', { state: 'completed' }),
          task('sub', { kind: 'subagent' }),
        )}
      />,
    )

    expect(screen.getByRole('note', { name: '后台任务' })).toHaveTextContent(
      '正在拆解视频 ugg-ref.mp4',
    )
  })
})

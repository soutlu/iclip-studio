import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openEditor,
  setUpEditorCase,
  tearDownEditorCase,
  transport,
} from '@/testing/final-cut-editor'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(() => {
  window.localStorage.clear()
  setUpEditorCase()
})
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 外框', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const sideSplitter = () => screen.getByRole('button', { name: '调整右栏宽度' })
  const timelineSplitter = () => screen.getByRole('button', { name: '调整时间线高度' })
  /**
   * 记着的右栏宽度、时间线高度（交给样式去排的那个值，没定过时是空串）。jsdom 不排版，分隔条说明里写的实际尺寸
   * 在端到端测试里看。
   */
  const remembered = (name: '--wf-side-width' | '--wf-timeline-height') => {
    const workspace = side().closest<HTMLElement>('.wf-workspace')
    if (workspace === null) throw new Error('找不到编辑区')
    return workspace.style.getPropertyValue(name)
  }
  const sideWidth = () => remembered('--wf-side-width')
  const timelineHeight = () => remembered('--wf-timeline-height')

  /** jsdom 不排版：给预览舞台、右栏、时间线面板按下分隔条时量到的尺寸。 */
  const sizeParts = (sizes: { stage: number; side: number; timeline: number }) => {
    const stage = transport().closest<HTMLElement>('.wf-stage')
    const timeline = screen.getByRole('toolbar', { name: '剪辑工具' }).parentElement
    if (stage === null || timeline === null) throw new Error('找不到舞台或时间线')
    const box = (width: number, height: number) => () =>
      ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect
    vi.spyOn(stage, 'getBoundingClientRect').mockImplementation(box(sizes.stage, sizes.stage))
    vi.spyOn(side(), 'getBoundingClientRect').mockImplementation(box(sizes.side, 0))
    vi.spyOn(timeline, 'getBoundingClientRect').mockImplementation(box(0, sizes.timeline))
  }

  it('右栏默认 432 宽；按住左缘往左拖变宽，最宽 520', async () => {
    await openEditor()
    expect(sideWidth()).toBe('432px')
    sizeParts({ stage: 600, side: 432, timeline: 240 })

    fireEvent.pointerDown(sideSplitter(), { button: 0, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(window, { clientX: 440, clientY: 300 })
    expect(sideWidth()).toBe('492px')
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300 })
    fireEvent.pointerUp(window)

    expect(sideWidth()).toBe('520px')
  })

  it('拖右栏时预览舞台至少留 360 宽', async () => {
    await openEditor()
    sizeParts({ stage: 400, side: 432, timeline: 240 })

    fireEvent.pointerDown(sideSplitter(), { button: 0, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(window)

    expect(sideWidth()).toBe('472px')
  })

  it('拖到一半按 Esc：右栏退回按下前的宽度', async () => {
    await openEditor()
    sizeParts({ stage: 600, side: 432, timeline: 240 })

    fireEvent.pointerDown(sideSplitter(), { button: 0, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(window, { clientX: 440, clientY: 300 })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(sideWidth()).toBe('432px')
  })

  it('时间线上缘往上拖变高，按方向键一下 16px；双击回到按内容高', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(timelineHeight()).toBe('')
    sizeParts({ stage: 500, side: 432, timeline: 240 })

    fireEvent.pointerDown(timelineSplitter(), { button: 0, clientX: 300, clientY: 600 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 560 })
    fireEvent.pointerUp(window)
    expect(timelineHeight()).toBe('280px')

    sizeParts({ stage: 460, side: 432, timeline: 280 })
    timelineSplitter().focus()
    await user.keyboard('{ArrowUp}')
    expect(timelineHeight()).toBe('296px')

    await user.dblClick(timelineSplitter())
    expect(timelineHeight()).toBe('')
  })

  it('拖过的宽度记在浏览器里：重新打开编辑器还是那么宽', async () => {
    const user = userEvent.setup()
    const { close, reopen } = await openEditor()
    sizeParts({ stage: 600, side: 432, timeline: 240 })
    sideSplitter().focus()
    await user.keyboard('{ArrowLeft}')
    expect(sideWidth()).toBe('448px')

    close()
    reopen()

    await screen.findByRole('button', { name: '调整右栏宽度' })
    expect(sideWidth()).toBe('448px')
  })

  it('收起右栏：只剩导航图标，页签内容藏起来，分隔条也没了', async () => {
    const user = userEvent.setup()
    await openEditor()
    const shots = within(side()).getByRole('tabpanel', { name: '镜头' })

    await user.click(within(side()).getByRole('button', { name: '收起右栏' }))

    expect(shots).not.toBeVisible()
    expect(within(side()).getByRole('tab', { name: '镜头', selected: true })).toBeVisible()
    expect(within(side()).getByRole('button', { name: '展开右栏' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '调整右栏宽度' })).toBeNull()
  })

  it('收起时点一个页签：展开右栏并切到它；点当前的页签也展开', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(side()).getByRole('button', { name: '收起右栏' }))

    await user.click(within(side()).getByRole('tab', { name: '配乐' }))
    expect(within(side()).getByRole('tabpanel', { name: '配乐' })).toBeVisible()

    await user.click(within(side()).getByRole('button', { name: '收起右栏' }))
    await user.click(within(side()).getByRole('tab', { name: '配乐' }))
    expect(within(side()).getByRole('tabpanel', { name: '配乐' })).toBeVisible()
    expect(within(side()).getByRole('button', { name: '收起右栏' })).toBeVisible()
  })
})

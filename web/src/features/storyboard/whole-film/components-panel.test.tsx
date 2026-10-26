import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { DRAG_THRESHOLD } from '../editing/timeline-drag'
import { fixtureCatalog as catalog, fixtureItem } from '@/testing/whole-film'
import type { CatalogItem } from './component-catalog'
import { ComponentsPanel, HOVER_PREVIEW_DELAY_MS } from './components-panel'

const scene = fixtureItem('fixture-scene')
const overlay = fixtureItem('fixture-overlay')
// 目录里能放的组件都有时长；这里造一张没有时长的卡片
const timeless: CatalogItem = {
  ...fixtureItem('fixture-fields'),
  name: 'timeless',
  title: '没有时长',
  duration: null,
}

const renderPanel = () =>
  renderWithTooltip(
    <ComponentsPanel
      catalog={catalog}
      emptyText="暂无组件"
      groups={[{ id: 'g', label: '视觉特效', items: [scene, overlay, timeless] }]}
      groupsLabel="分类"
      onCarry={vi.fn()}
      onDrop={vi.fn()}
      onSelect={vi.fn()}
      onUse={vi.fn()}
      origin="https://studio.example.com"
      selected="g"
    />,
  )

const cardOf = (item: CatalogItem) =>
  screen.getByRole('button', { name: new RegExp(`^${item.title}，`) })

// React 按 pointerover / pointerout 合成卡片上的 enter / leave
const hover = (item: CatalogItem, pointerType = 'mouse') =>
  fireEvent.pointerOver(cardOf(item), { pointerType })
const unhover = (item: CatalogItem) => fireEvent.pointerOut(cardOf(item), { pointerType: 'mouse' })

const players = () => [...document.querySelectorAll('hyperframes-player')]

/** 走过 ms 毫秒，并等播放器模块加载完挂上 */
const elapse = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('组件栏 · 悬停预览', () => {
  // 播放器模块（测试替身）先加载好：之后挂播放器只等微任务，计时器走到哪一刻就看到哪一刻的样子
  beforeAll(async () => {
    await import('@hyperframes/player')
  })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    renderPanel()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('鼠标停够一会儿才在这张卡里挂上播放器（只放这个组件的横版合成页，静音）；移开即拿掉', async () => {
    hover(scene)
    await elapse(HOVER_PREVIEW_DELAY_MS - 1)
    expect(players()).toHaveLength(0)

    await elapse(1)
    const [player] = players()
    expect(player).toBeDefined()
    expect(cardOf(scene)).toContainElement(player as HTMLElement)
    const srcdoc = player?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('data-width="1920" data-height="1080"')
    expect(srcdoc).toMatch(/data-composition-src="[^"]*fixture-scene/)
    expect(player).toHaveAttribute('muted')

    unhover(scene)
    expect(players()).toHaveLength(0)
  })

  it('划过一张卡停在另一张上：只有后一张在播', async () => {
    hover(scene)
    await elapse(HOVER_PREVIEW_DELAY_MS)
    expect(players()).toHaveLength(1)

    hover(overlay)
    await elapse(HOVER_PREVIEW_DELAY_MS)
    const [player, ...rest] = players()
    expect(rest).toHaveLength(0)
    expect(cardOf(overlay)).toContainElement(player as HTMLElement)
    expect(player?.getAttribute('srcdoc')).toMatch(/data-composition-src="[^"]*fixture-overlay/)
  })

  it('按住卡片拖起来：播放器立即拿掉', async () => {
    const card = Object.assign(cardOf(scene), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => false,
      releasePointerCapture: () => undefined,
    })
    hover(scene)
    await elapse(HOVER_PREVIEW_DELAY_MS)
    expect(players()).toHaveLength(1)

    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    expect(players()).toHaveLength(1)
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 10 + DRAG_THRESHOLD + 5, clientY: 10 })
    expect(players()).toHaveLength(0)
  })

  it('没有时长的组件不挂播放器', async () => {
    hover(timeless)
    await elapse(HOVER_PREVIEW_DELAY_MS + 1_000)
    expect(players()).toHaveLength(0)
  })

  it('触摸不触发悬停预览', async () => {
    hover(scene, 'touch')
    await elapse(HOVER_PREVIEW_DELAY_MS + 1_000)
    expect(players()).toHaveLength(0)
  })
})

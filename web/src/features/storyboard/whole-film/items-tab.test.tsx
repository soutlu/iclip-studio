import { useState, type ComponentProps } from 'react'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { fixtureCatalog } from '@/testing/whole-film'
import { DRAG_THRESHOLD } from '../editing/timeline-drag'
import type { CatalogItem } from './composition/catalog'
import { NO_FILTER, type ItemKind } from './items'
import { HOVER_PREVIEW_DELAY_MS, ItemsTab } from './items-tab'

const ORIGIN = 'https://studio.example.com'

type Callbacks = Pick<ComponentProps<typeof ItemsTab>, 'onAdd' | 'onCarry' | 'onDrop'>

/** 和编辑器一样由外面记着搜索词和分类。 */
function Harness({ kind, ...callbacks }: { kind: ItemKind } & Callbacks) {
  const [filter, setFilter] = useState(NO_FILTER)
  return (
    <ItemsTab
      catalog={fixtureCatalog}
      filter={filter}
      kind={kind}
      onFilterChange={setFilter}
      origin={ORIGIN}
      {...callbacks}
    />
  )
}

const renderTab = async (kind: ItemKind) => {
  const onAdd = vi.fn<(item: CatalogItem) => void>()
  const onCarry = vi.fn()
  const onDrop = vi.fn()
  await renderWithProviders(<Harness kind={kind} onAdd={onAdd} onCarry={onCarry} onDrop={onDrop} />)
  return { onAdd, onCarry, onDrop }
}

const grid = () => screen.getByRole('list')
const card = (name: string | RegExp) => within(grid()).getByRole('group', { name })
const cardNames = () =>
  within(grid())
    .getAllByRole('group')
    .map((element) => element.getAttribute('aria-label'))
const players = () => [...document.querySelectorAll('hyperframes-player')]

describe('组件、块页签 · 列出和筛选', () => {
  it('组件页签只列组件、块页签只列块，字幕不列', async () => {
    await renderTab('component')
    expect(screen.getByRole('list', { name: '组件' })).toBeInTheDocument()
    expect(cardNames()).toEqual(['测试叠加，4 秒', '测试可填项，5 秒'])
  })

  it('块页签的卡片：封面、时长、名字、分类', async () => {
    await renderTab('block')
    expect(screen.getByRole('list', { name: '块' })).toBeInTheDocument()
    expect(cardNames()).toEqual(['测试画面，6 秒', '示例品牌 片尾，3 秒'])
    const scene = card('测试画面，6 秒')
    expect(within(scene).getByText('6s')).toBeInTheDocument()
    expect(within(scene).getByText('测试画面')).toBeInTheDocument()
    expect(within(scene).getByText('场景')).toBeInTheDocument()
    expect(scene.querySelector('img')).toHaveAttribute(
      'src',
      '/hyperframes/test-fixtures/thumbnails/fixture-scene.svg',
    )
  })

  it('分类只列这种条目里有的；点分类只看这一类，「品牌」是带品牌的条目', async () => {
    const user = userEvent.setup()
    await renderTab('block')
    const chips = screen.getByRole('radiogroup', { name: '块分类' })
    const chipNames = within(chips)
      .getAllByRole('radio')
      .map((element) => element.textContent)
    expect(chipNames).toEqual(['全部', '品牌', '场景'])
    expect(within(chips).getByRole('radio', { name: '全部' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(within(chips).getByRole('radio', { name: '品牌' }))
    expect(cardNames()).toEqual(['示例品牌 片尾，3 秒'])
  })

  it('组件页签的分类：没有带品牌的组件就没有「品牌」', async () => {
    const user = userEvent.setup()
    await renderTab('component')
    const chips = screen.getByRole('radiogroup', { name: '组件分类' })
    const chipNames = within(chips)
      .getAllByRole('radio')
      .map((element) => element.textContent)
    expect(chipNames).toEqual(['全部', '效果', '文字效果'])
    await user.click(within(chips).getByRole('radio', { name: '效果' }))
    expect(cardNames()).toEqual(['测试叠加，4 秒'])
  })

  it('搜索按名字、说明、分类名筛；没有结果时说明一句', async () => {
    const user = userEvent.setup()
    await renderTab('component')
    const search = screen.getByRole('searchbox', { name: '搜索组件' })
    expect(search).toHaveAttribute('placeholder', '搜索名称或分类')
    await user.type(search, '圆环')
    expect(cardNames()).toEqual(['测试叠加，4 秒'])
    await user.clear(search)
    await user.type(search, '文字效果')
    expect(cardNames()).toEqual(['测试可填项，5 秒'])
    await user.clear(search)
    await user.type(search, '场景')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('暂无符合条件的组件，请更换关键词或分类')
  })

  it('块页签：搜索框和空状态说「块」', async () => {
    const user = userEvent.setup()
    await renderTab('block')
    await user.type(screen.getByRole('searchbox', { name: '搜索块' }), '圆环')
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('暂无符合条件的块，请更换关键词或分类')
  })
})

describe('组件、块页签 · 加进成片', () => {
  it('点卡片上的「加到播放头」：交出这个条目', async () => {
    const user = userEvent.setup()
    const { onAdd, onCarry } = await renderTab('component')
    await user.click(within(card(/^测试叠加/)).getByRole('button', { name: '加到播放头' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0]?.[0].name).toBe('fixture-overlay')
    expect(onCarry).not.toHaveBeenCalled()
  })

  it('按住卡片拖出去：拖过一小段才算拖，一路交出指针的位置，松手时交出落点', async () => {
    const { onCarry, onDrop } = await renderTab('block')
    const scene = card(/^测试画面/)
    fireEvent.pointerDown(scene, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 10 + DRAG_THRESHOLD, clientY: 10 })
    expect(onCarry).not.toHaveBeenCalled()
    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 300, clientY: 500 })
    expect(onCarry).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'fixture-scene' }), {
      clientX: 300,
      clientY: 500,
    })
    fireEvent.pointerUp(scene, { pointerId: 1, clientX: 320, clientY: 510 })
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ name: 'fixture-scene' }), {
      clientX: 320,
      clientY: 510,
    })
  })

  it('拖到一半按 Esc：取消这次拖动，松手不交落点', async () => {
    const user = userEvent.setup()
    const { onCarry, onDrop } = await renderTab('block')
    const scene = card(/^测试画面/)
    fireEvent.pointerDown(scene, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 300, clientY: 500 })
    await user.keyboard('{Escape}')
    expect(onCarry).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'fixture-scene' }),
      null,
    )
    fireEvent.pointerUp(scene, { pointerId: 1, clientX: 320, clientY: 510 })
    expect(onDrop).not.toHaveBeenCalled()
  })
})

describe('组件、块页签 · 悬停预览', () => {
  beforeAll(async () => {
    await import('@hyperframes/player')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const elapse = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  const hover = (name: RegExp, pointerType = 'mouse') =>
    fireEvent.pointerOver(card(name), { pointerType })

  it('鼠标停够一会儿才在这张卡里播这个条目（静音、循环）；移开就拿掉', async () => {
    await renderTab('block')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    hover(/^测试画面/)
    await elapse(HOVER_PREVIEW_DELAY_MS - 1)
    expect(players()).toHaveLength(0)
    await elapse(1)
    const [player] = players()
    expect(card(/^测试画面/)).toContainElement(player as HTMLElement)
    expect(player).toHaveAttribute('muted')
    expect(player).toHaveAttribute('loop')
    // 运行库用组件库里带的那份，收到 srcdoc 时就已经带着
    expect(player).toHaveProperty(
      'loadedRuntimeSrc',
      `${ORIGIN}/hyperframes/test-fixtures/vendor/hyperframes/0.9.31/hyperframe.runtime.iife.js`,
    )
    const srcdoc = player?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain(`<base href="${ORIGIN}/hyperframes/test-fixtures/">`)
    expect(srcdoc).toContain('data-width="1920" data-height="1080"')
    expect(srcdoc).toContain('data-composition-src="compositions/fixtures/fixture-scene.html"')

    fireEvent.pointerOut(card(/^测试画面/), { pointerType: 'mouse' })
    expect(players()).toHaveLength(0)
  })

  it('划过一张停在另一张上：只有停着的那张在播', async () => {
    await renderTab('block')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    hover(/^测试画面/)
    await elapse(HOVER_PREVIEW_DELAY_MS / 2)
    fireEvent.pointerOut(card(/^测试画面/), { pointerType: 'mouse' })
    hover(/^示例品牌/)
    await elapse(HOVER_PREVIEW_DELAY_MS)
    const [player, ...rest] = players()
    expect(rest).toHaveLength(0)
    expect(card(/^示例品牌/)).toContainElement(player as HTMLElement)
  })

  it('按住卡片拖起来：预览立即拿掉；触摸不预览', async () => {
    await renderTab('block')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    hover(/^测试画面/)
    await elapse(HOVER_PREVIEW_DELAY_MS)
    expect(players()).toHaveLength(1)
    const scene = card(/^测试画面/)
    fireEvent.pointerDown(scene, { pointerId: 1, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(scene, { pointerId: 1, clientX: 40, clientY: 10 })
    expect(players()).toHaveLength(0)
    fireEvent.pointerUp(scene, { pointerId: 1, clientX: 40, clientY: 10 })

    hover(/^示例品牌/, 'touch')
    await elapse(HOVER_PREVIEW_DELAY_MS + 1_000)
    expect(players()).toHaveLength(0)
  })
})

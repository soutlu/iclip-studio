import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { PreviewTransport } from './preview-transport'

const base = (): ComponentProps<typeof PreviewTransport> => ({
  playheadMs: 1_000,
  totalMs: 4_000,
  buffered: [],
  playBlocked: undefined,
  playing: false,
  onPlay: vi.fn(),
  onSeek: vi.fn(),
  playback: { rate: 1, muted: false, loop: false },
  onMute: vi.fn(),
  onRate: vi.fn(),
  onLoop: vi.fn(),
  fullscreen: false,
  fullscreenBlocked: undefined,
  onFullscreen: vi.fn(),
  layer: null,
})

const transport = () => screen.getByRole('group', { name: '播放控制' })

describe('预览下面的播放条', () => {
  it('已缓冲的几段画在进度条上，超出成片结尾的部分不画', async () => {
    await renderWithProviders(
      <PreviewTransport
        {...base()}
        buffered={[
          { start: 0, end: 1 },
          { start: 3, end: 5 },
        ]}
      />,
    )
    const [first, second] = screen.getAllByTestId('preview-buffered')
    expect(first).toHaveStyle({ left: '0%', width: '25%' })
    expect(second).toHaveStyle({ left: '75%', width: '25%' })
  })

  it('不能播放时点播放键只说明原因', async () => {
    const user = userEvent.setup()
    const onPlay = vi.fn()
    await renderWithProviders(
      <PreviewTransport {...base()} onPlay={onPlay} playBlocked="成片还是空的" totalMs={0} />,
    )
    await user.click(screen.getByRole('button', { name: '播放' }))
    expect(await screen.findAllByText('成片还是空的')).not.toHaveLength(0)
    expect(onPlay).not.toHaveBeenCalled()
    expect(screen.queryByTestId('preview-buffered')).toBeNull()
  })
})

describe('播放条右边的设置', () => {
  it('静音、循环、全屏各自触发对应的操作', async () => {
    const user = userEvent.setup()
    const props = base()
    await renderWithProviders(<PreviewTransport {...props} />)
    await user.click(within(transport()).getByRole('button', { name: '静音' }))
    await user.click(within(transport()).getByRole('button', { name: '循环播放' }))
    await user.click(within(transport()).getByRole('button', { name: '全屏' }))
    expect(props.onMute).toHaveBeenCalledTimes(1)
    expect(props.onLoop).toHaveBeenCalledTimes(1)
    expect(props.onFullscreen).toHaveBeenCalledTimes(1)
    expect(within(transport()).getByRole('button', { name: '循环播放' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('按钮跟着当前状态：静音后是「开启声音」，循环开着是按下的，全屏时是「退出全屏」', async () => {
    await renderWithProviders(
      <PreviewTransport {...base()} fullscreen playback={{ rate: 1, muted: true, loop: true }} />,
    )
    expect(within(transport()).getByRole('button', { name: '开启声音' })).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '循环播放' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(transport()).getByRole('button', { name: '退出全屏' })).toBeVisible()
  })

  it('倍速按钮写着当前倍速，点开向上列出各档，选 2× 交给外面', async () => {
    const user = userEvent.setup()
    const props = base()
    await renderWithProviders(
      <PreviewTransport {...props} playback={{ rate: 1.5, muted: false, loop: false }} />,
    )
    const rate = within(transport()).getByRole('button', { name: '播放速度 1.5×' })
    expect(rate).toHaveTextContent('1.5×')
    await user.click(rate)
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveAttribute('data-side', 'top')
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['0.25×', '0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×'])
    expect(within(menu).getByRole('menuitemradio', { name: '1.5×' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(within(menu).getByRole('menuitemradio', { name: '2×' }))
    expect(props.onRate).toHaveBeenCalledWith(2)
  })

  it('浏览器不支持全屏：点了只说明原因', async () => {
    const user = userEvent.setup()
    const props = base()
    await renderWithProviders(
      <PreviewTransport {...props} fullscreenBlocked="当前浏览器不支持全屏" />,
    )
    await user.click(within(transport()).getByRole('button', { name: '全屏' }))
    expect(await screen.findAllByText('当前浏览器不支持全屏')).not.toHaveLength(0)
    expect(props.onFullscreen).not.toHaveBeenCalled()
  })

  it('快捷键面板向上打开，列出编辑器里的按键', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<PreviewTransport {...base()} />)
    await user.click(within(transport()).getByRole('button', { name: '快捷键' }))
    const panel = await screen.findByRole('dialog', { name: '快捷键' })
    expect(panel).toHaveAttribute('data-side', 'top')
    for (const [action, key] of [
      ['播放或暂停', '空格'],
      ['静音或开启声音', 'M'],
      ['打开或关闭循环播放', '⇧L'],
      ['全屏或退出全屏', 'F'],
      ['选中播放头左边的片段', '['],
      ['选中播放头右边的片段', ']'],
      ['缩放到选中的片段', 'Z'],
    ] as const)
      expect(within(panel).getByText(action).parentElement).toHaveTextContent(key)
  })

  it('给了挂载的元素：菜单和面板都挂在它里面', async () => {
    const user = userEvent.setup()
    const layer = document.createElement('div')
    document.body.append(layer)
    try {
      await renderWithProviders(<PreviewTransport {...base()} layer={layer} />)
      await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
      expect(layer).toContainElement(await screen.findByRole('menu'))
      await user.keyboard('{Escape}')
      await user.click(within(transport()).getByRole('button', { name: '快捷键' }))
      expect(layer).toContainElement(await screen.findByRole('dialog', { name: '快捷键' }))
    } finally {
      layer.remove()
    }
  })
})

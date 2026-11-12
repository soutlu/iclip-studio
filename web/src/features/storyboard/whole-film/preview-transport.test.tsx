import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { PreviewTransport } from './preview-transport'

const base = {
  playheadMs: 1_000,
  totalMs: 4_000,
  buffered: [],
  playBlocked: undefined,
  playing: false,
  onPlay: vi.fn(),
  onSeek: vi.fn(),
}

describe('预览下面的播放条', () => {
  it('已缓冲的几段画在进度条上，超出成片结尾的部分不画', async () => {
    await renderWithProviders(
      <PreviewTransport
        {...base}
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
      <PreviewTransport {...base} onPlay={onPlay} playBlocked="成片里还没有画面" totalMs={0} />,
    )
    await user.click(screen.getByRole('button', { name: '播放' }))
    expect(await screen.findAllByText('成片里还没有画面')).not.toHaveLength(0)
    expect(onPlay).not.toHaveBeenCalled()
    expect(screen.queryByTestId('preview-buffered')).toBeNull()
  })
})

import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { EditorPreview } from './editor-preview'
import { layoutPlay } from './play-layout'

afterEach(() => vi.restoreAllMocks())

it('当前视频缓冲/seek时停外部混音，恢复时从同一完整时钟继续；预载槽事件不影响播放', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
  const time = vi.fn()
  const playback = vi.fn()
  renderWithTooltip(
    <EditorPreview
      current={layoutPlay([{ mediaUrl: 'https://example.com/a.mp4', start: 5, end: 9 }])}
      currentTime={0}
      contentKey="draft"
      poster={undefined}
      backdrop={undefined}
      onTime={time}
      onPlay={() => {}}
      onPlaybackChange={playback}
      externalAudio={{ blocked: undefined }}
      overlay={null}
      viewControl={null}
      versions={null}
      tools={null}
      readout={null}
      timeline={null}
      barEnd={null}
      footnote={null}
      ref={null}
    />,
  )
  const user = userEvent.setup()
  const active = screen.getByLabelText<HTMLVideoElement>('视频播放器')
  active.currentTime = 6.25
  await user.click(screen.getByRole('button', { name: '播放' }))
  await waitFor(() => expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true }))
  fireEvent.waiting(active)
  expect(time).toHaveBeenLastCalledWith(1.25)
  expect(playback).toHaveBeenLastCalledWith({ playing: false, muted: true })
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
  // 时钟完全不变也会由 playing 事件恢复，不依赖父组件再渲染同一 clock。
  fireEvent.playing(active)
  expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true })
  fireEvent.seeking(active)
  expect(playback).toHaveBeenLastCalledWith({ playing: false, muted: true })
  fireEvent.seeked(active)
  expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true })
  const inactive = screen
    .getByLabelText('视频预览')
    .querySelector<HTMLVideoElement>('video[aria-hidden="true"]')
  if (inactive === null) throw new Error('没有预载视频槽')
  fireEvent.waiting(inactive)
  expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true })
  expect(active.muted).toBe(true)
  await act(async () => user.click(screen.getByRole('button', { name: '暂停' })))
  expect(playback).toHaveBeenLastCalledWith({ playing: false, muted: true })
})

it('切段先停在准确的整条切点，下一段实际开播后才恢复混音', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  let resume: () => void = () => {}
  const nextPlaying = new Promise<void>((resolve) => {
    resume = resolve
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play')
    .mockResolvedValueOnce(undefined)
    .mockReturnValue(nextPlaying)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
  const time = vi.fn()
  const playback = vi.fn()
  renderWithTooltip(
    <EditorPreview
      current={layoutPlay([
        { mediaUrl: 'https://example.com/a.mp4', start: 5, end: 7 },
        { mediaUrl: 'https://example.com/b.mp4', start: 8, end: 11 },
      ])}
      currentTime={0}
      contentKey="draft"
      poster={undefined}
      backdrop={undefined}
      onTime={time}
      onPlay={() => {}}
      onPlaybackChange={playback}
      externalAudio={{ blocked: undefined }}
      overlay={null}
      viewControl={null}
      versions={null}
      tools={null}
      readout={null}
      timeline={null}
      barEnd={null}
      footnote={null}
      ref={null}
    />,
  )
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '播放' }))
  await waitFor(() => expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true }))
  const first = screen.getByLabelText<HTMLVideoElement>('视频播放器')
  fireEvent.loadedMetadata(first)
  first.currentTime = 6.99
  act(() => frames.at(-1)?.(100))
  expect(time).toHaveBeenLastCalledWith(2)
  expect(playback).toHaveBeenLastCalledWith({ playing: false, muted: true })
  expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', 'https://example.com/b.mp4')
  await act(async () => resume())
  expect(time).toHaveBeenLastCalledWith(2)
  expect(playback).toHaveBeenLastCalledWith({ playing: true, muted: true })
})

it('片段播放请求等待分段与媒体加载，播放到选区末尾停止；同一请求和相同内容刷新不重播', async () => {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
  const time = vi.fn()
  const manualPlay = vi.fn()
  const props: ComponentProps<typeof EditorPreview> = {
    current: undefined,
    currentTime: 0,
    contentKey: 'current',
    poster: undefined,
    backdrop: undefined,
    onTime: time,
    onPlay: manualPlay,
    playbackRequest: { id: 1, start: 2, end: 4 },
    overlay: null,
    viewControl: null,
    versions: null,
    tools: null,
    readout: null,
    timeline: null,
    barEnd: null,
    footnote: null,
    ref: null,
  }
  const current = () =>
    layoutPlay([{ mediaUrl: 'https://example.com/clip.mp4', start: 5, end: 11 }])
  const { rerender } = renderWithTooltip(<EditorPreview {...props} />)
  expect(play).not.toHaveBeenCalled()
  rerender(<EditorPreview {...props} current={current()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '暂停' })).toBeVisible())
  const active = screen.getByLabelText<HTMLVideoElement>('视频播放器')
  act(() => frames.at(-1)?.(100))
  expect(time).toHaveBeenLastCalledWith(2)
  fireEvent.loadedMetadata(active)
  expect(active.currentTime).toBe(7)
  active.currentTime = 8.5
  act(() => frames.at(-1)?.(200))
  expect(time).toHaveBeenLastCalledWith(3.5)

  rerender(<EditorPreview {...props} current={current()} currentTime={3.5} />)
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
  expect(active.currentTime).toBe(8.5)
  expect(play).toHaveBeenCalledTimes(1)
  active.currentTime = 9.1
  act(() => frames.at(-1)?.(300))
  expect(time).toHaveBeenLastCalledWith(4)
  expect(active.currentTime).toBeCloseTo(8.999)
  expect(screen.getByRole('button', { name: '播放' })).toBeVisible()

  rerender(<EditorPreview {...props} current={current()} currentTime={4} />)
  expect(play).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '播放' })).toBeVisible()
  rerender(
    <EditorPreview
      {...props}
      current={current()}
      currentTime={4}
      playbackRequest={{ id: 2, start: 1, end: 2 }}
    />,
  )
  await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
  expect(active.currentTime).toBe(6)
  expect(time).toHaveBeenLastCalledWith(1)
  expect(manualPlay).not.toHaveBeenCalled()
})

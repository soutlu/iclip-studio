import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { EditorPreview, type EditorPreviewHandle } from './editor-preview'
import { layoutPlay } from './play-layout'

afterEach(() => vi.restoreAllMocks())

describe('视频下载', () => {
  const renderPreview = (
    current: ComponentProps<typeof EditorPreview>['current'],
    onDownloadSettled = vi.fn<() => void>(),
  ) => {
    renderWithTooltip(
      <EditorPreview
        current={current}
        currentTime={0}
        contentKey="draft"
        poster={undefined}
        backdrop={undefined}
        onDownloadSettled={onDownloadSettled}
        onTime={() => {}}
        onPlay={() => {}}
        overlay={null}
        readout={null}
        timeline={null}
        barStart={null}
        barNotice={null}
        barTools={null}
        barEnd={null}
        ref={null}
      />,
    )
    return onDownloadSettled
  }
  const twoSegments = () =>
    layoutPlay([
      { mediaUrl: 'https://example.com/a.mp4', start: 0, end: 2 },
      { mediaUrl: 'https://example.com/b.mp4', start: 0, end: 2 },
    ])
  const videos = () => {
    const stage = screen.getByLabelText('视频预览')
    const hidden = stage.querySelector<HTMLVideoElement>('video[aria-hidden="true"]')
    if (hidden === null) throw new Error('没有预载视频槽')
    return { active: screen.getByLabelText<HTMLVideoElement>('视频播放器'), hidden }
  }

  it('两个视频都跨域加载，才能和读关键帧、波形的请求共用浏览器缓存', () => {
    renderPreview(twoSegments())
    const { active, hidden } = videos()
    expect(active).toHaveAttribute('crossorigin', 'anonymous')
    expect(hidden).toHaveAttribute('crossorigin', 'anonymous')
  })

  const reportNetwork = (video: HTMLVideoElement, state: number) =>
    Object.defineProperty(video, 'networkState', { configurable: true, value: state })
  const failLoading = (video: HTMLVideoElement) => {
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } })
    reportNetwork(video, HTMLMediaElement.NETWORK_NO_SOURCE)
    fireEvent.error(video)
  }

  it('当前视频还没开始下载或还在下载时不通知', () => {
    const settled = renderPreview(twoSegments())
    const { active } = videos()
    // 刚赋 src 时是 NO_SOURCE，真正开始加载才变 LOADING
    reportNetwork(active, HTMLMediaElement.NETWORK_NO_SOURCE)
    fireEvent.suspend(active)
    reportNetwork(active, HTMLMediaElement.NETWORK_LOADING)
    fireEvent.suspend(active)
    expect(settled).not.toHaveBeenCalled()
  })

  it('当前视频停止缓冲时通知，可以通知多次', () => {
    const settled = renderPreview(twoSegments())
    const { active } = videos()
    expect(settled).not.toHaveBeenCalled()
    reportNetwork(active, HTMLMediaElement.NETWORK_IDLE)
    fireEvent.suspend(active)
    expect(settled).toHaveBeenCalledTimes(1)
    fireEvent.suspend(active)
    expect(settled).toHaveBeenCalledTimes(2)
  })

  it('预载槽停止缓冲不算', () => {
    const settled = renderPreview(twoSegments())
    const { active, hidden } = videos()
    reportNetwork(active, HTMLMediaElement.NETWORK_LOADING)
    reportNetwork(hidden, HTMLMediaElement.NETWORK_IDLE)
    fireEvent.suspend(hidden)
    expect(settled).not.toHaveBeenCalled()
  })

  it('当前视频加载失败时通知，预载槽失败不算', () => {
    const settled = renderPreview(twoSegments())
    const { active, hidden } = videos()
    reportNetwork(active, HTMLMediaElement.NETWORK_LOADING)
    failLoading(hidden)
    expect(settled).not.toHaveBeenCalled()
    failLoading(active)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('没有内容可加载时直接通知；内容还在读取时不通知', () => {
    expect(renderPreview(layoutPlay([]))).toHaveBeenCalledTimes(1)
    expect(renderPreview(undefined)).not.toHaveBeenCalled()
  })
})

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
      readout={null}
      timeline={null}
      barStart={null}
      barNotice={null}
      barTools={null}
      barEnd={null}
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
      readout={null}
      timeline={null}
      barStart={null}
      barNotice={null}
      barTools={null}
      barEnd={null}
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

it('外部切换播放：从播放头播到结尾停下，停在结尾再播从头开始，再切一次暂停；没有视频时不起播', async () => {
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
  const started = vi.fn()
  const handle = createRef<EditorPreviewHandle>()
  const props: ComponentProps<typeof EditorPreview> = {
    current: undefined,
    currentTime: 0,
    contentKey: 'current',
    poster: undefined,
    backdrop: undefined,
    onTime: time,
    onPlay: started,
    overlay: null,
    readout: null,
    timeline: null,
    barStart: null,
    barNotice: null,
    barTools: null,
    barEnd: null,
    ref: handle,
  }
  const current = () => layoutPlay([{ mediaUrl: 'https://example.com/clip.mp4', start: 5, end: 9 }])
  const { rerender } = renderWithTooltip(<EditorPreview {...props} />)
  act(() => handle.current?.toggle())
  expect(screen.getByRole('button', { name: '播放' })).toBeVisible()
  expect(started).not.toHaveBeenCalled()

  rerender(<EditorPreview {...props} current={current()} currentTime={1.5} />)
  const active = screen.getByLabelText<HTMLVideoElement>('视频播放器')
  fireEvent.loadedMetadata(active)
  act(() => handle.current?.toggle())
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
  expect(started).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
  // 定位到某一刻时媒体往后多走 0.001 秒，停在帧边界上也显示这一刻的帧
  expect(active.currentTime).toBeCloseTo(6.501, 6)
  active.currentTime = 9
  act(() => frames.at(-1)?.(100))
  expect(time).toHaveBeenLastCalledWith(4)
  expect(active.currentTime).toBeCloseTo(8.999)
  expect(screen.getByRole('button', { name: '播放' })).toBeVisible()

  rerender(<EditorPreview {...props} current={current()} currentTime={4} />)
  act(() => handle.current?.toggle())
  expect(time).toHaveBeenLastCalledWith(0)
  expect(active.currentTime).toBeCloseTo(5.001, 6)
  expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
  act(() => handle.current?.toggle())
  expect(screen.getByRole('button', { name: '播放' })).toBeVisible()
  expect(started).toHaveBeenCalledTimes(2)
})

it('定位：媒体定到这一刻往后 0.001 秒，停在结尾一端时往前 0.001 秒；对外报的时间不变', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
  const time = vi.fn()
  const handle = createRef<EditorPreviewHandle>()
  renderWithTooltip(
    <EditorPreview
      current={layoutPlay([{ mediaUrl: 'https://example.com/clip.mp4', start: 5, end: 9 }])}
      currentTime={0}
      contentKey="current"
      poster={undefined}
      backdrop={undefined}
      onTime={time}
      onPlay={() => {}}
      overlay={null}
      readout={null}
      timeline={null}
      barStart={null}
      barNotice={null}
      barTools={null}
      barEnd={null}
      ref={handle}
    />,
  )
  const active = screen.getByLabelText<HTMLVideoElement>('视频播放器')
  fireEvent.loadedMetadata(active)
  act(() => handle.current?.previewAt(2))
  expect(active.currentTime).toBeCloseTo(7.001, 6)
  expect(time).toHaveBeenLastCalledWith(2)
  act(() => handle.current?.previewAt(3, 'end'))
  expect(active.currentTime).toBeCloseTo(7.999, 6)
  expect(time).toHaveBeenLastCalledWith(3)
})

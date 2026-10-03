import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { VideoPlayer } from './video-player'

const SRC = 'https://videos.example.test/take.mp4'

/** jsdom 不播放媒体：play / pause 改成立即切换 paused 并发出对应事件，与浏览器一致。 */
const stubPlayback = () => {
  const paused = new WeakMap<HTMLMediaElement, boolean>()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    return paused.get(this) ?? true
  })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    paused.set(this, false)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    const wasPlaying = paused.get(this) === false
    paused.set(this, true)
    if (wasPlaying) this.dispatchEvent(new Event('pause'))
  })
  return { play, pause }
}

/** 读到元数据：给出时长。 */
const loadMetadata = (video: HTMLVideoElement, duration: number) => {
  Object.defineProperty(video, 'duration', { configurable: true, value: duration })
  fireEvent.loadedMetadata(video)
}

const videoOf = () => screen.getByLabelText<HTMLVideoElement>('成片', { selector: 'video' })
const rootOf = () => screen.getByRole('group', { name: '播放器：成片' })

describe('VideoPlayer', () => {
  let playback: ReturnType<typeof stubPlayback>
  beforeEach(() => {
    playback = stubPlayback()
  })

  it('不带原生控件：没有全屏与画中画入口，单击画面切换播放', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<VideoPlayer label="成片" src={SRC} />)
    const video = videoOf()
    expect(video.controls).toBe(false)
    expect(video).toHaveAttribute('disablepictureinpicture')

    await user.click(video)
    expect(playback.play).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()

    await user.click(video)
    expect(playback.pause).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '播放' })).toBeVisible()
  })

  it('双击画面：两下切换相互抵消，暂停后交出当时的秒数', async () => {
    const onExpand = vi.fn()
    const user = userEvent.setup()
    renderWithTooltip(<VideoPlayer label="成片" onExpand={onExpand} src={SRC} />)
    const video = videoOf()
    loadMetadata(video, 10)
    video.currentTime = 3

    await user.dblClick(video)

    expect(onExpand).toHaveBeenCalledExactlyOnceWith(3)
    expect(video.paused).toBe(true)

    video.currentTime = 4
    await user.click(screen.getByRole('button', { name: '放大' }))
    expect(onExpand).toHaveBeenLastCalledWith(4)
  })

  it('触屏快速点两下也放大：Safari 的点按 detail 恒为 1，按时间自己数', () => {
    const onExpand = vi.fn()
    renderWithTooltip(<VideoPlayer label="成片" onExpand={onExpand} src={SRC} />)
    const video = videoOf()
    const tap = () => {
      fireEvent.pointerDown(video, { pointerType: 'touch' })
      fireEvent.click(video, { clientX: 10, clientY: 10, detail: 1 })
    }

    tap()
    expect(playback.play).toHaveBeenCalledOnce()
    expect(onExpand).not.toHaveBeenCalled()
    tap()

    expect(onExpand).toHaveBeenCalledOnce()
    expect(video.paused).toBe(true)
  })

  it('宿主没给放大时不出放大按钮，双击只是切换两次', async () => {
    const user = userEvent.setup()
    renderWithTooltip(<VideoPlayer label="成片" src={SRC} />)

    await user.dblClick(videoOf())

    expect(screen.queryByRole('button', { name: '放大' })).not.toBeInTheDocument()
    expect(playback.play).toHaveBeenCalledOnce()
    expect(playback.pause).toHaveBeenCalledOnce()
  })

  it('快捷键只在焦点落在播放器里时生效，并拦下浏览器默认行为', async () => {
    const user = userEvent.setup()
    renderWithTooltip(
      <>
        <button type="button">别处</button>
        <VideoPlayer label="成片" src={SRC} />
      </>,
    )
    const video = videoOf()
    loadMetadata(video, 10)
    video.currentTime = 2

    const outside = screen.getByRole('button', { name: '别处' })
    act(() => outside.focus())
    expect(fireEvent.keyDown(outside, { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(outside, { key: 'ArrowRight' })).toBe(true)
    expect(playback.play).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(2)

    const root = rootOf()
    act(() => root.focus())
    expect(fireEvent.keyDown(root, { key: 'ArrowRight' })).toBe(false)
    expect(video.currentTime).toBe(7)
    expect(fireEvent.keyDown(root, { key: 'ArrowLeft' })).toBe(false)
    expect(video.currentTime).toBe(2)
    expect(fireEvent.keyDown(root, { key: 'End' })).toBe(false)
    expect(video.currentTime).toBe(10)
    expect(fireEvent.keyDown(root, { key: 'Home' })).toBe(false)
    expect(video.currentTime).toBe(0)
    expect(fireEvent.keyDown(root, { key: 'm' })).toBe(false)
    expect(video.muted).toBe(true)
    expect(fireEvent.keyDown(root, { key: ' ' })).toBe(false)
    expect(playback.play).toHaveBeenCalledOnce()
    expect(fireEvent.keyDown(root, { key: 'k' })).toBe(false)
    expect(playback.pause).toHaveBeenCalledOnce()
    // 带修饰键的组合留给浏览器
    expect(fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true })).toBe(true)
    expect(video.currentTime).toBe(0)

    // 焦点在控件条按钮上：方向键照样跳转，空格只按一次按钮
    const play = screen.getByRole('button', { name: '播放' })
    act(() => play.focus())
    await user.keyboard('{ArrowRight}')
    expect(video.currentTime).toBe(5)
    await user.keyboard(' ')
    expect(playback.play).toHaveBeenCalledTimes(2)
  })
})

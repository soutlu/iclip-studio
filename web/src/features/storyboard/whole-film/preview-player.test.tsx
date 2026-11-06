import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferedVideos,
  clearFailedVideos,
  emitFrom,
  failVideo,
  finishBuffering,
  starvedVideos,
} from '@/testing/hyperframes-player'
import { PreviewPlayer, type PreviewControl } from './preview-player'

const FIRST = 'https://oss/first.mp4'
const SECOND = 'https://oss/second.mp4'

const page = (suffix = '') =>
  `<!doctype html><html><head></head><body>${suffix}` +
  `<video src="${FIRST}" data-start="0" data-duration="2"></video>` +
  `<video src="${SECOND}" data-start="2" data-duration="2"></video></body></html>`

type Player = HTMLElement & {
  paused: boolean
  seek: (seconds: number) => void
}

const playerOf = () => {
  const player = screen.getByRole('region', { name: '预览' }).querySelector('hyperframes-player')
  if (player === null) throw new Error('没有播放器')
  return player as Player
}

const preview = (srcdoc: string, on: ReturnType<typeof handlers>) => (
  <PreviewPlayer
    backdrop={undefined}
    controlRef={on.control}
    height={320}
    message={undefined}
    onBuffering={on.onBuffering}
    onFrame={on.onFrame}
    onPlaying={on.onPlaying}
    onTime={() => {}}
    srcdoc={srcdoc}
    width={180}
  />
)

const handlers = () => ({
  control: createRef<PreviewControl>() as { current: PreviewControl | null },
  onBuffering: vi.fn<(buffering: boolean) => void>(),
  onFrame: vi.fn<(iframe: HTMLIFrameElement | null) => void>(),
  onPlaying: vi.fn<(playing: boolean) => void>(),
})

/** 挂上预览，等播放器换上来；播放器记下 play 事件的次数。 */
const openPreview = async (srcdoc = page()) => {
  const on = handlers()
  const view = render(preview(srcdoc, on))
  await waitFor(() => expect(on.control.current).not.toBeNull())
  const plays = vi.fn()
  playerOf().addEventListener('play', plays)
  const control = () => {
    if (on.control.current === null) throw new Error('播放器没接上')
    return on.control.current
  }
  const showPage = (srcdoc: string) => view.rerender(preview(srcdoc, on))
  return { ...on, view, plays, control, showPage }
}

afterEach(() => {
  starvedVideos.clear()
  bufferedVideos.clear()
  clearFailedVideos()
})

describe('缓冲够了就继续', () => {
  /** 时间线第 0 秒起的片段，取素材的 1–9 秒。 */
  const LONG_CLIP = `<!doctype html><html><head></head><body><video src="${FIRST}" data-start="0" data-duration="8" data-media-start="1"></video></body></html>`

  /** 播到片段里素材的第 `at` 秒时数据不够，时间线停下等待。 */
  const waitAt = async (at: number) => {
    const opened = await openPreview(LONG_CLIP)
    const video = playerOf()
      .querySelector('iframe')
      ?.contentDocument?.querySelector<HTMLVideoElement>('video')
    if (video === null || video === undefined) throw new Error('合成页里没有视频')
    video.currentTime = at
    starvedVideos.add(FIRST)
    act(() => opened.control().play())
    expect(opened.onBuffering).toHaveBeenLastCalledWith(true)
    return opened
  }
  /** 浏览器报告这些缓冲段，视频数据也够接着播了。 */
  const report = (ranges: readonly (readonly [number, number])[], event = 'progress') => {
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, ranges)
    act(() => emitFrom(FIRST, event))
  }

  it('当前位置往后不足 3 秒不继续，够 3 秒就继续', async () => {
    const { plays, onBuffering } = await waitAt(2)
    report([[1, 4.9]])
    expect(plays).not.toHaveBeenCalled()
    expect(onBuffering).toHaveBeenLastCalledWith(true)

    report([[1, 5]])
    expect(plays).toHaveBeenCalledTimes(1)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
  })

  it.each(['progress', 'canplay', 'seeked'])('%s 时检查缓冲', async (event) => {
    const { plays } = await waitAt(2)
    report([[2, 6]], event)
    expect(plays).toHaveBeenCalledTimes(1)
  })

  it('片段剩下不足 3 秒时，缓冲到片段结束就继续；片段结束按素材起点算', async () => {
    const { plays } = await waitAt(7.5)
    report([[7, 8.9]])
    expect(plays).not.toHaveBeenCalled()

    report([[7, 9]])
    expect(plays).toHaveBeenCalledTimes(1)
  })

  it('当前位置已过片段结束时，到不了当前位置的缓冲段也不算', async () => {
    const { plays } = await waitAt(9.5)
    report([[1, 9.2]])
    expect(plays).not.toHaveBeenCalled()
  })

  it('不覆盖当前位置的缓冲段不算', async () => {
    const { plays } = await waitAt(2)
    report([
      [0, 1],
      [2.5, 8],
    ])
    expect(plays).not.toHaveBeenCalled()

    report([
      [0, 1],
      [2.04, 8],
    ])
    expect(plays).toHaveBeenCalledTimes(1)
  })

  it('缓冲段够了但视频还没到能往下放的状态，不继续', async () => {
    const { plays } = await waitAt(2)
    bufferedVideos.set(FIRST, [[1, 8]])
    act(() => emitFrom(FIRST, 'progress'))
    expect(plays).not.toHaveBeenCalled()
  })

  it('canplaythrough 不看缓冲段，直接继续', async () => {
    const { plays } = await waitAt(2)
    bufferedVideos.set(FIRST, [[2, 2.5]])
    act(() => finishBuffering(FIRST))
    expect(plays).toHaveBeenCalledTimes(1)
  })

  it('error 不看缓冲段，直接继续', async () => {
    const { plays } = await waitAt(2)
    act(() => failVideo(FIRST))
    expect(plays).toHaveBeenCalledTimes(1)
  })

  it('用户暂停后缓冲够了也不继续，也不再报缓冲', async () => {
    const { control, plays, onBuffering } = await waitAt(2)
    act(() => control().pause())
    const calls = onBuffering.mock.calls.length
    report([[1, 8]])
    expect(plays).not.toHaveBeenCalled()
    expect(onBuffering).toHaveBeenCalledTimes(calls)
  })
})

describe('预览缓冲', () => {
  it('数据足够时直接播放，不进入缓冲', async () => {
    const { control, plays, onBuffering, onPlaying } = await openPreview()
    act(() => control().play())
    expect(plays).toHaveBeenCalledTimes(1)
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).not.toHaveBeenCalled()
    expect(onPlaying).toHaveBeenLastCalledWith(true)
  })

  it('当前片段数据不够时点播放：先不播，按钮算在放，够了才播', async () => {
    const { control, plays, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    expect(plays).not.toHaveBeenCalled()
    expect(playerOf().paused).toBe(true)
    expect(onBuffering).toHaveBeenLastCalledWith(true)
    expect(onPlaying).toHaveBeenCalledWith(true)
    expect(onPlaying).not.toHaveBeenCalledWith(false)

    act(() => finishBuffering(FIRST))
    expect(plays).toHaveBeenCalledTimes(1)
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
  })

  it('播放中切入数据不够的片段：时间线停下，onPlaying 不收到 false，够了接着放', async () => {
    const { control, plays, onBuffering, onPlaying } = await openPreview()
    act(() => control().play())
    starvedVideos.add(SECOND)
    act(() => playerOf().seek(2.5))
    expect(playerOf().paused).toBe(true)
    expect(onBuffering).toHaveBeenLastCalledWith(true)
    expect(onPlaying).not.toHaveBeenCalledWith(false)

    act(() => finishBuffering(SECOND))
    expect(playerOf().paused).toBe(false)
    expect(plays).toHaveBeenCalledTimes(2)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('只有当前片段算数：别的片段数据不够不进入缓冲', async () => {
    const { control, plays, onBuffering } = await openPreview()
    starvedVideos.add(SECOND)
    act(() => control().play())
    act(() => playerOf().seek(1))
    expect(plays).toHaveBeenCalledTimes(1)
    expect(onBuffering).not.toHaveBeenCalled()
  })

  it('缓冲中用户暂停：结束等待，按钮回到播放，够了也不恢复', async () => {
    const { control, plays, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => control().pause())
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).toHaveBeenLastCalledWith(false)

    act(() => finishBuffering(FIRST))
    expect(plays).not.toHaveBeenCalled()
    expect(playerOf().paused).toBe(true)
  })

  it('缓冲中拖动：结束等待，够了也不恢复', async () => {
    const { control, plays, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => control().seek(500))
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).toHaveBeenLastCalledWith(false)

    act(() => finishBuffering(FIRST))
    expect(plays).not.toHaveBeenCalled()
  })

  it('视频出错：结束等待并继续，之后不再为它转圈', async () => {
    const { control, plays, onBuffering } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => failVideo(FIRST))
    expect(plays).toHaveBeenCalledTimes(1)
    expect(onBuffering).toHaveBeenLastCalledWith(false)

    act(() => playerOf().seek(0.5))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenCalledTimes(2)
  })

  it('缓冲中换页：结束等待，新页接着放', async () => {
    const { control, onBuffering, showPage } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    const old = playerOf()

    starvedVideos.clear()
    showPage(page('<p></p>'))
    await waitFor(() => expect(playerOf()).not.toBe(old))
    await waitFor(() => expect(playerOf().paused).toBe(false))
    expect(onBuffering).toHaveBeenLastCalledWith(false)
  })

  it('卸载时不再等：够了也不恢复', async () => {
    const { control, view, plays } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    const video = playerOf().querySelector('iframe')?.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('合成页里没有视频')
    view.unmount()
    video.dispatchEvent(new Event('canplaythrough'))
    expect(plays).not.toHaveBeenCalled()
  })
})

import { act, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bufferedVideos,
  clearFailedVideos,
  downloadingVideos,
  emitFrom,
  failVideo,
  finishBuffering,
  starvedVideos,
  stopVideoDownload,
  type FakeParentMedia,
} from '@/testing/hyperframes-player'
import { PreviewPlayer, type PreviewControl } from './preview-player'

const FIRST = 'https://oss/first.mp4'
const SECOND = 'https://oss/second.mp4'

/** 时间线 0–2 秒是第一段，2–4 秒是第二段。 */
const page = (suffix = '') =>
  `<!doctype html><html><head></head><body>${suffix}` +
  `<video src="${FIRST}" data-start="0" data-duration="2"></video>` +
  `<video src="${SECOND}" data-start="2" data-duration="2"></video></body></html>`

/** 时间线第 0 秒起的片段，取素材的 1–9 秒。 */
const LONG_CLIP = `<!doctype html><html><head></head><body><video src="${FIRST}" data-start="0" data-duration="8" data-media-start="1"></video></body></html>`

type Player = HTMLElement & {
  paused: boolean
  currentTime: number
  duration: number
  seek: (seconds: number) => void
  iframeElement: HTMLIFrameElement
  _media: FakeParentMedia
}

const playerOf = () => {
  const player = screen.getByRole('region', { name: '预览' }).querySelector('hyperframes-player')
  if (player === null) throw new Error('没有播放器')
  return player as Player
}

const handlers = () => ({
  control: createRef<PreviewControl>() as { current: PreviewControl | null },
  onBuffering: vi.fn<(buffering: boolean) => void>(),
  onFrame: vi.fn<(iframe: HTMLIFrameElement | null) => void>(),
  onMediaSettled: vi.fn<() => void>(),
  onPlaying: vi.fn<(playing: boolean) => void>(),
})

const preview = (srcdoc: string, on: ReturnType<typeof handlers>) => (
  <PreviewPlayer
    backdrop={undefined}
    controlRef={on.control}
    height={320}
    message={undefined}
    onBuffering={on.onBuffering}
    onFrame={on.onFrame}
    onMediaSettled={on.onMediaSettled}
    onPlaying={on.onPlaying}
    onTime={() => {}}
    srcdoc={srcdoc}
    width={180}
  />
)

/** 挂上预览，等播放器换上来。 */
const openPreview = async (srcdoc = page()) => {
  const on = handlers()
  const view = render(preview(srcdoc, on))
  await waitFor(() => expect(on.control.current).not.toBeNull())
  const control = () => {
    if (on.control.current === null) throw new Error('播放器没接上')
    return on.control.current
  }
  const showPage = (next: string) => view.rerender(preview(next, on))
  return { ...on, view, control, showPage }
}

afterEach(() => {
  vi.unstubAllGlobals()
  starvedVideos.clear()
  downloadingVideos.clear()
  bufferedVideos.clear()
  clearFailedVideos()
})

describe('每个文件只下载一份', () => {
  it('播放器不建父页面副本', async () => {
    await openPreview()
    expect(playerOf()._media.entries).toEqual([])
  })

  it('换页后的新播放器同样不建', async () => {
    const { showPage } = await openPreview()
    const old = playerOf()
    showPage(page('<p></p>'))
    await waitFor(() => expect(playerOf()).not.toBe(old))
    expect(playerOf()._media.entries).toEqual([])
  })
})

describe('时钟跟着画面走', () => {
  it('数据足够时直接放，不转圈', async () => {
    const { control, onBuffering, onPlaying } = await openPreview()
    act(() => control().play())
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).not.toHaveBeenCalled()
    expect(onPlaying).toHaveBeenLastCalledWith(true)
  })

  it('还在下载、缓冲不多但够往下放时不停：要等 3 秒的只有已经停下等待的时候', async () => {
    const { control, onBuffering } = await openPreview()
    downloadingVideos.add(FIRST)
    bufferedVideos.set(FIRST, [[0, 0.5]])
    act(() => control().play())
    act(() => playerOf().seek(0.1))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).not.toHaveBeenCalled()
  })

  it('点播放时当前片段数据不够：时间线不走，按钮算在放；够了自动继续', async () => {
    const { control, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    expect(playerOf().paused).toBe(true)
    expect(onBuffering).toHaveBeenLastCalledWith(true)
    expect(onPlaying).toHaveBeenLastCalledWith(true)

    act(() => finishBuffering(FIRST))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('播放中走进数据不够的片段：时间线停下，够了自动继续，onPlaying 不收到 false', async () => {
    const { control, onBuffering, onPlaying } = await openPreview()
    act(() => control().play())
    starvedVideos.add(SECOND)
    act(() => playerOf().seek(2.5))
    expect(playerOf().paused).toBe(true)
    expect(onBuffering).toHaveBeenLastCalledWith(true)

    act(() => finishBuffering(SECOND))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('状态不变时不重复报缓冲', async () => {
    const { control, onBuffering } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => emitFrom(FIRST, 'progress'))
    act(() => emitFrom(FIRST, 'progress'))
    expect(onBuffering).toHaveBeenCalledTimes(1)
  })

  it('只看当前片段：别的片段数据不够不停', async () => {
    const { control, onBuffering } = await openPreview()
    starvedVideos.add(SECOND)
    act(() => control().play())
    act(() => playerOf().seek(1))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).not.toHaveBeenCalled()
  })

  it('当前时刻没有视频片段（组件段）时不停', async () => {
    const { control, onBuffering } = await openPreview()
    starvedVideos.add(FIRST).add(SECOND)
    act(() => playerOf().seek(5))
    act(() => control().play())
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).not.toHaveBeenCalled()
  })

  it('出错的片段不卡住：等待中出错接着放，之后不再为它转圈', async () => {
    const { control, onBuffering } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => failVideo(FIRST))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenLastCalledWith(false)

    act(() => playerOf().seek(0.5))
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenCalledTimes(2)
  })

  it('播放中点暂停：时间线停下，按钮回到播放', async () => {
    const { control, onPlaying } = await openPreview()
    act(() => control().play())
    act(() => control().pause())
    expect(playerOf().paused).toBe(true)
    expect(onPlaying).toHaveBeenLastCalledWith(false)
  })

  it('缓冲中用户暂停：不再转圈，按钮回到播放，够了也不恢复', async () => {
    const { control, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => control().pause())
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).toHaveBeenLastCalledWith(false)

    act(() => finishBuffering(FIRST))
    expect(playerOf().paused).toBe(true)
  })

  it('缓冲中拖动：不再转圈，够了也不恢复', async () => {
    const { control, onBuffering, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    act(() => control().seek(500))
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    expect(onPlaying).toHaveBeenLastCalledWith(false)

    act(() => finishBuffering(FIRST))
    expect(playerOf().paused).toBe(true)
  })

  it('播放中拖动：停在拖到的地方', async () => {
    const { control } = await openPreview()
    act(() => control().play())
    act(() => control().seek(1000))
    expect(playerOf().paused).toBe(true)
  })

  it('放到结尾：停在结尾不跳回开头，按钮回到播放，之后的事件不会重新放起来', async () => {
    const { control, onPlaying } = await openPreview()
    act(() => control().play())
    const player = playerOf()
    player.duration = 4
    // 真播放器到结尾时先停下、报出时刻，ended 随后才来
    act(() => {
      player.paused = true
      player.seek(4)
    })
    expect(player.paused).toBe(true)
    expect(player.currentTime).toBe(4)

    act(() => {
      player.dispatchEvent(new Event('ended'))
    })
    expect(onPlaying).toHaveBeenLastCalledWith(false)

    act(() => emitFrom(FIRST, 'progress'))
    expect(player.paused).toBe(true)
    expect(player.currentTime).toBe(4)
  })

  it('在结尾点播放：从头放', async () => {
    const { control } = await openPreview()
    const player = playerOf()
    player.duration = 4
    act(() => control().seek(4000))
    act(() => control().play())
    expect(player.currentTime).toBe(0)
    expect(player.paused).toBe(false)
  })
})

describe('换页', () => {
  it('在放时换页：新页接着放', async () => {
    const { control, showPage, onPlaying } = await openPreview()
    act(() => control().play())
    const old = playerOf()
    showPage(page('<p></p>'))
    await waitFor(() => expect(playerOf()).not.toBe(old))
    await waitFor(() => expect(playerOf().paused).toBe(false))
    expect(onPlaying).not.toHaveBeenCalledWith(false)
  })

  it('停着时换页：新页也停着', async () => {
    const { showPage } = await openPreview()
    const old = playerOf()
    showPage(page('<p></p>'))
    await waitFor(() => expect(playerOf()).not.toBe(old))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(playerOf().paused).toBe(true)
  })

  it('缓冲中换页：不再转圈，新页接着放', async () => {
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

  it('新页加载期间旧播放器停着：媒体事件不会把它放起来', async () => {
    const { control, showPage } = await openPreview()
    act(() => control().play())
    const old = playerOf()
    // 换页要等几帧：不给帧，新播放器就一直停在待换上的状态
    vi.stubGlobal('requestAnimationFrame', () => 0)
    showPage(page('<p></p>'))
    await waitFor(() => expect(document.querySelectorAll('hyperframes-player')).toHaveLength(2))
    await waitFor(() => expect(old.paused).toBe(true))

    act(() => emitFrom(FIRST, 'progress'))
    expect(old.paused).toBe(true)
  })

  it('合成不了时：不再放，也不再转圈', async () => {
    const on = handlers()
    const view = render(preview(page(), on))
    await waitFor(() => expect(on.control.current).not.toBeNull())
    starvedVideos.add(FIRST)
    act(() => on.control.current?.play())
    const shown = playerOf()

    view.rerender(
      <PreviewPlayer
        backdrop={undefined}
        controlRef={on.control}
        height={320}
        message="合成不了"
        onBuffering={on.onBuffering}
        onFrame={on.onFrame}
        onPlaying={on.onPlaying}
        onTime={() => {}}
        srcdoc={undefined}
        width={180}
      />,
    )
    expect(on.onBuffering).toHaveBeenLastCalledWith(false)
    expect(on.onPlaying).toHaveBeenLastCalledWith(false)
    act(() => finishBuffering(FIRST))
    expect(shown.paused).toBe(true)
  })
})

describe('缓冲够了才继续', () => {
  /** 播到片段里素材的第 `at` 秒时数据不够，时间线停下等待；视频还在下载。 */
  const waitAt = async (at: number) => {
    const opened = await openPreview(LONG_CLIP)
    const video = playerOf().iframeElement.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('合成页里没有视频')
    video.currentTime = at
    starvedVideos.add(FIRST)
    downloadingVideos.add(FIRST)
    act(() => opened.control().play())
    expect(opened.onBuffering).toHaveBeenLastCalledWith(true)
    return opened
  }
  /** 浏览器报告这些缓冲段，视频也到了能往下放的状态。 */
  const report = (ranges: readonly (readonly [number, number])[], event = 'progress') => {
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, ranges)
    act(() => emitFrom(FIRST, event))
  }

  it('当前位置往后不足 3 秒不继续，够 3 秒就继续', async () => {
    const { onBuffering } = await waitAt(2)
    report([[1, 4.9]])
    expect(playerOf().paused).toBe(true)
    expect(onBuffering).toHaveBeenLastCalledWith(true)

    report([[1, 5]])
    expect(playerOf().paused).toBe(false)
    expect(onBuffering).toHaveBeenLastCalledWith(false)
  })

  it.each(['progress', 'canplay', 'seeked'])('%s 时检查缓冲', async (event) => {
    await waitAt(2)
    report([[2, 6]], event)
    expect(playerOf().paused).toBe(false)
  })

  it('片段剩下不足 3 秒时，缓冲到片段结束就继续；片段结束按素材起点算', async () => {
    await waitAt(7.5)
    report([[7, 8.9]])
    expect(playerOf().paused).toBe(true)

    report([[7, 9]])
    expect(playerOf().paused).toBe(false)
  })

  it('当前位置已过片段结束时，到不了当前位置的缓冲段不算', async () => {
    await waitAt(9.5)
    report([[1, 9.2]])
    expect(playerOf().paused).toBe(true)
  })

  it('不覆盖当前位置的缓冲段不算', async () => {
    await waitAt(2)
    report([
      [0, 1],
      [2.5, 8],
    ])
    expect(playerOf().paused).toBe(true)

    report([
      [0, 1],
      [2.04, 8],
    ])
    expect(playerOf().paused).toBe(false)
  })

  it('缓冲段够了但视频还没到能往下放的状态，不继续', async () => {
    await waitAt(2)
    bufferedVideos.set(FIRST, [[1, 8]])
    act(() => emitFrom(FIRST, 'progress'))
    expect(playerOf().paused).toBe(true)
  })

  it('一旦进入等待，刚够播放还不算，要等到缓冲够', async () => {
    await waitAt(2)
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, [[2, 2.5]])
    act(() => emitFrom(FIRST, 'canplay'))
    expect(playerOf().paused).toBe(true)
  })

  it('下载已停时不等缓冲段：下完的文件 buffered 可能够不到结尾，不会再有新数据', async () => {
    await waitAt(7.5)
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, [[7, 8.6]])
    act(() => stopVideoDownload(FIRST))
    expect(playerOf().paused).toBe(false)
  })

  it('下载已停但视频还不能往下放时不继续', async () => {
    await waitAt(2)
    act(() => stopVideoDownload(FIRST))
    expect(playerOf().paused).toBe(true)
  })
})

describe('波形等视频都停止下载', () => {
  it('挂上时都没在下载：立即通知', async () => {
    const { onMediaSettled } = await openPreview()
    expect(onMediaSettled).toHaveBeenCalled()
  })

  it('还有视频在下载时不通知，全部停下才通知', async () => {
    downloadingVideos.add(FIRST).add(SECOND)
    const { onMediaSettled } = await openPreview()
    expect(onMediaSettled).not.toHaveBeenCalled()

    act(() => stopVideoDownload(FIRST))
    expect(onMediaSettled).not.toHaveBeenCalled()

    act(() => stopVideoDownload(SECOND))
    expect(onMediaSettled).toHaveBeenCalled()
  })

  it('视频出错算不再下载', async () => {
    downloadingVideos.add(FIRST)
    const { onMediaSettled } = await openPreview()
    downloadingVideos.delete(FIRST)
    act(() => failVideo(FIRST))
    expect(onMediaSettled).toHaveBeenCalled()
  })

  it('页里没有视频时不通知', async () => {
    const { onMediaSettled } = await openPreview('<!doctype html><html><body></body></html>')
    expect(onMediaSettled).not.toHaveBeenCalled()
  })
})

describe('卸载', () => {
  it('卸载后事件不再有回调，也不再放', async () => {
    const { control, view, onBuffering, onMediaSettled, onPlaying } = await openPreview()
    starvedVideos.add(FIRST)
    act(() => control().play())
    const player = playerOf()
    const video = player.iframeElement.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('合成页里没有视频')
    view.unmount()
    expect(onBuffering).toHaveBeenLastCalledWith(false)
    const calls = [onBuffering, onMediaSettled, onPlaying].map((fn) => fn.mock.calls.length)

    starvedVideos.delete(FIRST)
    video.dispatchEvent(new Event('progress'))
    video.dispatchEvent(new Event('suspend'))
    player.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 1 } }))
    player.dispatchEvent(new Event('ended'))

    expect(player.paused).toBe(true)
    expect([onBuffering, onMediaSettled, onPlaying].map((fn) => fn.mock.calls.length)).toEqual(
      calls,
    )
  })
})

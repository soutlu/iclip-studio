import { waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
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
import { server } from '@/testing/mocks/server'
import { bootPreviewPage, createPreviewPage } from './preview-page'
import type { PreviewCommand, PreviewEvent } from './preview-protocol'

const RUNTIME = 'https://preview.example.com/hyperframes/v1/vendor/runtime.js'

const FIRST = 'https://oss/first.mp4'
const SECOND = 'https://oss/second.mp4'

const film = (suffix = '') =>
  `<!doctype html><html><head></head><body>${suffix}` +
  `<video src="${FIRST}" data-start="0" data-duration="2"></video>` +
  `<video src="${SECOND}" data-start="2" data-duration="2"></video></body></html>`

const LONG_CLIP = `<!doctype html><html><head></head><body><video src="${FIRST}" data-start="0" data-duration="8" data-media-start="1"></video></body></html>`

type Player = HTMLElement & {
  paused: boolean
  currentTime: number
  duration: number
  playbackRate: number
  muted: boolean
  loop: boolean
  seek: (seconds: number) => void
  iframeElement: HTMLIFrameElement
  _media: FakeParentMedia
  loadedRuntimeSrc: string | null
}

const mounts: HTMLElement[] = []

const newMount = () => {
  const mount = document.createElement('div')
  document.body.append(mount)
  mounts.push(mount)
  return mount
}

/** 建一个预览页，记下它报出的每条消息；`reported('buffering')` 是报过的缓冲状态，依次排开。 */
const createPage = () => {
  const mount = newMount()
  const sent: PreviewEvent[] = []
  const page = createPreviewPage(mount, (event) => sent.push(event))
  const playerOf = () => {
    const player = mount.querySelector('hyperframes-player')
    if (player === null) throw new Error('没有播放器')
    return player as Player
  }
  const of = <T extends PreviewEvent['type']>(type: T) =>
    sent.filter((event): event is Extract<PreviewEvent, { type: T }> => event.type === type)
  const buffering = () => of('buffering').map((event) => event.buffering)
  const playing = () => of('playing').map((event) => event.playing)
  const send = (command: PreviewCommand) => page.handle(command)
  const load = (html: string) => send({ type: 'load', html, runtimeSrc: RUNTIME })
  return { page, mount, sent, playerOf, of, buffering, playing, send, load }
}

const firstLoaded = (opened: ReturnType<typeof createPage>) =>
  waitFor(() => expect(opened.of('loaded')).toHaveLength(1))

const openPage = async (html = film()) => {
  const opened = createPage()
  opened.send({ type: 'size', width: 180, height: 320 })
  opened.load(html)
  await firstLoaded(opened)
  /** 换一份成片，等它换上来。 */
  const showFilm = async (next: string) => {
    const old = opened.playerOf()
    const loaded = opened.of('loaded').length
    opened.load(next)
    await waitFor(() => expect(opened.of('loaded')).toHaveLength(loaded + 1))
    expect(opened.playerOf()).not.toBe(old)
  }
  return { ...opened, showFilm }
}

afterEach(() => {
  vi.unstubAllGlobals()
  starvedVideos.clear()
  downloadingVideos.clear()
  bufferedVideos.clear()
  clearFailedVideos()
  for (const mount of mounts.splice(0)) mount.remove()
})

describe('每个文件只下载一份', () => {
  it('播放器不建父页面副本，换上来的新播放器同样不建', async () => {
    const { playerOf, showFilm } = await openPage()
    expect(playerOf()._media.entries).toEqual([])
    await showFilm(film('<p></p>'))
    expect(playerOf()._media.entries).toEqual([])
  })
})

describe('运行库、尺寸、倍速', () => {
  it('加载成片时播放器已带着运行库地址和画布尺寸；换上来的新播放器同样带着', async () => {
    const { playerOf, showFilm } = await openPage()
    expect(playerOf().loadedRuntimeSrc).toBe(RUNTIME)
    expect([playerOf().getAttribute('width'), playerOf().getAttribute('height')]).toEqual([
      '180',
      '320',
    ])

    await showFilm(film('<p></p>'))
    expect(playerOf().loadedRuntimeSrc).toBe(RUNTIME)
    expect(playerOf().getAttribute('width')).toBe('180')
  })

  it('改了画布尺寸交给播放器', async () => {
    const { playerOf, send } = await openPage()
    send({ type: 'size', width: 1080, height: 1920 })
    expect([playerOf().getAttribute('width'), playerOf().getAttribute('height')]).toEqual([
      '1080',
      '1920',
    ])
  })

  it('倍速、静音、循环交给播放器；换上来的新播放器照旧', async () => {
    const { playerOf, send, showFilm } = await openPage()
    send({ type: 'playback', rate: 2, muted: true, loop: true })
    expect(playerOf()).toMatchObject({ playbackRate: 2, muted: true, loop: true })

    await showFilm(film('<p></p>'))
    expect(playerOf()).toMatchObject({ playbackRate: 2, muted: true, loop: true })
  })

  it('换上来时报出成片的秒数', async () => {
    const { of } = await openPage()
    expect(of('loaded')).toEqual([{ type: 'loaded', duration: expect.any(Number) as number }])
  })
})

describe('时钟跟着画面走', () => {
  it('播放器报出的时刻换算成毫秒报出去，带着处理到的那次跳转', async () => {
    const { of, playerOf, send } = await openPage()
    playerOf().seek(1.5)
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 1500, seq: 0 })

    send({ type: 'seek', ms: 1000, seq: 3 })
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 1000, seq: 3 })
  })

  it('数据足够时直接放，不转圈', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    send({ type: 'play' })
    expect(playerOf().paused).toBe(false)
    expect(buffering()).toEqual([])
    expect(playing().at(-1)).toBe(true)
  })

  it('还在下载、缓冲不多但够往下放时不停：要等 3 秒的只有已经停下等待的时候', async () => {
    const { buffering, playerOf, send } = await openPage()
    downloadingVideos.add(FIRST)
    bufferedVideos.set(FIRST, [[0, 0.5]])
    send({ type: 'play' })
    playerOf().seek(0.1)
    expect(playerOf().paused).toBe(false)
    expect(buffering()).toEqual([])
  })

  it('点播放时当前片段数据不够：时间线不走，按钮算在放；够了自动继续', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    expect(playerOf().paused).toBe(true)
    expect(buffering().at(-1)).toBe(true)
    expect(playing().at(-1)).toBe(true)

    finishBuffering(FIRST)
    expect(playerOf().paused).toBe(false)
    expect(buffering().at(-1)).toBe(false)
    expect(playing()).not.toContain(false)
  })

  it('播放中走进数据不够的片段：时间线停下，够了自动继续，不报停止播放', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    send({ type: 'play' })
    starvedVideos.add(SECOND)
    playerOf().seek(2.5)
    expect(playerOf().paused).toBe(true)
    expect(buffering().at(-1)).toBe(true)

    finishBuffering(SECOND)
    expect(playerOf().paused).toBe(false)
    expect(buffering().at(-1)).toBe(false)
    expect(playing()).not.toContain(false)
  })

  it('状态不变时不重复报缓冲', async () => {
    const { buffering, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    emitFrom(FIRST, 'progress')
    emitFrom(FIRST, 'progress')
    expect(buffering()).toEqual([true])
  })

  it('只看当前片段：别的片段数据不够不停', async () => {
    const { buffering, playerOf, send } = await openPage()
    starvedVideos.add(SECOND)
    send({ type: 'play' })
    playerOf().seek(1)
    expect(playerOf().paused).toBe(false)
    expect(buffering()).toEqual([])
  })

  it('当前时刻没有视频片段（组件段）时不停', async () => {
    const { buffering, playerOf, send } = await openPage()
    starvedVideos.add(FIRST).add(SECOND)
    playerOf().seek(5)
    send({ type: 'play' })
    expect(playerOf().paused).toBe(false)
    expect(buffering()).toEqual([])
  })

  it('出错的片段不卡住：等待中出错接着放，之后不再为它转圈', async () => {
    const { buffering, playerOf, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    failVideo(FIRST)
    expect(playerOf().paused).toBe(false)
    expect(buffering().at(-1)).toBe(false)

    playerOf().seek(0.5)
    expect(playerOf().paused).toBe(false)
    expect(buffering()).toHaveLength(2)
  })

  it('播放中点暂停：时间线停下，报出停止播放', async () => {
    const { playerOf, playing, send } = await openPage()
    send({ type: 'play' })
    send({ type: 'pause' })
    expect(playerOf().paused).toBe(true)
    expect(playing().at(-1)).toBe(false)
  })

  it('缓冲中暂停：不再转圈，报出停止播放，够了也不恢复', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    send({ type: 'pause' })
    expect(buffering().at(-1)).toBe(false)
    expect(playing().at(-1)).toBe(false)

    finishBuffering(FIRST)
    expect(playerOf().paused).toBe(true)
  })

  it('缓冲中跳转：不再转圈，够了也不恢复', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    send({ type: 'seek', ms: 500, seq: 1 })
    expect(buffering().at(-1)).toBe(false)
    expect(playing().at(-1)).toBe(false)

    finishBuffering(FIRST)
    expect(playerOf().paused).toBe(true)
  })

  it('播放中跳转：停在跳到的那一帧', async () => {
    const { playerOf, send } = await openPage()
    send({ type: 'play' })
    send({ type: 'seek', ms: 1000, seq: 1 })
    expect(playerOf().paused).toBe(true)
    expect(playerOf().currentTime).toBeCloseTo(1, 5)
  })

  it('放到结尾：停在结尾不跳回开头，报出停止播放，之后的事件不会重新放起来', async () => {
    const { playerOf, playing, send } = await openPage()
    send({ type: 'play' })
    const player = playerOf()
    player.duration = 4
    // 真播放器到结尾时先停下、报出时刻，ended 随后才来
    player.paused = true
    player.seek(4)
    expect(player.paused).toBe(true)
    expect(player.currentTime).toBe(4)

    player.dispatchEvent(new Event('ended'))
    expect(playing().at(-1)).toBe(false)

    emitFrom(FIRST, 'progress')
    expect(player.paused).toBe(true)
    expect(player.currentTime).toBe(4)
  })

  it('在结尾点播放：从头放', async () => {
    const { playerOf, send } = await openPage()
    const player = playerOf()
    player.duration = 4
    send({ type: 'seek', ms: 4000, seq: 1 })
    send({ type: 'play' })
    expect(player.currentTime).toBe(0)
    expect(player.paused).toBe(false)
  })
})

describe('第一份成片装好之前', () => {
  it('点播放先记下：报在放并转圈，装好后自动开始放、不再转圈', async () => {
    const opened = createPage()
    opened.load(film())
    opened.send({ type: 'play' })
    expect(opened.playing()).toEqual([true])
    expect(opened.buffering()).toEqual([true])

    await firstLoaded(opened)
    expect(opened.playerOf().paused).toBe(false)
    expect(opened.playing().at(-1)).toBe(true)
    expect(opened.buffering().at(-1)).toBe(false)
  })

  it('记下播放后又暂停：装好后停着', async () => {
    const opened = createPage()
    opened.load(film())
    opened.send({ type: 'play' })
    opened.send({ type: 'pause' })
    expect(opened.playing().at(-1)).toBe(false)
    expect(opened.buffering().at(-1)).toBe(false)

    await firstLoaded(opened)
    expect(opened.playerOf().paused).toBe(true)
  })

  it('跳转也先记下：第一个播放器停在那个位置', async () => {
    const opened = createPage()
    opened.load(film())
    opened.send({ type: 'seek', ms: 1500, seq: 1 })

    await firstLoaded(opened)
    expect(opened.playerOf().currentTime).toBeCloseTo(1.5, 5)
    expect(opened.playerOf().paused).toBe(true)
  })

  it('记下了播放但成片没了：报出停止播放、不再转圈，正在加载的那份不换上来', async () => {
    const opened = createPage()
    opened.load(film())
    opened.send({ type: 'play' })
    opened.send({ type: 'unload' })
    expect(opened.playing().at(-1)).toBe(false)
    expect(opened.buffering().at(-1)).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(opened.of('loaded')).toEqual([])
    expect(opened.mount.querySelector('hyperframes-player')).toBeNull()
  })
})

describe('换成片', () => {
  it('连着换几份：只加载最后一份', async () => {
    const opened = createPage()
    opened.load(film('<p>一</p>'))
    opened.load(film('<p>二</p>'))
    await firstLoaded(opened)
    expect(opened.mount.querySelectorAll('hyperframes-player')).toHaveLength(1)
    expect(opened.playerOf().getAttribute('srcdoc')).toContain('<p>二</p>')
  })

  it('在放时换：新的接着放', async () => {
    const { playerOf, playing, send, showFilm } = await openPage()
    send({ type: 'play' })
    await showFilm(film('<p></p>'))
    await waitFor(() => expect(playerOf().paused).toBe(false))
    expect(playing()).not.toContain(false)
  })

  it('停着时换：新的也停着', async () => {
    const { playerOf, showFilm } = await openPage()
    await showFilm(film('<p></p>'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(playerOf().paused).toBe(true)
  })

  it('新的还没换上来时跳转：换上来的停在跳到的地方', async () => {
    const { load, of, playerOf, send } = await openPage()
    const old = playerOf()
    // 新播放器装好后要等几帧才换上来；先把这几帧拦住，在这期间跳转
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    )
    load(film('<p></p>'))
    await waitFor(() => expect(frames).toHaveLength(1))
    send({ type: 'seek', ms: 1500, seq: 1 })
    vi.unstubAllGlobals()
    frames[0]?.(0)
    await waitFor(() => expect(of('loaded')).toHaveLength(2))
    expect(playerOf()).not.toBe(old)
    expect(playerOf().currentTime).toBeCloseTo(1.5, 5)
  })

  it('缓冲中换：不再转圈，新的接着放', async () => {
    const { buffering, playerOf, send, showFilm } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })

    starvedVideos.clear()
    await showFilm(film('<p></p>'))
    await waitFor(() => expect(playerOf().paused).toBe(false))
    expect(buffering().at(-1)).toBe(false)
  })

  it('新的加载期间旧播放器停着：媒体事件不会把它放起来', async () => {
    const { load, mount, playerOf, send } = await openPage()
    send({ type: 'play' })
    const old = playerOf()
    vi.stubGlobal('requestAnimationFrame', () => 0)
    load(film('<p></p>'))
    await waitFor(() => expect(mount.querySelectorAll('hyperframes-player')).toHaveLength(2))
    await waitFor(() => expect(old.paused).toBe(true))

    emitFrom(FIRST, 'progress')
    expect(old.paused).toBe(true)
  })

  it('成片没了：不再放，也不再转圈', async () => {
    const { buffering, playerOf, playing, send } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    const shown = playerOf()

    send({ type: 'unload' })
    expect(buffering().at(-1)).toBe(false)
    expect(playing().at(-1)).toBe(false)
    finishBuffering(FIRST)
    expect(shown.paused).toBe(true)
  })
})

describe('缓冲够了才继续', () => {
  const waitAt = async (at: number) => {
    const opened = await openPage(LONG_CLIP)
    const video = opened.playerOf().iframeElement.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('成片页面里没有视频')
    video.currentTime = at
    starvedVideos.add(FIRST)
    downloadingVideos.add(FIRST)
    opened.send({ type: 'play' })
    expect(opened.buffering().at(-1)).toBe(true)
    return opened
  }
  const report = (ranges: readonly (readonly [number, number])[], event = 'progress') => {
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, ranges)
    emitFrom(FIRST, event)
  }

  it('当前位置往后不足 3 秒不继续，够 3 秒就继续', async () => {
    const { buffering, playerOf } = await waitAt(2)
    report([[1, 4.9]])
    expect(playerOf().paused).toBe(true)
    expect(buffering().at(-1)).toBe(true)

    report([[1, 5]])
    expect(playerOf().paused).toBe(false)
    expect(buffering().at(-1)).toBe(false)
  })

  it.each(['progress', 'canplay', 'seeked'])('%s 时检查缓冲', async (event) => {
    const { playerOf } = await waitAt(2)
    report([[2, 6]], event)
    expect(playerOf().paused).toBe(false)
  })

  it('片段剩下不足 3 秒时，缓冲到片段结束就继续；片段结束按素材起点算', async () => {
    const { playerOf } = await waitAt(7.5)
    report([[7, 8.9]])
    expect(playerOf().paused).toBe(true)

    report([[7, 9]])
    expect(playerOf().paused).toBe(false)
  })

  it('当前位置已过片段结束时，到不了当前位置的缓冲段不算', async () => {
    const { playerOf } = await waitAt(9.5)
    report([[1, 9.2]])
    expect(playerOf().paused).toBe(true)
  })

  it('不覆盖当前位置的缓冲段不算', async () => {
    const { playerOf } = await waitAt(2)
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
    const { playerOf } = await waitAt(2)
    bufferedVideos.set(FIRST, [[1, 8]])
    emitFrom(FIRST, 'progress')
    expect(playerOf().paused).toBe(true)
  })

  it('一旦进入等待，刚够播放还不算，要等到缓冲够', async () => {
    const { playerOf } = await waitAt(2)
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, [[2, 2.5]])
    emitFrom(FIRST, 'canplay')
    expect(playerOf().paused).toBe(true)
  })

  it('下载已停时不等缓冲段：下完的文件 buffered 可能够不到结尾，不会再有新数据', async () => {
    const { playerOf } = await waitAt(7.5)
    starvedVideos.delete(FIRST)
    bufferedVideos.set(FIRST, [[7, 8.6]])
    stopVideoDownload(FIRST)
    expect(playerOf().paused).toBe(false)
  })

  it('下载已停但视频还不能往下放时不继续', async () => {
    const { playerOf } = await waitAt(2)
    stopVideoDownload(FIRST)
    expect(playerOf().paused).toBe(true)
  })
})

describe('当前片段加载失败', () => {
  it('报出播放头所在的片段失败没有，跟着播放头走', async () => {
    const { of, playerOf } = await openPage()
    failVideo(SECOND)
    expect(of('clipFailed')).toEqual([])

    playerOf().seek(2.5)
    expect(of('clipFailed').at(-1)).toEqual({ type: 'clipFailed', failed: true })

    playerOf().seek(0.5)
    expect(of('clipFailed').at(-1)).toEqual({ type: 'clipFailed', failed: false })
  })

  it('重试时重新加载这个片段，加载开始后报出不再失败', async () => {
    const { of, playerOf, send } = await openPage()
    failVideo(FIRST)
    expect(of('clipFailed').at(-1)?.failed).toBe(true)
    const video = playerOf().iframeElement.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('成片页面里没有视频')
    const load = vi.spyOn(video, 'load').mockImplementation(() => {
      clearFailedVideos()
      emitFrom(FIRST, 'emptied')
    })

    send({ type: 'retry' })
    expect(load).toHaveBeenCalledOnce()
    expect(video.preload).toBe('auto')
    expect(of('clipFailed').at(-1)?.failed).toBe(false)
  })
})

describe('报出已缓冲的区间', () => {
  it('各视频片段已缓冲的部分换算成成片时间；没变化不重复报，换上新的以后重新报', async () => {
    bufferedVideos.set(FIRST, [[0, 1]])
    const { of, showFilm } = await openPage()
    expect(of('buffered').at(-1)?.spans).toEqual([{ start: 0, end: 1 }])

    bufferedVideos.set(SECOND, [[0.5, 2.5]])
    emitFrom(SECOND, 'progress')
    expect(of('buffered').at(-1)?.spans).toEqual([
      { start: 0, end: 1 },
      { start: 2.5, end: 4 },
    ])

    const reports = of('buffered').length
    emitFrom(SECOND, 'progress')
    expect(of('buffered')).toHaveLength(reports)

    await showFilm(film('<p></p>'))
    expect(of('buffered').length).toBeGreaterThan(reports)
    expect(of('buffered').at(-1)?.spans).toEqual([
      { start: 0, end: 1 },
      { start: 2.5, end: 4 },
    ])
  })

  it('片段从素材中间开始时按素材起点换算，片段以外的缓冲不算', async () => {
    bufferedVideos.set(FIRST, [[0, 5]])
    const { of } = await openPage(LONG_CLIP)
    expect(of('buffered').at(-1)?.spans).toEqual([{ start: 0, end: 4 }])
  })
})

describe('视频都停止下载时报出', () => {
  it('换上来时都没在下载：立即报', async () => {
    const { of } = await openPage()
    expect(of('mediaSettled')).toHaveLength(1)
  })

  it('还有视频在下载时不报，全部停下才报', async () => {
    downloadingVideos.add(FIRST).add(SECOND)
    const { of } = await openPage()
    expect(of('mediaSettled')).toEqual([])

    stopVideoDownload(FIRST)
    expect(of('mediaSettled')).toEqual([])

    stopVideoDownload(SECOND)
    expect(of('mediaSettled')).toHaveLength(1)
  })

  it('视频出错算不再下载', async () => {
    downloadingVideos.add(FIRST)
    const { of } = await openPage()
    downloadingVideos.delete(FIRST)
    failVideo(FIRST)
    expect(of('mediaSettled')).toHaveLength(1)
  })

  it('成片里没有视频时不报', async () => {
    const { of } = await openPage('<!doctype html><html><body></body></html>')
    expect(of('mediaSettled')).toEqual([])
  })
})

describe('拆掉', () => {
  it('拆掉时报出不再缓冲；之后的事件不再报，也不再放', async () => {
    const { buffering, page, playerOf, send, sent } = await openPage()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    const player = playerOf()
    const video = player.iframeElement.contentDocument?.querySelector('video')
    if (video === null || video === undefined) throw new Error('成片页面里没有视频')
    page.dispose()
    expect(buffering().at(-1)).toBe(false)
    const count = sent.length

    starvedVideos.delete(FIRST)
    video.dispatchEvent(new Event('progress'))
    video.dispatchEvent(new Event('suspend'))
    player.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 1 } }))
    player.dispatchEvent(new Event('ended'))

    expect(player.paused).toBe(true)
    expect(sent).toHaveLength(count)
  })
})

describe('启动', () => {
  const APP = 'https://studio.example.com'
  const LOAD: PreviewCommand = { type: 'load', html: film(), runtimeSrc: RUNTIME }
  const hostLookups: string[] = []
  const answerHost = (status: number) =>
    server.use(
      http.get('*/api/whole-film/preview/:token/host', ({ params }) => {
        hostLookups.push(String(params['token']))
        return status === 200
          ? HttpResponse.json({ appOrigin: APP })
          : HttpResponse.json({ detail: '令牌无效' }, { status })
      }),
    )
  const deliver = (data: unknown, origin: string, source: MessageEventSource | null) =>
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
  const otherWindow = () => {
    const frame = document.createElement('iframe')
    newMount().append(frame)
    if (frame.contentWindow === null) throw new Error('没有窗口')
    return frame.contentWindow
  }

  afterEach(() => {
    hostLookups.length = 0
  })

  it('凭令牌问出应用来源，向它报就绪；只处理这个来源的父页面发来的、合规的命令', async () => {
    answerHost(200)
    // 测试里的窗口没有父页面，parent 就是它自己
    const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    const mount = newMount()
    const stop = await bootPreviewPage('令牌 1', mount)
    expect(hostLookups).toEqual(['令牌 1'])
    expect(posted).toHaveBeenCalledWith({ type: 'ready' }, APP)

    deliver(LOAD, 'https://elsewhere.example.com', window)
    deliver(LOAD, APP, otherWindow())
    deliver({ ...LOAD, html: 1 }, APP, window)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(mount.querySelector('hyperframes-player')).toBeNull()

    deliver(LOAD, APP, window)
    await waitFor(() => expect(mount.querySelector('hyperframes-player')).not.toBeNull())
    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'loaded' }), APP),
    )
    stop()
  })

  it('问不出应用来源（例如在应用域名下打开，那里这个地址是 404）时不启动：不报就绪、不处理命令', async () => {
    answerHost(404)
    const posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    const mount = newMount()
    await expect(bootPreviewPage('令牌 1', mount)).rejects.toThrow()

    deliver(LOAD, APP, window)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(mount.querySelector('hyperframes-player')).toBeNull()
    expect(posted).not.toHaveBeenCalled()
  })

  it('地址里没有令牌时不去问', async () => {
    answerHost(200)
    await expect(bootPreviewPage('', newMount())).rejects.toThrow()
    expect(hostLookups).toEqual([])
  })
})

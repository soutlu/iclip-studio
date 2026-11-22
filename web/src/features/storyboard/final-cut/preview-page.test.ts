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
import { FONT_BLOCK_END, FONT_BLOCK_START } from './composition/film'
import { bootPreviewPage, createPreviewPage, type PreviewPage } from './preview-page'
import type { PreviewCommand, PreviewEvent } from './preview-protocol'

type PatchCommand = Extract<PreviewCommand, { type: 'patch' }>

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
  runtimeTime: number
}

const mounts: HTMLElement[] = []
// 用例结束时还在加载的那一份不再换上来
const pages: PreviewPage[] = []

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
  pages.push(page)
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
  // 和编辑器一样：整份加载、打补丁共用一个序号
  let seq = 0
  const load = (html: string, captions?: string) =>
    send(
      captions === undefined
        ? { type: 'load', html, runtimeSrc: RUNTIME, seq: (seq += 1) }
        : { type: 'load', html, runtimeSrc: RUNTIME, captions, seq: (seq += 1) },
    )
  const patch = (patches: PatchCommand['patches'], at = (seq += 1)) =>
    send({ type: 'patch', seq: at, patches })
  /** 一步编辑里字幕场景的补丁 `captions`（和主文件的 `patches`）。 */
  const patchCaptions = (
    captions: NonNullable<PatchCommand['captions']>,
    patches: PatchCommand['patches'] = [],
  ) => send({ type: 'patch', seq: (seq += 1), patches, captions })
  return { page, mount, sent, playerOf, of, buffering, playing, send, load, patch, patchCaptions }
}

const firstLoaded = (opened: ReturnType<typeof createPage>) =>
  waitFor(() => expect(opened.of('loaded')).toHaveLength(1))

const openPage = async (html = film(), captions?: string) => {
  const opened = createPage()
  opened.send({ type: 'size', width: 180, height: 320 })
  opened.load(html, captions)
  await firstLoaded(opened)
  /** 换一份 final-cut，等它换上来。 */
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
  for (const page of pages.splice(0)) page.dispose()
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
  it('加载 final-cut 时播放器已带着运行库地址和画布尺寸；换上来的新播放器同样带着', async () => {
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

  it('换上来时报出 final-cut 的秒数和它是第几份', async () => {
    const { of } = await openPage()
    expect(of('loaded')).toEqual([
      { type: 'loaded', duration: expect.any(Number) as number, seq: 1 },
    ])
  })
})

describe('时钟跟着画面走', () => {
  it('播放器报出的时刻换算成毫秒报出去，带着处理到的那次跳转；跳转以后到再次播放之前不报', async () => {
    const { of, playerOf, send } = await openPage()
    playerOf().seek(1.5)
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 1500, seq: 0 })

    // 跳转以后、再次播放之前不报：播放头由编辑器定，晚到的上一次跳转的时刻不会带着这次的序号报出去
    const reported = of('time').length
    send({ type: 'seek', ms: 1000, seq: 3 })
    playerOf().seek(0.5)
    expect(of('time')).toHaveLength(reported)

    send({ type: 'play' })
    // 在放时由逐帧读运行库的时钟报
    playerOf().runtimeTime = 1.2
    await waitFor(() => expect(of('time').at(-1)).toEqual({ type: 'time', ms: 1200, seq: 3 }))
  })

  it('跳转以后换上新的播放器：新播放器停在哪照常报出去（总长变短时收在结尾）', async () => {
    const { of, playerOf, send, showFilm } = await openPage()
    send({ type: 'seek', ms: 3500, seq: 1 })
    await showFilm(film('<p></p>'))
    playerOf().seek(3)
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 3000, seq: 1 })
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

/**
 * 接管 requestAnimationFrame：排着的回调由 `step` 一帧一帧地跑，取消了的不跑。要在 final-cut 装好以后再接管
 * （换播放器时要等几帧）。
 */
const takeOverFrames = () => {
  const queued = new Map<number, FrameRequestCallback>()
  let handle = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    handle += 1
    queued.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (at: number) => queued.delete(at))
  return {
    /** 跑一帧：跑掉现在排着的回调（回调里新排的留到下一帧）。 */
    step: () => {
      const due = [...queued.values()]
      queued.clear()
      for (const callback of due) callback(performance.now())
    },
    /** 排着等下一帧的回调有几个。 */
    queued: () => queued.size,
  }
}

describe('在放时逐帧报运行库的时钟', () => {
  it('每帧读一次运行库的时钟，变了才报，带着处理到的那次跳转；循环回到开头也照报', async () => {
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    send({ type: 'seek', ms: 0, seq: 2 })
    send({ type: 'play' })
    const player = playerOf()
    const reported = of('time').length

    player.runtimeTime = 0.016
    frames.step()
    player.runtimeTime = 0.033
    frames.step()
    expect(of('time').slice(reported)).toEqual([
      { type: 'time', ms: 16, seq: 2 },
      { type: 'time', ms: 33, seq: 2 },
    ])

    frames.step()
    expect(of('time')).toHaveLength(reported + 2)

    player.runtimeTime = 0.01
    frames.step()
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 10, seq: 2 })
  })

  it('在放时播放器的 timeupdate 不报（带的是旧值）；停着时照常报', async () => {
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    send({ type: 'play' })
    const player = playerOf()
    player.runtimeTime = 1.25
    frames.step()
    const reported = of('time').length

    player.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 1.2 } }))
    expect(of('time')).toHaveLength(reported)

    send({ type: 'pause' })
    player.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 1.3 } }))
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 1300, seq: 0 })
  })

  it('想放但在等数据（播放器停着）：不逐帧报，timeupdate 照常报', async () => {
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    starvedVideos.add(FIRST)
    send({ type: 'play' })
    const player = playerOf()
    expect(player.paused).toBe(true)
    const reported = of('time').length

    player.runtimeTime = 0.5
    frames.step()
    expect(of('time')).toHaveLength(reported)

    player.dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 0.4 } }))
    expect(of('time').at(-1)).toEqual({ type: 'time', ms: 400, seq: 0 })
  })

  it('跳转以后到再次播放之前不逐帧报；再放时第一帧就报，带着这次跳转的序号', async () => {
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    send({ type: 'play' })
    const player = playerOf()
    player.runtimeTime = 0.5
    frames.step()

    send({ type: 'seek', ms: 1000, seq: 4 })
    const reported = of('time').length
    expect(frames.queued()).toBe(0)
    player.runtimeTime = 0.6
    frames.step()
    expect(of('time')).toHaveLength(reported)

    player.runtimeTime = 1
    send({ type: 'play' })
    frames.step()
    player.runtimeTime = 1.05
    frames.step()
    expect(of('time').slice(reported)).toEqual([
      { type: 'time', ms: 1000, seq: 4 },
      { type: 'time', ms: 1050, seq: 4 },
    ])
  })

  it('暂停、放到结尾以后不再逐帧报', async () => {
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    send({ type: 'play' })
    const player = playerOf()
    player.runtimeTime = 0.5
    frames.step()

    send({ type: 'pause' })
    const reported = of('time').length
    expect(frames.queued()).toBe(0)
    player.runtimeTime = 0.6
    frames.step()
    expect(of('time')).toHaveLength(reported)

    send({ type: 'play' })
    frames.step()
    expect(of('time')).toHaveLength(reported + 1)
    player.dispatchEvent(new Event('ended'))
    expect(frames.queued()).toBe(0)
  })

  it('换上新的播放器以后只报新播放器的时钟，旧的不再报', async () => {
    const { load, of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    send({ type: 'play' })
    const old = playerOf()
    load(film('<p></p>'))
    await waitFor(() => {
      frames.step()
      expect(of('loaded')).toHaveLength(2)
    })
    const next = playerOf()
    expect(next).not.toBe(old)
    await waitFor(() => expect(next.paused).toBe(false))
    const reported = of('time').length

    old.runtimeTime = 3
    next.runtimeTime = 0.5
    frames.step()
    frames.step()
    expect(of('time').slice(reported)).toEqual([{ type: 'time', ms: 500, seq: 0 }])
  })

  it('在放时读不到运行库的时钟：不报时刻，每个播放器只报一次错', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { of, playerOf, send } = await openPage()
    const frames = takeOverFrames()
    const view = playerOf().iframeElement.contentWindow
    if (view === null) throw new Error('播放器里没有页面')
    Reflect.deleteProperty(view, '__player')
    send({ type: 'play' })
    const reported = of('time').length
    frames.step()
    frames.step()
    expect(of('time')).toHaveLength(reported)
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe('第一份 final-cut 装好之前', () => {
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

  it('记下了播放但 final-cut 没了：报出停止播放、不再转圈，正在加载的那份不换上来', async () => {
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

describe('一步编辑的补丁直接打进正在播的那一份', () => {
  // 编辑器存出的主文件里每个元素都写着 data-hf-id
  const stage = (clips: string) =>
    '<!doctype html><html><head></head><body>' +
    `<div id="film" data-hf-id="film" data-composition-id="film" data-start="0" data-duration="4">${clips}</div>` +
    '</body></html>'
  const CLIPS =
    `<video id="a" data-hf-id="a" src="${FIRST}" data-start="0" data-duration="2"></video>` +
    `<video id="b" data-hf-id="b" src="${SECOND}" data-start="2" data-duration="2"></video>`

  const openLive = async () => {
    const opened = await openPage(stage(CLIPS))
    const inPlayer = (id: string) => {
      const element = opened.playerOf().iframeElement.contentDocument?.getElementById(id)
      if (element === null || element === undefined) throw new Error(`预览里没有 ${id}`)
      return element as HTMLMediaElement
    }
    return { ...opened, inPlayer }
  }

  it('不换播放器，补丁改到播放器里的那一份上，报出打完的秒数', async () => {
    const { of, inPlayer, patch, playerOf } = await openLive()
    const player = playerOf()
    patch([
      { op: 'replace', path: '/elements/b/timing/start', value: 3 },
      { op: 'add', path: '/elements/a/attributes/data-hidden', value: '' },
    ])
    expect(playerOf()).toBe(player)
    expect(inPlayer('b')).toHaveAttribute('data-start', '3')
    expect(inPlayer('a')).toHaveAttribute('data-hidden', '')
    expect(of('patched')).toEqual([{ type: 'patched', duration: player.duration, seq: 2 }])
    expect(of('needsLoad')).toEqual([])

    // 下一步接着打，删掉的也删掉
    patch([{ op: 'remove', path: '/elements/a' }])
    expect(playerOf().iframeElement.contentDocument?.getElementById('a')).toBeNull()
    expect(of('patched').map((event) => event.seq)).toEqual([2, 3])
  })

  it('总长改长：先让运行库把时间线加长（那时根上还是原来的总长），再打补丁', async () => {
    const { inPlayer, patch, playerOf } = await openLive()
    const page = playerOf().iframeElement.contentWindow
    if (page === null) throw new Error('预览里没有窗口')
    const received: { data: unknown; rootDuration: string | null }[] = []
    page.addEventListener('message', (event) => {
      received.push({
        data: event.data as unknown,
        rootDuration: inPlayer('film').getAttribute('data-duration'),
      })
    })
    patch([
      { op: 'replace', path: '/elements/b/timing/start', value: 6 },
      { op: 'replace', path: '/metadata/duration', value: 8 },
    ])
    expect(received).toEqual([
      {
        data: {
          source: 'hf-parent',
          type: 'control',
          action: 'set-root-duration',
          durationSeconds: 8,
        },
        rootDuration: '4',
      },
    ])
    expect(inPlayer('film')).toHaveAttribute('data-duration', '8')
  })

  it('停着时打完原地跳一下让画面重画；在放时不跳', async () => {
    const { patch, playerOf, send } = await openLive()
    playerOf().seek(1.5)
    const seek = vi.spyOn(playerOf(), 'seek')
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 3 }])
    expect(seek).toHaveBeenCalledExactlyOnceWith(1.5)

    send({ type: 'play' })
    seek.mockClear()
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 2.5 }])
    expect(seek).not.toHaveBeenCalled()
    expect(playerOf().paused).toBe(false)
  })

  it('在放时给视频第一次加上效果链或曲线：原地跳一下，接着放；改值、换组不跳', async () => {
    const { patch, playerOf, send } = await openLive()
    send({ type: 'play' })
    playerOf().seek(1.5)
    const seek = vi.spyOn(playerOf(), 'seek')
    patch([{ op: 'add', path: '/elements/a/attributes/data-fx-chain', value: '{}' }])
    expect(seek).toHaveBeenCalledExactlyOnceWith(1.5)
    patch([{ op: 'add', path: '/elements/b/attributes/data-automation', value: '{}' }])
    expect(seek).toHaveBeenCalledTimes(2)
    expect(playerOf().paused).toBe(false)

    seek.mockClear()
    patch([
      { op: 'replace', path: '/elements/a/attributes/data-fx-chain', value: '{"version":1}' },
      { op: 'add', path: '/elements/a/attributes/data-audio-group', value: 'voice' },
    ])
    expect(seek).not.toHaveBeenCalled()
  })

  it('加进来的视频、音频照预览的规则加载，预览静音时跟着静音', async () => {
    const { inPlayer, patch, send } = await openLive()
    send({ type: 'playback', rate: 1, muted: true, loop: false })
    patch([
      {
        op: 'add',
        path: '/elements/c',
        value: {
          html: `<video id="c" data-hf-id="c" src="${SECOND}" data-start="4" data-duration="1" preload="auto"></video>`,
          parentId: 'film',
          siblingIndex: 0,
        },
      },
      {
        op: 'add',
        path: '/elements/d',
        value: {
          html: '<audio id="d" data-hf-id="d" src="https://oss/d.m4a" data-start="0" data-duration="4"></audio>',
          parentId: 'film',
          siblingIndex: 0,
        },
      },
    ])
    expect(inPlayer('c')).toHaveAttribute('crossorigin', 'anonymous')
    expect(inPlayer('c')).toHaveAttribute('preload', 'none')
    expect(inPlayer('d')).toHaveAttribute('crossorigin', 'anonymous')
    expect(inPlayer('d')).toHaveAttribute('preload', 'none')
    expect([inPlayer('c').muted, inPlayer('d').muted]).toEqual([true, true])
  })

  it('改了片段的静音，播放器里那段的声音跟着变；预览静音时一直静音', async () => {
    const { inPlayer, patch, send } = await openLive()
    patch([{ op: 'add', path: '/elements/a/attributes/muted', value: 'true' }])
    expect(inPlayer('a').muted).toBe(true)
    patch([{ op: 'remove', path: '/elements/a/attributes/muted' }])
    expect(inPlayer('a').muted).toBe(false)

    send({ type: 'playback', rate: 1, muted: true, loop: false })
    inPlayer('a').muted = true
    patch([{ op: 'add', path: '/elements/a/attributes/muted', value: 'true' }])
    patch([{ op: 'remove', path: '/elements/a/attributes/muted' }])
    expect(inPlayer('a').muted).toBe(true)
  })

  it('序号对不上：不打，报要整份重新加载；之后的也不打，新的一份换上来以后照常', async () => {
    const { of, inPlayer, load, patch, playerOf } = await openLive()
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 3 }], 3)
    expect(of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 3 }])
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 3 }], 2)
    expect(of('needsLoad').map((event) => event.seq)).toEqual([3, 2])
    expect(inPlayer('b')).toHaveAttribute('data-start', '2')
    expect(of('patched')).toEqual([])

    const old = playerOf()
    load(stage(CLIPS))
    await waitFor(() => expect(playerOf()).not.toBe(old))
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 3 }])
    expect(inPlayer('b')).toHaveAttribute('data-start', '3')
    expect(of('patched')).toHaveLength(1)
  })

  it('要改的片段不在播放器里（加载时去掉的隐藏片段）：不打，报要整份重新加载', async () => {
    const { of, patch } = await openLive()
    patch([{ op: 'remove', path: '/elements/gone/attributes/data-hidden' }])
    expect(of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 2 }])
    expect(of('patched')).toEqual([])
  })

  it('打的时候出错：报要整份重新加载', async () => {
    const { of, patch } = await openLive()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // 属性名里有空格，写进文档时抛错
    patch([{ op: 'add', path: '/elements/a/attributes/bad name', value: '' }])
    expect(of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 2 }])
    expect(of('patched')).toEqual([])
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('收到新的一份以后、换上来之前的补丁不打', async () => {
    const { inPlayer, load, of, patch } = await openLive()
    load(stage(CLIPS))
    patch([{ op: 'replace', path: '/elements/b/timing/start', value: 3 }])
    expect(of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 3 }])
    expect(inPlayer('b')).toHaveAttribute('data-start', '2')
  })

  it('带着新的中文字体规则：先换掉播放器里字体块的 <style>，再打补丁；没有字体块时不打，报要整份重新加载', async () => {
    const opened = await openPage(stage(CLIPS))
    const player = opened.playerOf()
    // 测试用的播放器只放 <body>：照真播放器的样子把字体块写进 <head>
    const head = player.iframeElement.contentDocument?.head
    if (head === undefined) throw new Error('预览里没有页面')
    head.innerHTML = `${FONT_BLOCK_START}\n<style>@font-face{a}</style>\n${FONT_BLOCK_END}`
    opened.send({
      type: 'patch',
      seq: 2,
      patches: [{ op: 'replace', path: '/elements/b/timing/start', value: 3 }],
      fonts: '@font-face{b}',
    })
    const page = opened.playerOf().iframeElement.contentDocument
    expect(opened.playerOf()).toBe(player)
    expect(page?.head.querySelector('style')?.textContent).toBe('@font-face{b}')
    expect(page?.getElementById('b')).toHaveAttribute('data-start', '3')
    expect(opened.of('patched').map((event) => event.seq)).toEqual([2])

    const bare = await openPage(stage(CLIPS))
    bare.send({ type: 'patch', seq: 2, patches: [], fonts: '@font-face{b}' })
    expect(bare.of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 2 }])
  })

  describe('字幕场景', () => {
    const caption = (text: string) =>
      `<div id="cap-1" data-hf-id="cap-1" class="clip caption" data-start="0" data-duration="2" data-var-text="cap_1">${text}</div>`
    const sceneRoot = (text: string) =>
      `<div id="root" data-hf-id="root" data-composition-id="captions" data-no-timeline>${caption(text)}</div>`
    const SCENE = `<template>\n<style></style>\n${sceneRoot('你好')}\n</template>\n`
    // 运行库加载时把场景挂进字幕宿主，字照根变量写（这里是英文）
    const MOUNTED =
      CLIPS +
      `<div id="captions" data-hf-id="captions" data-composition-id="captions" data-start="0" data-duration="4">${sceneRoot('Hello')}</div>`

    it('字幕场景的补丁经场景的副本会话打进播放器里挂着的那一份，不换播放器；主文件的照打', async () => {
      const opened = await openPage(stage(MOUNTED), SCENE)
      const player = opened.playerOf()
      const inPlayer = (id: string) =>
        opened.playerOf().iframeElement.contentDocument?.querySelector(`[data-hf-id="${id}"]`)
      opened.patchCaptions(
        [
          { op: 'replace', path: '/elements/cap-1/timing/start', value: 1 },
          { op: 'replace', path: '/elements/cap-1/text', value: 'Hi\nthere' },
        ],
        [{ op: 'replace', path: '/elements/b/timing/start', value: 3 }],
      )
      expect(opened.playerOf()).toBe(player)
      expect(inPlayer('cap-1')).toHaveAttribute('data-start', '1')
      expect(inPlayer('cap-1')?.innerHTML).toBe('Hi<br>there')
      expect(inPlayer('b')).toHaveAttribute('data-start', '3')
      expect(opened.of('patched').map((event) => event.seq)).toEqual([2])

      opened.patchCaptions([
        {
          op: 'add',
          path: '/elements/cap-2',
          value: {
            html: '<div id="cap-2" data-hf-id="cap-2" class="clip caption" data-start="2" data-duration="1">再见</div>',
            parentId: 'root',
            siblingIndex: 1,
          },
        },
        { op: 'remove', path: '/elements/cap-1' },
      ])
      expect(inPlayer('cap-2')?.closest('[data-hf-id="captions"]')).not.toBeNull()
      expect(inPlayer('cap-1')).toBeNull()
      expect(opened.of('needsLoad')).toEqual([])
    })

    it('这一份没带字幕场景、或要改的那句不在播放器里：不打，报要整份重新加载', async () => {
      const bare = await openPage(stage(MOUNTED))
      bare.patchCaptions([{ op: 'replace', path: '/elements/cap-1/text', value: 'Hi' }])
      expect(bare.of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 2 }])

      const opened = await openPage(stage(CLIPS), SCENE)
      opened.patchCaptions([{ op: 'replace', path: '/elements/cap-1/text', value: 'Hi' }])
      expect(opened.of('needsLoad')).toEqual([{ type: 'needsLoad', seq: 2 }])
      expect(opened.of('patched')).toEqual([])
    })
  })
})

describe('换 final-cut', () => {
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

  it('final-cut 没了：不再放，也不再转圈', async () => {
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
    if (video === null || video === undefined) throw new Error('final-cut 页面里没有视频')
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
    if (video === null || video === undefined) throw new Error('final-cut 页面里没有视频')
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
  it('各视频片段已缓冲的部分换算成 final-cut 时间；没变化不重复报，换上新的以后重新报', async () => {
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

  it('final-cut 里没有视频时不报', async () => {
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
    if (video === null || video === undefined) throw new Error('final-cut 页面里没有视频')
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
  const LOAD: PreviewCommand = { type: 'load', html: film(), runtimeSrc: RUNTIME, seq: 1 }
  const hostLookups: string[] = []
  const answerHost = (status: number) =>
    server.use(
      http.get('*/api/final-cut/preview/:token/host', ({ params }) => {
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

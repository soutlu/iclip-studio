import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { servePreviewPages } from '@/testing/preview-page'
import type { JsonPatchOp } from '@hyperframes/sdk'
import {
  PreviewPlayer,
  type PlaybackSettings,
  type PreviewControl,
  type PreviewPageAddress,
} from './preview-player'
import type { PreviewFilm } from './preview-sync'

const ORIGIN = 'https://preview.example.com'
const TOKEN = 'token/1'
const PAGE: PreviewPageAddress = { kind: 'ready', origin: ORIGIN, token: TOKEN }
const FILM: PreviewFilm = {
  html: '<!doctype html><html><head></head><body></body></html>',
  runtimeSrc: `${ORIGIN}/hyperframes/v1/vendor/runtime.js`,
  revision: 1,
  step: null,
  locale: null,
  filesRevision: 0,
  captions: null,
  layers: [],
}
const MOVE: JsonPatchOp = { op: 'replace', path: '/elements/v1/timing/start', value: 3 }

/** `film` 的下一份：主文件做了一步 `patches`。 */
const edited = (film: PreviewFilm, ...patches: JsonPatchOp[]): PreviewFilm => ({
  ...film,
  html: film.html.replace('<body>', '<body><p></p>'),
  revision: film.revision + 1,
  step: [{ file: 'index.html', patches, inversePatches: [] }],
})
const EDITED = edited(FILM, MOVE)

/** 预览页收到的整份加载命令。 */
const loadOf = (film: PreviewFilm, seq: number) => ({
  type: 'load',
  html: film.html,
  runtimeSrc: film.runtimeSrc,
  seq,
})
const PLAYBACK: PlaybackSettings = { rate: 1, muted: false, loop: false }

const handlers = () => ({
  control: createRef<PreviewControl>() as { current: PreviewControl | null },
  onBuffered: vi.fn<(spans: readonly { start: number; end: number }[]) => void>(),
  onBuffering: vi.fn<(buffering: boolean) => void>(),
  onMediaSettled: vi.fn<() => void>(),
  onPlaying: vi.fn<(playing: boolean) => void>(),
  onTime: vi.fn<(ms: number) => void>(),
})

type Props = {
  page?: PreviewPageAddress
  film?: PreviewFilm | undefined
  playback?: PlaybackSettings
  width?: number
}

const preview = (on: ReturnType<typeof handlers>, props: Props = {}) => (
  <PreviewPlayer
    backdrop={undefined}
    controlRef={on.control}
    film={'film' in props ? props.film : FILM}
    height={320}
    message="final-cut 暂无内容"
    onBuffered={on.onBuffered}
    onBuffering={on.onBuffering}
    onMediaSettled={on.onMediaSettled}
    onPlaying={on.onPlaying}
    onTime={on.onTime}
    page={props.page ?? PAGE}
    playback={props.playback ?? PLAYBACK}
    width={props.width ?? 180}
  />
)

let served: ReturnType<typeof servePreviewPages>

const serve = (ready = true) => {
  served = servePreviewPages({ run: false, ready })
}

beforeEach(() => serve())

afterEach(() => served.stop())

const commandTypes = () => served.latest().commands.map((command) => command.type)

/** 以预览页的身份发一条消息，等编辑器收到。 */
const report = (data: unknown) =>
  act(async () => {
    served.latest().post(data)
    await new Promise((resolve) => setTimeout(resolve))
  })

/** 嵌好预览页、等它就绪后发完首批命令。 */
const openPreview = async (props: Props = {}) => {
  const on = handlers()
  const view = render(preview(on, props))
  await waitFor(() => expect(commandTypes()).toContain('load'))
  const control = () => {
    if (on.control.current === null) throw new Error('预览没接上')
    return on.control.current
  }
  return { ...on, view, control }
}

describe('嵌进预览页', () => {
  it('预览域名下的预览页，令牌在 # 后面；只给脚本和同源权限，可以自动播放', async () => {
    await openPreview()
    const frame = screen.getByTitle('final-cut 预览')
    expect(frame).toHaveAttribute(
      'src',
      `${ORIGIN}/final-cut-preview.html#${encodeURIComponent(TOKEN)}`,
    )
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    expect(frame).toHaveAttribute('allow', 'autoplay')
    expect(served.latest().token).toBe(TOKEN)
  })

  it('令牌还在取时不嵌预览页，也不能控制', () => {
    const on = handlers()
    render(preview(on, { page: { kind: 'pending' } }))
    expect(screen.queryByTitle('final-cut 预览')).not.toBeInTheDocument()
    expect(on.control.current).toBeNull()
  })

  it('取不到令牌：预览区写出原因，点「重试」重新取', async () => {
    const onRetry = vi.fn<() => void>()
    const user = userEvent.setup()
    render(
      preview(handlers(), {
        page: { kind: 'failed', message: '预览加载失败：没有配置预览域名', onRetry },
      }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('预览加载失败：没有配置预览域名')
    expect(screen.queryByTitle('final-cut 预览')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('发给预览页', () => {
  it('就绪后发播放设置、画布尺寸，再发 final-cut；之后改了哪项发哪项', async () => {
    const on = handlers()
    const view = render(preview(on))
    await waitFor(() => expect(commandTypes()).toEqual(['playback', 'size', 'load']))
    expect(served.latest().commands).toEqual([
      { type: 'playback', ...PLAYBACK },
      { type: 'size', width: 180, height: 320 },
      loadOf(FILM, 1),
    ])

    // 预览页还没报装好：改动整份重发
    view.rerender(preview(on, { film: EDITED }))
    await waitFor(() => expect(served.latest().commands.at(-1)).toEqual(loadOf(EDITED, 2)))
    view.rerender(preview(on, { film: EDITED, playback: { rate: 2, muted: true, loop: true } }))
    await waitFor(() =>
      expect(served.latest().commands.at(-1)).toEqual({
        type: 'playback',
        rate: 2,
        muted: true,
        loop: true,
      }),
    )
    view.rerender(preview(on, { film: EDITED, width: 1080 }))
    await waitFor(() =>
      expect(served.latest().commands.at(-1)).toEqual({ type: 'size', width: 1080, height: 320 }),
    )
  })

  it('播放、暂停、跳转发给预览页，跳转按次编号', async () => {
    const { control } = await openPreview()
    act(() => control().play())
    act(() => control().pause())
    act(() => control().seek(1500))
    act(() => control().seek(2000))
    await waitFor(() =>
      expect(served.latest().commands.slice(-4)).toEqual([
        { type: 'play' },
        { type: 'pause' },
        { type: 'seek', ms: 1500, seq: 1 },
        { type: 'seek', ms: 2000, seq: 2 },
      ]),
    )
  })

  it('预览页再报一次就绪（重新加载了）：设置和 final-cut 重发一遍', async () => {
    await openPreview()
    const before = served.latest().commands.length
    await report({ type: 'ready' })
    await waitFor(() => expect(commandTypes().slice(before)).toEqual(['playback', 'size', 'load']))
  })

  it('final-cut 没了：让预览页停下；换上过 final-cut 以后仍能控制它', async () => {
    const on = handlers()
    const view = render(preview(on))
    await waitFor(() => expect(commandTypes()).toContain('load'))
    await report({ type: 'loaded', duration: 4, seq: 1 })
    await waitFor(() => expect(on.control.current).not.toBeNull())

    view.rerender(preview(on, { film: undefined }))
    await waitFor(() => expect(commandTypes().at(-1)).toBe('unload'))
    expect(on.control.current).not.toBeNull()
    expect(screen.getByText('final-cut 暂无内容')).toBeVisible()
  })

  it('一开始就没有 final-cut：不能控制', async () => {
    const on = handlers()
    render(preview(on, { film: undefined }))
    await waitFor(() => expect(commandTypes()).toContain('unload'))
    expect(on.control.current).toBeNull()
  })
})

describe('一步编辑打补丁还是整份重新加载', () => {
  /** 嵌好预览页、发出第一份并报它装好了。 */
  const openLoaded = async () => {
    const on = handlers()
    const view = render(preview(on))
    await waitFor(() => expect(commandTypes()).toContain('load'))
    await report({ type: 'loaded', duration: 4, seq: 1 })
    const rerender = (film: PreviewFilm) => view.rerender(preview(on, { film }))
    return { rerender }
  }
  const lastCommand = () => served.latest().commands.at(-1)

  it('装好以后能直接打进去的编辑发补丁，带着接下去的序号；连着几步一样', async () => {
    const { rerender } = await openLoaded()
    rerender(EDITED)
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'patch', seq: 2, patches: [MOVE] }))
    const hidden: JsonPatchOp = {
      op: 'add',
      path: '/elements/v1/attributes/data-hidden',
      value: '',
    }
    rerender(edited(EDITED, hidden))
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'patch', seq: 3, patches: [hidden] }))
    expect(commandTypes().filter((type) => type === 'load')).toHaveLength(1)
  })

  it('有字幕场景时：整份加载带着场景文件，字幕的改动和主文件的补丁分开发', async () => {
    const SCENE = 'compositions/captions.html'
    const withCaptions: PreviewFilm = {
      ...FILM,
      captions: {
        path: SCENE,
        scene: '<template><div id="root"></div></template>',
        captions: new Map([['cap-1', { variable: 'cap_1', text: '你好' }]]),
      },
    }
    const on = handlers()
    const view = render(preview(on, { film: withCaptions }))
    await waitFor(() =>
      expect(served.latest().commands.find((command) => command.type === 'load')).toEqual({
        ...loadOf(withCaptions, 1),
        captions: '<template><div id="root"></div></template>',
      }),
    )
    await report({ type: 'loaded', duration: 4, seq: 1 })

    const retimed: JsonPatchOp = { op: 'replace', path: '/elements/cap-1/timing/start', value: 1 }
    view.rerender(
      preview(on, {
        film: {
          ...edited(withCaptions, MOVE),
          step: [
            { file: 'index.html', patches: [MOVE], inversePatches: [] },
            { file: SCENE, patches: [retimed], inversePatches: [] },
          ],
        },
      }),
    )
    await waitFor(() =>
      expect(lastCommand()).toEqual({
        type: 'patch',
        seq: 2,
        patches: [MOVE],
        captions: [retimed],
      }),
    )
  })

  it('打不进去的编辑整份重新加载；它报装好之前的编辑也整份重新加载', async () => {
    const { rerender } = await openLoaded()
    const values = edited(FILM, {
      op: 'replace',
      path: '/elements/h1/attributes/data-variable-values',
      value: '{}',
    })
    rerender(values)
    await waitFor(() => expect(lastCommand()).toEqual(loadOf(values, 2)))

    const next = edited(values, MOVE)
    rerender(next)
    await waitFor(() => expect(lastCommand()).toEqual(loadOf(next, 3)))

    await report({ type: 'loaded', duration: 4, seq: 3 })
    const after = edited(next, MOVE)
    rerender(after)
    await waitFor(() => expect(lastCommand()).toEqual({ type: 'patch', seq: 4, patches: [MOVE] }))
  })

  it('预览页报打不进去：整份重发当前这一份；已经整份重发过以后报的不管', async () => {
    const { rerender } = await openLoaded()
    rerender(EDITED)
    await waitFor(() => expect(lastCommand()).toMatchObject({ type: 'patch', seq: 2 }))

    await report({ type: 'needsLoad', seq: 2 })
    await waitFor(() => expect(lastCommand()).toEqual(loadOf(EDITED, 3)))
    const sent = served.latest().commands.length
    await report({ type: 'needsLoad', seq: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(served.latest().commands).toHaveLength(sent)
  })

  it('打完的报告不影响接着打', async () => {
    const { rerender } = await openLoaded()
    rerender(EDITED)
    await waitFor(() => expect(lastCommand()).toMatchObject({ type: 'patch', seq: 2 }))
    await report({ type: 'patched', duration: 4, seq: 2 })
    rerender(edited(EDITED, MOVE))
    await waitFor(() => expect(lastCommand()).toMatchObject({ type: 'patch', seq: 3 }))
  })

  it('预览页重新就绪：整份重发', async () => {
    const { rerender } = await openLoaded()
    await report({ type: 'ready' })
    await waitFor(() => expect(lastCommand()).toEqual(loadOf(FILM, 1)))
    rerender(EDITED)
    await waitFor(() => expect(lastCommand()).toEqual(loadOf(EDITED, 2)))
  })
})

describe('预览页就绪之前', () => {
  beforeEach(() => {
    served.stop()
    serve(false)
  })

  it('点播放先记下：按钮算在放并转圈；就绪后先把记下的命令发过去', async () => {
    const on = handlers()
    render(preview(on))
    await waitFor(() => expect(served.pages).toHaveLength(1))
    act(() => on.control.current?.play())
    expect(on.onPlaying).toHaveBeenLastCalledWith(true)
    expect(on.onBuffering).toHaveBeenLastCalledWith(true)
    act(() => on.control.current?.seek(1500))
    expect(on.onPlaying).toHaveBeenLastCalledWith(false)
    expect(on.onBuffering).toHaveBeenLastCalledWith(false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(served.latest().commands).toEqual([])

    await report({ type: 'ready' })
    await waitFor(() =>
      expect(commandTypes()).toEqual(['play', 'seek', 'playback', 'size', 'load']),
    )
    expect(served.latest().commands[1]).toEqual({ type: 'seek', ms: 1500, seq: 1 })
  })

  it('记下了播放但 final-cut 没了：按钮回到播放、不再转圈，记下的命令作废，也不能控制', async () => {
    const on = handlers()
    const view = render(preview(on))
    await waitFor(() => expect(served.pages).toHaveLength(1))
    act(() => on.control.current?.play())

    view.rerender(preview(on, { film: undefined }))
    expect(on.onPlaying).toHaveBeenLastCalledWith(false)
    expect(on.onBuffering).toHaveBeenLastCalledWith(false)
    expect(on.control.current).toBeNull()

    await report({ type: 'ready' })
    await waitFor(() => expect(commandTypes()).toEqual(['playback', 'size', 'unload']))
  })
})

describe('预览页报回来的', () => {
  it('时刻、播放状态、缓冲、已缓冲的区间、视频都停止下载，交给对应的回调', async () => {
    const opened = await openPreview()
    await report({ type: 'time', ms: 1500, seq: 0 })
    await report({ type: 'playing', playing: true })
    await report({ type: 'buffering', buffering: true })
    await report({ type: 'buffered', spans: [{ start: 0, end: 1.5 }] })
    await report({ type: 'mediaSettled' })
    expect(opened.onTime).toHaveBeenLastCalledWith(1500)
    expect(opened.onPlaying).toHaveBeenLastCalledWith(true)
    expect(opened.onBuffering).toHaveBeenLastCalledWith(true)
    expect(opened.onBuffered).toHaveBeenLastCalledWith([{ start: 0, end: 1.5 }])
    expect(opened.onMediaSettled).toHaveBeenCalledOnce()
  })

  it('跳转之前报出、还在路上的时刻丢掉，处理过这次跳转以后报的才用', async () => {
    const { control, onTime } = await openPreview()
    act(() => control().seek(1200))
    await waitFor(() => expect(commandTypes().at(-1)).toBe('seek'))
    await report({ type: 'time', ms: 200, seq: 0 })
    expect(onTime).not.toHaveBeenCalled()

    await report({ type: 'time', ms: 1200, seq: 1 })
    expect(onTime).toHaveBeenLastCalledWith(1200)
  })

  it('当前片段加载失败：舞台显示失败提示，点「重试」让预览页重新加载；好了以后提示收起', async () => {
    const user = userEvent.setup()
    await openPreview()
    await report({ type: 'clipFailed', failed: true })
    expect(screen.getByRole('alert')).toHaveTextContent('视频加载失败')

    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(commandTypes().at(-1)).toBe('retry'))
    await report({ type: 'clipFailed', failed: false })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('不合规的消息、别的来源或别的窗口发来的消息都丢掉', async () => {
    const opened = await openPreview()
    const page = served.latest()
    const other = document.createElement('iframe')
    document.body.append(other)
    const time = { type: 'time', ms: 1500, seq: 0 }
    await act(async () => {
      page.post(time, { origin: 'https://elsewhere.example.com' })
      page.post(time, { source: other.contentWindow })
      page.post(time, { source: null })
      page.post({ ...time, ms: '1500' })
      page.post({ ...time, ms: -1 })
      page.post({ ...time, label: '<img src=x>' })
      page.post({ type: 'clipFailed', failed: 'yes' })
      page.post({ type: 'buffered', spans: [{ start: 0 }] })
      page.post({ type: 'run', code: 'alert(1)' })
      page.post('time')
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    other.remove()
    expect(opened.onTime).not.toHaveBeenCalled()
    expect(opened.onBuffered).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // 合规的同一条照常收到：上面没收到不是因为消息没送到
    await report(time)
    expect(opened.onTime).toHaveBeenCalledExactlyOnceWith(1500)
  })

  it('卸载时还在缓冲：报出不再缓冲，之后的消息不再有回调', async () => {
    const { onBuffering, onTime, view } = await openPreview()
    await report({ type: 'buffering', buffering: true })
    const page = served.latest()
    view.unmount()
    expect(onBuffering).toHaveBeenLastCalledWith(false)

    await act(async () => {
      page.post({ type: 'time', ms: 1000, seq: 0 })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(onTime).not.toHaveBeenCalled()
  })
})

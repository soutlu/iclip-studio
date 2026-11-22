import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { starvedVideos } from '@/testing/hyperframes-player'
import { itemFileContent, server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile } from '@/testing/mocks/workspace'
import { mainFile, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  URL_A,
  URL_B,
  WRITE_URL,
  editorRoot,
  keepRealSaveDelay,
  openEditor,
  previewPages,
  previewPlayer,
  previewSettled,
  progress,
  savedClips,
  savedFilm,
  savedVersion,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  toolbar,
  transport,
  twoVideos,
  waitSaved,
} from '@/testing/final-cut-editor'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 播放', () => {
  afterEach(() => {
    starvedVideos.clear()
  })

  it('打开存着的 final-cut：显示总时长，可以播放', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(savedVersion()).toBe(1)
  })

  it('在进度条上按方向键跳到别的位置；加素材、撤销之后停在原处', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    progress().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.20 / 00:03.50')

    await user.click(await shot(/^出片 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
  })

  it('连着按方向键按几下走几步：预览晚报回来的上一次跳转的时刻不把播放头拉回去', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    // 下面要往预览的播放器上发事件：等它换上来，不靠固定的等待
    await previewSettled()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    editorRoot().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    // 真播放器的时刻由运行库异步报回：第一次跳转的时刻在预览页处理完第二次跳转以后才到
    previewPlayer().dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 0.1 } }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.20 / 00:03.50')

    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')
  })

  /** 时间线上的播放头竖线、播放条的时间读数和进度条都停在 `label`（00:00.00 的写法）。 */
  const expectPlayheadShown = (ms: number, label: string) => {
    // 测试里时间线一秒画 100 像素
    expect(screen.getByTestId('timeline-playhead')).toHaveStyle({ left: `${ms / 10}px` })
    expect(within(transport()).getByText(label)).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', `${label} / 00:03.50`)
  }
  /** 时间线上播放位置的读数：时间尺按编辑器的播放头位置（不是逐帧的时钟）。 */
  const rulerText = () =>
    screen.getByRole('slider', { name: '时间线播放位置' }).getAttribute('aria-valuetext')

  it('在放时播放头竖线、时间读数、进度条跟着预览报来的每一条时刻走；暂停后三处和时间尺都停在最后的时刻', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    await waitFor(() => expect(previewPlayer()).toHaveProperty('paused', false))

    // 每条间隔一帧左右，远不到 0.1 秒
    for (const [ms, label] of [
      [400, '00:00.40'],
      [430, '00:00.43'],
      [460, '00:00.46'],
    ] as const) {
      previewPlayer().runtimeTime = ms / 1000
      await waitFor(() => expectPlayheadShown(ms, label))
    }

    await user.click(within(transport()).getByRole('button', { name: '暂停' }))
    await waitFor(() => expect(rulerText()).toBe('00:00.46'))
    expectPlayheadShown(460, '00:00.46')
  })

  it('在放时按播放头位置算的功能（时间尺）也跟着走，最多约 0.1 秒跟一次', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    await waitFor(() => expect(previewPlayer()).toHaveProperty('paused', false))

    // 刚开播的那一帧报的时刻已经跟过一次：等过 0.1 秒再让时钟走
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)))
    previewPlayer().runtimeTime = 0.4
    await waitFor(() => expect(rulerText()).toBe('00:00.40'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)))
    previewPlayer().runtimeTime = 1.2
    await waitFor(() => expect(rulerText()).toBe('00:01.20'))
    expect(within(transport()).getByRole('button', { name: '暂停' })).toBeVisible()
  })

  it('在放时按方向键从竖线所在的时刻走一步，不按落后的播放头位置', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    await waitFor(() => expect(previewPlayer()).toHaveProperty('paused', false))

    // 0.4 秒那条跟进了播放头位置；紧接着的 0.43 秒不到 0.1 秒，只有竖线跟上
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)))
    previewPlayer().runtimeTime = 0.4
    await waitFor(() => expect(rulerText()).toBe('00:00.40'))
    previewPlayer().runtimeTime = 0.43
    await waitFor(() => expectPlayheadShown(430, '00:00.43'))

    editorRoot().focus()
    await user.keyboard('{ArrowRight}')
    expectPlayheadShown(530, '00:00.53')
  })

  it('本地跳转马上挪到三处，不等预览报回来', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()

    editorRoot().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expectPlayheadShown(300, '00:00.30')
    expect(rulerText()).toBe('00:00.30')
  })

  it('预览素材时播放条显示素材的时间和原作总长，在进度条上跳转夹在选区里、不离开素材；取消选中后回到 final-cut 的时间', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    progress().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')

    // 素材 A 一共 6 秒，镜头 2 是 2–4.5 秒
    await user.click(await shot(/^出片 A 镜头 2，/))
    const material = screen.getByRole('region', { name: '素材 · 镜头组 1 · 出片 A · 镜头 2' })
    expect(material).toHaveTextContent(/^素材 · 镜头组 1 · 出片 A · 镜头 2$/)
    expect(within(transport()).getByText('00:02.00')).toBeVisible()
    expect(within(transport()).getByText('/ 00:06.00')).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:06.00')

    progress().focus()
    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.10 / 00:06.00')
    await user.keyboard('{End}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:04.50 / 00:06.00')
    await user.keyboard('{Home}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:06.00')
    expect(material).toBeInTheDocument()
    expect(material.querySelector('video')?.currentTime).toBeCloseTo(2.001, 6)

    await user.keyboard('{Shift>}')
    await user.click(await shot(/^出片 A 镜头 2，/))
    await user.keyboard('{/Shift}')
    expect(material).not.toBeInTheDocument()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')
  })

  it('空的 final-cut 里预览素材：进度条按素材可以拖，取消选中后又置灰', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(progress()).toHaveAttribute('data-disabled')

    await user.click(await shot(/^出片 B 镜头 2，/))
    expect(progress()).not.toHaveAttribute('data-disabled')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.50 / 00:03.00')
    progress().focus()
    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.60 / 00:03.00')

    await user.keyboard('{Shift>}')
    await user.click(await shot(/^出片 B 镜头 2，/))
    await user.keyboard('{/Shift}')
    expect(progress()).toHaveAttribute('data-disabled')
  })

  it('当前片段数据不够时舞台转圈，播放按钮是「暂停」', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    starvedVideos.add(URL_A)
    await openEditor()
    await previewSettled()

    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    expect(await screen.findByRole('status', { name: '正在缓冲' })).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '暂停' })).toBeVisible()
    expect(previewPlayer()).toHaveProperty('paused', true)
  })

  /** 最后一次发给预览页的 final-cut。 */
  const lastLoad = () => {
    const loads = previewPages.latest().commands.filter((command) => command.type === 'load')
    const load = loads.at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    return { html: load.html, count: loads.length }
  }

  it('预览页拿到的是当前的主文件（没存的改动也在里面），<base> 指向凭令牌取工程文件的地址', async () => {
    keepRealSaveDelay()
    const stored = putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000 })], { width: 720, height: 1280 }),
    )
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    const { origin, token } = previewPages.latest()
    expect(lastLoad().html).toContain(
      `<base href="${origin}/api/final-cut/preview/${encodeURIComponent(token)}/files/">`,
    )
    expect(lastLoad().html).not.toContain('/hyperframes/test-fixtures/"')

    // 加的片段直接打进预览里正在播的那一份
    await user.click(await shot(/^出片 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(
        previewPlayer().iframeElement.contentDocument?.querySelector(`video[src="${URL_B}"]`),
      ).not.toBeNull(),
    )
    // 这时还没存：工作区里还是打开时的那一份
    expect(mockProjectMain(CONVERSATION)?.version).toBe(stored.version)
  })

  it('预览令牌换了一张：预览页不重新加载，只有取工程文件的 <base> 换成新令牌', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const { queryClient } = await openEditor()
    await previewSettled()
    const page = previewPages.latest()
    const frame = page.frame
    const src = frame.getAttribute('src')
    server.use(
      http.post('*/api/conversations/:conversationId/final-cut/preview', () =>
        HttpResponse.json({
          origin: page.origin,
          token: `${page.token}-renewed`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    )
    await act(() =>
      queryClient.refetchQueries({ queryKey: ['whole-film', 'preview', CONVERSATION] }),
    )
    await waitFor(() =>
      expect(lastLoad().html).toContain(
        `/api/final-cut/preview/${encodeURIComponent(`${page.token}-renewed`)}/files/`,
      ),
    )
    expect(previewPages.pages).toHaveLength(1)
    expect(screen.getByTitle('final-cut 预览')).toBe(frame)
    expect(frame.getAttribute('src')).toBe(src)
  })

  it('工程里别的文件变了：重新发一次 final-cut 给预览页', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const { socket } = await openEditor()
    await previewSettled()
    const before = lastLoad().count
    act(() =>
      socket.deliver({
        payload: {
          changes: [
            { change: 'modified', path: 'final-cut/compositions/fixtures/fixture-fields.html' },
          ],
        },
        session_id: CONVERSATION,
        timestamp: '2026-11-15T08:00:00+00:00',
        type: 'event.fs.changed',
      }),
    )
    await waitFor(() => expect(lastLoad().count).toBe(before + 1))
  })

  it('取不到预览令牌：预览区说明原因，点「重试」重新取到后加载预览', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    let refused = true
    server.use(
      http.post('*/api/conversations/:conversationId/final-cut/preview', () =>
        refused ? HttpResponse.json({ detail: '没有配置预览域名' }, { status: 422 }) : undefined,
      ),
    )
    const user = userEvent.setup()
    await openEditor()
    const preview = screen.getByRole('region', { name: '预览' })
    expect(await within(preview).findByRole('alert')).toHaveTextContent(
      '预览加载失败：没有配置预览域名',
    )
    expect(within(preview).queryByTitle('final-cut 预览')).not.toBeInTheDocument()

    refused = false
    await user.click(within(preview).getByRole('button', { name: '重试' }))
    expect(await within(preview).findByTitle('final-cut 预览')).toBeInTheDocument()
    expect(within(preview).queryByRole('alert')).not.toBeInTheDocument()
    await previewSettled()
  })
})

describe('final-cut 编辑器 · 播放条设置', () => {
  const player = previewPlayer
  const playerUp = previewSettled

  it('M 静音、再按恢复，⇧L 开关循环：交给播放器，final-cut 不保存、不进撤销', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()
    editorRoot().focus()

    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '开启声音' })).toBeVisible()
    await waitFor(() => expect(player().muted).toBe(true))
    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await waitFor(() => expect(player().muted).toBe(false))

    await user.keyboard('{Shift>}L{/Shift}')
    expect(within(transport()).getByRole('button', { name: '循环播放' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await waitFor(() => expect(player().loop).toBe(true))
    // 不按 Shift 的 L 不是快捷键
    await user.keyboard('l')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(player().loop).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(savedVersion()).toBe(1)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('选 2×：素材预览和 final-cut 预览都是 2×，加进 final-cut 的片段直接打进预览，还是 2×', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()

    await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '2×' }))
    expect(within(transport()).getByRole('button', { name: '播放速度 2×' })).toBeVisible()
    await waitFor(() => expect(player().playbackRate).toBe(2))

    // 播放器的片段都在 iframe 里，页面上的 video 只有素材预览这一个
    await user.click(await shot(/^出片 B 镜头 1，/))
    expect(document.querySelector('video')?.playbackRate).toBe(2)
    const old = player()
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    await waitFor(() =>
      expect(player().iframeElement.contentDocument?.querySelectorAll('video')).toHaveLength(3),
    )
    expect(player()).toBe(old)
    expect(player().playbackRate).toBe(2)
  })

  describe('全屏', () => {
    const fullscreen: { element: Element | null } = { element: null }
    const announce = (element: Element | null) => {
      fullscreen.element = element
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }
    const requestFullscreen = vi.fn(function (this: Element) {
      return announce(this)
    })
    const exitFullscreen = vi.fn(() => announce(null))

    beforeEach(() => {
      fullscreen.element = null
      Object.defineProperties(document, {
        fullscreenEnabled: { configurable: true, value: true },
        fullscreenElement: { configurable: true, get: () => fullscreen.element },
        exitFullscreen: { configurable: true, value: exitFullscreen },
      })
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: requestFullscreen,
      })
    })

    afterEach(() => {
      for (const name of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen'])
        Reflect.deleteProperty(document, name)
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
      requestFullscreen.mockClear()
      exitFullscreen.mockClear()
    })

    it('F 把预览连同播放条一起全屏，菜单挂在全屏的元素里；Esc 退出全屏', async () => {
      putMockProjectMain(CONVERSATION, twoVideos())
      const user = userEvent.setup()
      await openEditor()
      await playerUp()
      editorRoot().focus()

      await user.keyboard('f')
      const stage = fullscreen.element
      expect(stage).toContainElement(screen.getByRole('region', { name: '预览' }))
      expect(stage).toContainElement(transport())
      expect(within(transport()).getByRole('button', { name: '退出全屏' })).toBeVisible()

      await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
      const menu = await screen.findByRole('menu')
      expect(stage).toContainElement(menu)
      // 菜单里按的键不是编辑器的快捷键：不静音、不挪播放头
      await user.keyboard('m{ArrowRight}')
      expect(screen.getByRole('menu')).toBeVisible()
      await user.click(within(menu).getByRole('menuitemradio', { name: '1×' }))
      expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
      expect(within(transport()).getByText('00:00.00')).toBeVisible()

      editorRoot().focus()
      await user.keyboard('{Escape}')
      expect(exitFullscreen).toHaveBeenCalledTimes(1)
      expect(within(transport()).getByRole('button', { name: '全屏' })).toBeVisible()
    })
  })
})

describe('final-cut 编辑器 · 导出', () => {
  const EXPORT_ID = '22222222-3333-4444-8555-666666666666'
  const EXPORTS_URL = '*/api/conversations/:conversationId/whole-film/exports'
  const EXPORT_URL = '*/api/conversations/:conversationId/whole-film/exports/:exportId'
  const LATEST_URL = '*/api/conversations/:conversationId/whole-film/exports/latest'
  const DOWNLOAD_URL = 'https://oss.example.com/whole-film/export.mp4'

  const exportOf = (state: object) => ({
    id: EXPORT_ID,
    locale: null,
    status: 'queued',
    progress: null,
    queuePosition: null,
    error: null,
    downloadUrl: null,
    ...state,
  })

  const serveLatest = (...states: (object | null)[]) => {
    let reads = 0
    server.use(
      http.get(LATEST_URL, () => {
        const state = states[Math.min(reads, states.length - 1)] ?? null
        reads += 1
        return HttpResponse.json({ export: state === null ? null : exportOf(state) })
      }),
    )
  }

  const trackCancels = (answer: () => Response = () => new HttpResponse(null, { status: 204 })) => {
    const cancelled: string[] = []
    server.use(
      http.delete(EXPORT_URL, ({ params }) => {
        cancelled.push(String(params['exportId']))
        return answer()
      }),
    )
    return cancelled
  }

  const DONE = { status: 'done', progress: 1, downloadUrl: DOWNLOAD_URL }
  const RENDERING = { status: 'rendering', progress: 0.4 }

  it('「导出」和保存状态放进工作台顶栏，不在编辑器里；编辑器没有标题栏，也没有关闭按钮', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toBeVisible()
    expect(editorRoot()).not.toContainElement(exportButton)
    expect(screen.getByRole('status', { name: '已自动保存' })).toBeVisible()
    expect(within(editorRoot()).queryByRole('banner')).toBeNull()
    expect(within(editorRoot()).queryByRole('button', { name: /关闭/ })).toBeNull()
  })

  it('打开编辑器时最近一次导出还没结束：接着显示进度，关掉编辑器不取消它', async () => {
    const cancelled = trackCancels()
    serveLatest({ status: 'rendering', progress: null }, RENDERING)
    putMockProjectMain(CONVERSATION, twoVideos())
    const { close } = await openEditor()
    expect(await screen.findByText('正在渲染…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
    expect(
      await screen.findByText('正在渲染 40%', undefined, { timeout: 3_000 }),
    ).toBeInTheDocument()
    close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(cancelled).toEqual([])
  })

  it('打开编辑器时最近一次导出已完成：直接可以下载', async () => {
    serveLatest(DONE)
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByRole('button', { name: '下载成片' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重新导出' })).toBeInTheDocument()
  })

  it('渲染中可以取消', async () => {
    const user = userEvent.setup()
    let cancelledNow = false
    const cancelled = trackCancels(() => {
      cancelledNow = true
      return new HttpResponse(null, { status: 204 })
    })
    server.use(
      http.get(LATEST_URL, () =>
        HttpResponse.json({
          export: exportOf(cancelledNow ? { status: 'cancelled' } : RENDERING),
        }),
      ),
    )
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '取消导出' }))
    expect(await screen.findByText('已取消导出')).toBeInTheDocument()
    expect(cancelled).toEqual([EXPORT_ID])
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('取消时正赶上交给渲染服务（409）：提示原因，进度照旧', async () => {
    const user = userEvent.setup()
    trackCancels(() =>
      HttpResponse.json({ detail: '正在交给渲染服务，稍后再取消' }, { status: 409 }),
    )
    serveLatest(RENDERING)
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '取消导出' }))
    expect(await screen.findByText(/正在交给渲染服务，稍后再取消/)).toBeInTheDocument()
    expect(screen.getByText('正在渲染 40%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
  })

  /** 发起导出时工作区里的主文件，一次发起记一份。 */
  const trackStarts = () => {
    const mainAtStart: string[] = []
    server.use(
      http.post(EXPORTS_URL, () => {
        mainAtStart.push(savedFilm())
        return HttpResponse.json({ exportId: EXPORT_ID }, { status: 202 })
      }),
    )
    return mainAtStart
  }

  it('加了素材马上导出：先把 final-cut 存好，再发起导出', async () => {
    keepRealSaveDelay()
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    serveLatest(null, DONE)
    await openEditor()
    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: '导出' }))
    expect(await screen.findByRole('button', { name: '下载成片' })).toBeInTheDocument()
    expect(mainAtStart).toHaveLength(1)
    expect(mainAtStart[0]?.match(/<video [^>]*>/g)).toHaveLength(1)
  })

  it('上次导出好了，点「重新导出」再发起一次', async () => {
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    serveLatest(DONE)
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '重新导出' }))
    await waitFor(() => expect(mainAtStart).toEqual([twoVideos()]))
  })

  it('改动没存进去：不发起导出，说明保存失败的原因', async () => {
    keepRealSaveDelay()
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    let attempts = 0
    server.use(
      http.put(WRITE_URL, () => {
        attempts += 1
        return HttpResponse.json({ detail: '工作区暂时写不进去' }, { status: 503 })
      }),
    )
    const { close } = await openEditor()
    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: '导出' }))
    expect(await screen.findByText(/工作区暂时写不进去$/)).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mainAtStart).toEqual([])
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')

    // 关掉编辑器时还会补存一次：让它在这个用例里失败掉，不带到后面的用例里去写别人的主文件
    const before = attempts
    close()
    await waitFor(() => expect(attempts).toBeGreaterThan(before))
  })

  it('没开通（422）：显示原因，可以重新导出', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(EXPORTS_URL, () =>
        HttpResponse.json({ detail: '成片导出没有开通' }, { status: 422 }),
      ),
    )
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText(/成片导出没有开通$/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it.each([
    ['渲染服务报的原因', 'media-unreachable', 'ECONNRESET', '部分素材读取失败，请稍后重新导出'],
    ['渲染服务重启过', 'RENDER_LOST', 'render service restarted', '渲染服务已重启，请重新导出'],
    ['交出去太久没结束', 'PROVIDER_TIMEOUT', 'no end after 6 h', '导出等待超时，请重新导出'],
    ['渲染服务连不上', 'RENDER_UNAVAILABLE', 'connect refused', '渲染服务无法连接，请稍后重新导出'],
    [
      '没通过导出前检查',
      'lint-failed',
      'root missing data-composition-id',
      'final-cut 未通过导出前检查，无法导出',
    ],
    ['没见过的错误码', 'SUBMIT_INTERRUPTED', 'worker restarted', '成片导出失败，请重新导出'],
  ])('导出失败（%s）：按原因说一句话，不露给开发看的原文', async (_, code, message, text) => {
    serveLatest({ status: 'failed', error: { code, message } })
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status')
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('用到的字体不在组件库里：说出是哪些字体，可以重新导出', async () => {
    serveLatest({
      status: 'failed',
      error: { code: 'font-missing', message: 'Comic Sans MS、Papyrus' },
    })
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(
      await screen.findByText(
        '用到的字体 Comic Sans MS、Papyrus 不在可选字体里，无法导出；请换成可选字体后重新导出',
      ),
    ).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('渲染服务不收这份 final-cut：显示它给的原因', async () => {
    serveLatest({
      status: 'failed',
      error: { code: 'RENDER_REJECTED', message: '素材地址的主机不在允许范围' },
    })
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(/素材地址的主机不在允许范围$/)).toHaveAttribute('role', 'status')
  })
})

describe('final-cut 编辑器 · 组件、块页签', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const openTab = (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(within(side()).getByRole('tab', { name }))
  const itemCard = (name: RegExp) =>
    within(within(side()).getByRole('list')).getByRole('group', { name })
  const cardNames = () =>
    within(within(side()).getByRole('list'))
      .getAllByRole('group')
      .map((element) => element.getAttribute('aria-label'))
  // 点一下卡片就加到播放头
  const addAtPlayhead = (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
    user.click(within(itemCard(name)).getByRole('button', { name }))
  const savedItems = () => savedFilm().match(/<div [^>]*class="clip component"[^>]*>/g) ?? []
  const previewHtml = () => previewPlayer().getAttribute('srcdoc') ?? ''
  const playerUp = previewSettled

  it('侧栏六个页签：镜头、贴片、场景、配乐、字幕、属性；贴片、场景各记着自己的搜索词和分类，切走再回来还在', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(
      within(side())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['镜头', '贴片', '场景', '配乐', '字幕', '属性'])
    await openTab(user, '贴片')
    expect(within(side()).getByRole('list', { name: '贴片' })).toBeVisible()
    await user.type(within(side()).getByRole('searchbox', { name: '搜索贴片' }), '圆环')
    expect(cardNames()).toEqual(['测试叠加，4 秒'])

    await openTab(user, '场景')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toHaveValue('')
    const blockChips = () => within(side()).getByRole('radiogroup', { name: '场景分类' })
    await user.click(within(blockChips()).getByRole('radio', { name: '品牌' }))
    expect(cardNames()).toEqual(['示例品牌 片尾，3 秒'])

    await openTab(user, '配乐')
    await openTab(user, '贴片')
    expect(within(side()).getByRole('searchbox', { name: '搜索贴片' })).toHaveValue('圆环')
    expect(cardNames()).toEqual(['测试叠加，4 秒'])
    await openTab(user, '场景')
    expect(within(blockChips()).getByRole('radio', { name: '品牌' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(cardNames()).toEqual(['示例品牌 片尾，3 秒'])
  })

  it('块页签里加到播放头：条目文件先拷进工程；第一行那段时间有片段，就在它下面新开一行；固定尺寸的块缩进画面', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await openTab(user, '场景')
    await addAtPlayhead(user, /^测试画面/)

    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    expect(
      mockWorkspaceFile(CONVERSATION, 'final-cut/compositions/fixtures/fixture-scene.html')
        ?.content,
    ).toBe(itemFileContent('compositions/fixtures/fixture-scene.html'))
    const [clip] = savedItems()
    expect(clip).toContain('data-label="测试画面"')
    expect(clip).toContain('data-composition-id="fixture-scene"')
    expect(clip).toContain('data-start="0" data-duration="6" data-track-index="1"')
    expect(clip).toContain('data-variable-values="{}"')
    expect(clip).toContain(
      'left: 50%; top: 50%; width: 1920px; height: 1080px; translate: -50% -50%; scale: 0.375',
    )
    expect(
      within(screen.getByRole('group', { name: '画面 2' })).getByRole('group'),
    ).toHaveAccessibleName('测试画面，6.0 秒')

    await playerUp()
    expect(previewHtml()).toContain(
      'data-composition-src="compositions/fixtures/fixture-scene.html"',
    )
    expect(previewHtml()).toContain('scale: 0.375')
  })

  it('组件页签里加到播放头：第一行空着也放在画面区最下面新开的一行，从播放头开始；撤销回去', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    progress().focus()
    await user.keyboard('{End}')
    expect(within(transport()).getByText('00:03.50')).toBeVisible()
    await openTab(user, '贴片')
    await addAtPlayhead(user, /^测试叠加/)

    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    expect(savedItems()[0]).toContain('data-start="3.5" data-duration="4" data-track-index="1"')
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedItems()).toHaveLength(0))
    expect(savedClips()).toHaveLength(2)
  })

  it('上一个还没加完又点「加到播放头」：只加一个，提示稍后再加', async () => {
    await openEditor()
    await openTab(userEvent.setup(), '贴片')
    const add = within(itemCard(/^测试叠加/)).getByRole('button', { name: '加到播放头' })
    fireEvent.click(add)
    fireEvent.click(add)
    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(savedItems()).toHaveLength(1)
    expect(screen.getByText('上一个贴片或场景正在加入轨道，请稍后再试')).toBeVisible()
  })
})

describe('final-cut 编辑器 · 侧栏页签', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const tab = (name: string) => within(side()).getByRole('tab', { name })
  const props = () => screen.getByRole('tabpanel', { name: '属性' })
  const shotsPanel = () => screen.getByRole('tabpanel', { name: '镜头' })
  const selectionDot = () => within(tab('属性')).queryByTestId('selection-dot')
  const row = (number = 1) => screen.getByRole('group', { name: `画面 ${String(number)}` })
  // twoVideos 的两个片段同名，按时长认：第一个 2 秒，第二个 1.5 秒
  const FIRST = /2\.0 秒$/
  const SECOND = /1\.5 秒$/
  const clip = (name: RegExp) => within(row()).getByRole('button', { name })

  const openTwo = async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('默认停在「镜头」，素材片只在这个页签里；选中片段切到「属性」、页签名后出现圆点，取消选中回到「镜头」，选中的镜头范围还在', async () => {
    const user = await openTwo()
    expect(tab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(within(shotsPanel()).getByRole('region', { name: '视频素材区' })).toBeVisible()
    expect(screen.getAllByRole('region', { name: '视频素材区' })).toHaveLength(1)
    await user.click(await within(shotsPanel()).findByRole('button', { name: /^出片 A 镜头 2，/ }))
    const range = () =>
      within(shotsPanel()).getByRole('group', { name: /^选中的范围 2\.0–4\.5 秒/ })
    expect(range()).toBeVisible()
    expect(selectionDot()).toBeNull()

    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(selectionDot()).not.toBeNull()
    expect(tab('属性')).toHaveAccessibleName('属性')
    expect(screen.queryByRole('region', { name: '视频素材区' })).toBeNull()

    await user.keyboard('{Escape}')
    expect(tab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(selectionDot()).toBeNull()
    expect(range()).toBeVisible()

    await user.click(tab('贴片'))
    expect(screen.queryByRole('region', { name: '视频素材区' })).toBeNull()
  })

  it('选中片段自动切到「属性」，换选别的片段仍在「属性」；选中着时点目录页签显示目录，选中不变', async () => {
    const user = await openTwo()
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(within(props()).getByRole('banner')).getByText('2.00s')).toBeVisible()

    await user.click(tab('场景'))
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toBeVisible()
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'true')

    await user.click(clip(SECOND))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(within(props()).getByRole('banner')).getByText('1.50s')).toBeVisible()
  })

  it('点时间线空白处取消选中：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.click(row())
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'false')
    expect(tab('场景')).toHaveAttribute('aria-selected', 'true')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toBeVisible()
  })

  it('按 Esc 取消选中：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('配乐'))
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Escape}')
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'false')
    expect(tab('配乐')).toHaveAttribute('aria-selected', 'true')
    expect(within(side()).getByRole('searchbox', { name: '搜索音频' })).toBeVisible()
  })

  it('撤销让选中的片段不存在了：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.click(
      within(within(side()).getByRole('group', { name: /^测试画面/ })).getByRole('button', {
        name: '加到播放头',
      }),
    )
    const added = await within(row(2)).findByRole('button', { name: /^选中：测试画面，/ })
    await user.click(added)
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: '画面 2' })).toBeNull())
    expect(tab('场景')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('自动切到「属性」再回来：目录页签里的搜索词和分类都还在', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.type(within(side()).getByRole('searchbox', { name: '搜索场景' }), '片尾')
    const chips = () => within(side()).getByRole('radiogroup', { name: '场景分类' })
    await user.click(within(chips()).getByRole('radio', { name: '品牌' }))
    await user.click(clip(FIRST))
    expect(within(side()).queryByRole('searchbox', { name: '搜索场景' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toHaveValue('片尾')
    expect(within(chips()).getByRole('radio', { name: '品牌' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await user.click(tab('配乐'))
    await user.type(within(side()).getByRole('searchbox', { name: '搜索音频' }), '吉他')
    await user.click(clip(SECOND))
    expect(within(side()).queryByRole('searchbox', { name: '搜索音频' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(within(side()).getByRole('searchbox', { name: '搜索音频' })).toHaveValue('吉他')
  })

  it('在目录的卡片上按 ] 选中片段、切到「属性」后：焦点交还编辑器的根节点，Delete 照常删掉选中的片段', async () => {
    const user = await openTwo()
    await user.click(tab('贴片'))
    within(within(side()).getByRole('group', { name: /^测试叠加/ }))
      .getByRole('button', { name: '加到播放头' })
      .focus()
    await user.keyboard(']')
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(props()).getByRole('heading', { name: '已选中 2 个片段' })).toBeVisible()
    expect(editorRoot()).toHaveFocus()

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(0))
    expect(tab('贴片')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('final-cut 编辑器 · 配乐页签的音频库', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })

  it('切到「音频库」列出参考音频库的配乐，右键「加到播放头」放进配乐行；切到「音效」只列音效', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(side()).getByRole('tab', { name: '配乐' }))
    await user.click(within(side()).getByRole('radio', { name: '音频库' }))
    const library = await within(side()).findByRole('list', { name: '音频库' })
    const guitar = await within(library).findByRole('button', { name: '轻快原声吉他' })
    expect(within(library).getByRole('button', { name: '城市夜景氛围' })).toBeVisible()
    expect(within(library).queryByRole('button', { name: '翻页声' })).toBeNull()

    fireEvent.contextMenu(guitar)
    await user.click(await screen.findByRole('menuitem', { name: '加到播放头' }))
    await waitSaved(() =>
      expect(savedFilm()).toMatch(
        /<audio [^>]*src="http:\/\/localhost\/mock-audio\/generated\.wav\?library=guitar"/,
      ),
    )
    expect(
      within(screen.getByRole('group', { name: '配乐' })).getByRole('group', {
        name: /^轻快原声吉他，/,
      }),
    ).toBeVisible()

    await user.click(within(side()).getByRole('radio', { name: '音效' }))
    expect(
      await within(within(side()).getByRole('list', { name: '音频库' })).findByRole('button', {
        name: '翻页声',
      }),
    ).toBeVisible()
    expect(within(side()).queryByRole('button', { name: /^轻快原声吉他/ })).toBeNull()
  })
})

describe('final-cut 编辑器 · 切走再切回', () => {
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const labels = () =>
    within(row())
      .getAllByRole('button', { name: /^选中：/ })
      .map((button) => /^选中：(.+?)，/.exec(button.getAttribute('aria-label') ?? '')?.[1])

  /** 接下来的 `count` 次保存各自先压着，`release` 按到达的先后放行一次，放行后照常存。 */
  const holdSaves = (count: number) => {
    const waiting: (() => void)[] = []
    let held = 0
    server.use(
      http.put(WRITE_URL, async () => {
        if (held >= count) return undefined
        held += 1
        await new Promise<void>((resolve) => waiting.push(resolve))
        return undefined
      }),
    )
    return { held: () => held, release: () => waiting.shift()?.() }
  }

  const stillReading = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.getByRole('status')).toHaveTextContent('正在读取 final-cut…')
    expect(screen.queryByRole('toolbar', { name: '剪辑工具' })).toBeNull()
  }

  /** 在别的页签上停一会儿再切回来。 */
  const switchBack = async (reopen: () => void) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    reopen()
  }

  it('改完马上切走、保存还没回来时切回：等保存完才读主文件，读到改过的，接着改照常保存', async () => {
    keepRealSaveDelay()
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: '甲', src: URL_A, duration: 2_000 }),
          video({ id: 'clip-2', label: '乙', src: URL_B, start: 2_000 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    const user = userEvent.setup()
    const { close, reopen } = await openEditor()
    await user.click(within(row()).getByRole('button', { name: /^选中：甲，/ }))
    await user.keyboard('{Delete}')
    expect(labels()).toEqual(['乙'])

    const saves = holdSaves(1)
    close()
    await waitFor(() => expect(saves.held()).toBe(1))
    await switchBack(reopen)
    await stillReading()
    saves.release()
    await screen.findByRole('toolbar', { name: '剪辑工具' })
    expect(labels()).toEqual(['乙'])

    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(labels()).toEqual(['乙', 'A · 镜头 1'])
    expect(screen.queryByText(/已在别处修改/)).toBeNull()
  })

  it('一次保存还在途时又改了一处再切走：切回时等两次保存都完成才读主文件', async () => {
    keepRealSaveDelay()
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: '甲', src: URL_A, duration: 2_000 }),
          video({ id: 'clip-2', label: '乙', src: URL_B, start: 2_000 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    const user = userEvent.setup()
    const { close, reopen } = await openEditor()
    const saves = holdSaves(2)
    await user.click(within(row()).getByRole('button', { name: /^选中：甲，/ }))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(saves.held()).toBe(1), { timeout: 4000 })
    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(labels()).toEqual(['乙', 'A · 镜头 1']))

    close()
    await switchBack(reopen)
    await stillReading()
    saves.release()
    await waitFor(() => expect(saves.held()).toBe(2))
    await stillReading()
    saves.release()
    await screen.findByRole('toolbar', { name: '剪辑工具' })
    expect(labels()).toEqual(['乙', 'A · 镜头 1'])
    expect(savedClips()).toHaveLength(2)
    expect(screen.queryByText(/已在别处修改/)).toBeNull()
  })
})

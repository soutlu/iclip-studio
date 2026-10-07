import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { draftStorageKey } from './use-edit-draft'
import { VideoEditor } from './video-editor'

/** mediabunny 的替身：按地址给关键帧表与时长，都没有音轨。jsdom 读不了真文件。 */
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())

vi.mock('mediabunny', () => {
  class UrlSource {
    readonly url: string
    constructor(url: string) {
      this.url = url
    }
  }
  class Input {
    private readonly url: string
    constructor(options: { source: UrlSource }) {
      this.url = options.source.url
    }
    getPrimaryVideoTrack = () => Promise.resolve({ url: this.url })
    getPrimaryAudioTrack = () => Promise.resolve(null)
    computeDuration = () => Promise.resolve(files.get(this.url)?.duration ?? 0)
    dispose = () => {}
  }
  class EncodedPacketSink {
    private readonly keyframes: number[]
    constructor(track: { url: string }) {
      this.keyframes = files.get(track.url)?.keyframes ?? []
    }
    getFirstKeyPacket = () => Promise.resolve(this.at(0))
    getNextKeyPacket = (packet: { timestamp: number }) =>
      Promise.resolve(this.at(this.keyframes.indexOf(packet.timestamp) + 1))
    private at = (index: number) => {
      const timestamp = this.keyframes[index]
      return timestamp === undefined ? null : { timestamp }
    }
  }
  return { EncodedPacketSink, Input, UrlSource, MP4: {}, QTFF: {} }
})

const CONVERSATION = 'conversation-1'
const ROOT_URL = 'https://example.com/root.mp4'
const EDITED_URL = 'https://example.com/edited.mp4'
const ROOT_ID = '0f6a2c9e-8d4b-4c1e-9a7f-3b5d6e8f1a2b'
const root = makeGenerationJob({ id: ROOT_ID, outputUrl: ROOT_URL, shotIndex: 1 })

const renderEditor = () =>
  renderWithProviders(
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={() => {}}
      root={root}
      shotIndex={1}
    />,
  )

/** 基于原片改第 3–4 段（2–4 秒）的编辑段。 */
const editSegment = (overrides: Parameters<typeof makeGenerationJob>[0]) =>
  makeGenerationJob({
    rootJobId: ROOT_ID,
    sourceJobId: ROOT_ID,
    rangeStartMs: 2000,
    rangeEndMs: 4000,
    request: { prompt: '把背景换成海边' },
    createdAt: '2026-09-16T10:02:00Z',
    ...overrides,
  })
const serveChain = (items: ReturnType<typeof makeGenerationJob>[]) =>
  server.use(http.get('*/api/generations', () => HttpResponse.json({ items })))

const timeline = () => screen.findByRole('region', { name: '视频编辑时间线' })

let restoreMedia = () => {}

beforeEach(() => {
  // 原片 8 秒，每秒一个关键帧。
  files.set(ROOT_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
  window.localStorage.clear()
})

afterEach(() => {
  restoreMedia()
  restoreMedia = () => {}
  vi.restoreAllMocks()
  files.clear()
})

describe('VideoEditor', () => {
  it.each([
    {
      name: '默认项能编辑但不在首位时用默认项',
      models: { default: 'wan3.0-video', items: ['vendor-a-seedance-2-5', 'wan3.0-video'] },
      expected: 'wan3.0-video',
    },
    {
      name: '默认项不能编辑时退到第一个能编辑的',
      models: {
        default: 'vendor-a-seedance-2-0',
        items: ['wan3.0-video', 'vendor-a-seedance-2-0', 'vendor-a-seedance-2-5'],
      },
      expected: 'wan3.0-video',
    },
  ])('编辑模型：$name', async ({ models, expected }) => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(models)))
    await renderEditor()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '编辑模型' })).toHaveTextContent(expected),
    )
  })

  it('模型清单读不到时给出重新加载入口，点了再拉一次', async () => {
    let requests = 0
    server.use(
      http.get('*/api/generations/video-models', () => {
        requests += 1
        return HttpResponse.json({ detail: '模型清单读不到' }, { status: 500 })
      }),
    )
    await renderEditor()

    expect(await screen.findByText(/模型清单读不到/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '重新加载模型' }))

    await waitFor(() => expect(requests).toBe(2))
  })

  it('时间线按关键帧分段，原声没有音轨时写「无声」', async () => {
    serveChain([])
    await renderEditor()

    const track = await timeline()
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(8)
    expect(within(track).getAllByText('无声').length).toBeGreaterThan(0)
    expect(screen.getByText('先在时间线上点选要改的段')).toBeVisible()
  })
})

describe('版本条与草稿', () => {
  it('只有原片一版、没有改动时没得切，不显示版本条', async () => {
    serveChain([])
    await renderEditor()

    await timeline()
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
    expect(screen.queryByRole('group', { name: '预览版本' })).toBeNull()
    expect(screen.queryByRole('button', { name: '合成成片' })).toBeNull()
  })

  it('没有存着的草稿时按服务端重建：完成的 AI 结果放回原位，多出「未合成」一格并选中', async () => {
    restoreMedia = stubMediaDurations({ [EDITED_URL]: 2.5 })
    serveChain([editSegment({ outputUrl: EDITED_URL })])
    const user = userEvent.setup()
    await renderEditor()

    const strip = await screen.findByRole('group', { name: '视频版本' })
    await waitFor(() =>
      expect(
        within(strip)
          .getAllByRole('button')
          .map((entry) => entry.getAttribute('aria-label')),
      ).toEqual(['未合成', 'V1']),
    )
    expect(within(strip).getByRole('button', { name: '未合成' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // 第 3–4 段换成了 2.5 秒的 AI 结果：共 7 段，比 V1 长 0.5 秒。
    const track = await timeline()
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent(
      '共 8.5 秒 · 比 V1 长 0.5 秒',
    )
    expect(screen.getByRole('group', { name: '预览版本' })).toBeVisible()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()

    // 点 V1 看这一版本身：时间线只读，下载可用，草稿还在。
    await user.click(within(strip).getByRole('button', { name: 'V1' }))
    expect(within(strip).getByRole('button', { name: 'V1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('group', { name: '预览版本' })).toBeNull()
    expect(screen.getByRole('button', { name: '下载' })).toBeEnabled()
    expect(screen.getByText(/正在看 V1 本身/)).toBeVisible()
  })

  it('还在生成的编辑段放成锁定的占位，盖着「生成中」，合成灰着', async () => {
    serveChain([editSegment({ status: 'submitted' })])
    await renderEditor()

    const track = await timeline()
    expect(await within(track).findByRole('img', { name: /AI 生成中/ })).toBeVisible()
    expect(within(track).getByRole('status')).toHaveTextContent(/生成中 \d+:\d{2}/)
    expect(screen.getByRole('button', { name: '合成成片' })).toBeDisabled()
  })

  it('结果的时长读不出来：占位换回原来的段，并说出原因', async () => {
    restoreMedia = stubMediaDurations({ [EDITED_URL]: null })
    serveChain([editSegment({ outputUrl: EDITED_URL })])
    await renderEditor()

    expect(await screen.findByText('AI 没改成：读不出结果的时长，已换回原来的段')).toBeVisible()
    const track = await timeline()
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(8)
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
  })

  it('存着的草稿读不出来：按服务端重建，并说一声', async () => {
    window.localStorage.setItem(draftStorageKey(CONVERSATION, ROOT_ID), '{"version":1')
    serveChain([])
    await renderEditor()

    expect(await screen.findByText('草稿读不出来，已按服务端的 AI 结果重建')).toBeVisible()
    expect(window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))).toBeNull()
  })

  it('剪了就存进浏览器：删掉一段后重开，草稿还在', async () => {
    serveChain([])
    const user = userEvent.setup()
    const { unmount } = await renderEditor()

    const track = await timeline()
    const second = within(track).getByRole('button', { name: /^第 2 段/ })
    // jsdom 没有指针捕获；按下段时会捕获指针，好分辨是点还是拖。
    Object.assign(second, {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => false,
      releasePointerCapture: () => undefined,
    })
    await user.click(second)
    await user.keyboard('{Delete}')
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    await waitFor(() =>
      expect(window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))).not.toBeNull(),
    )
    unmount()

    await renderEditor()
    const reopened = await timeline()
    expect(within(reopened).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent(
      '共 7.0 秒 · 比 V1 短 1.0 秒',
    )
  })
})

describe('放大预览', () => {
  const renderPlayable = async () => {
    serveChain([])
    await renderEditor()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '播放' })).not.toHaveAttribute('aria-disabled'),
    )
    const stage = screen.getByLabelText('视频预览')
    return { stage, videos: [...stage.querySelectorAll('video')] }
  }
  const expectSameVideos = (stage: HTMLElement, videos: readonly HTMLVideoElement[]) => {
    const now = stage.querySelectorAll('video')
    expect(now).toHaveLength(2)
    videos.forEach((video, slot) => {
      expect(now[slot]).toBe(video)
      expect(video.isConnected).toBe(true)
    })
  }

  it('舞台连同两个 <video> 原样搬进应用内遮罩再搬回，状态不丢，也不调浏览器全屏', async () => {
    const requestFullscreen = vi.fn()
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    try {
      const user = userEvent.setup()
      const { stage, videos } = await renderPlayable()
      const source = videos[0]?.getAttribute('src')
      expect(source).toBe(ROOT_URL)
      await user.click(screen.getByRole('button', { name: '开启声音' }))

      await user.click(screen.getByRole('button', { name: '放大' }))
      const overlay = screen.getByRole('dialog', { name: '放大预览' })
      expect(screen.getByLabelText('视频预览')).toBe(stage)
      expect(overlay).toContainElement(stage)
      expectSameVideos(stage, videos)
      expect(within(overlay).queryByRole('button', { name: '放大' })).toBeNull()
      // 遮罩里操作舞台不会被当成点了外面而关掉。
      await user.click(within(overlay).getByRole('button', { name: '静音' }))
      expect(within(overlay).getByRole('button', { name: '开启声音' })).toBeVisible()
      await user.click(within(overlay).getByRole('button', { name: '开启声音' }))

      await user.click(within(overlay).getByRole('button', { name: '关闭' }))
      expect(screen.queryByRole('dialog', { name: '放大预览' })).toBeNull()
      expect(screen.getByRole('dialog', { name: /编辑视频/ })).toContainElement(stage)
      expectSameVideos(stage, videos)
      expect(videos[0]?.getAttribute('src')).toBe(source)
      expect(screen.getByRole('button', { name: '静音' })).toBeVisible()

      await user.click(screen.getByRole('button', { name: '放大' }))
      await user.click(screen.getByRole('button', { name: '关闭预览' }))
      expect(screen.queryByRole('dialog', { name: '放大预览' })).toBeNull()
      expectSameVideos(stage, videos)
      expect(requestFullscreen).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
    }
  })

  it('遮罩里键盘照常操作播放控件，Escape 只关放大层，焦点回到放大按钮', async () => {
    const user = userEvent.setup()
    await renderPlayable()

    await user.click(screen.getByRole('button', { name: '放大' }))
    const overlay = screen.getByRole('dialog', { name: '放大预览' })
    expect(within(overlay).getByRole('button', { name: '关闭' })).toHaveFocus()
    // 从 × 往后 Tab 会绕回遮罩开头、再进舞台，不跑出放大层。
    const unmute = within(overlay).getByRole('button', { name: '开启声音' })
    for (let step = 0; step < 8 && document.activeElement !== unmute; step += 1) {
      await user.tab()
      expect(overlay).toContainElement(document.activeElement as HTMLElement)
    }
    await user.keyboard('{Enter}')
    expect(within(overlay).getByRole('button', { name: '静音' })).toHaveFocus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: '放大预览' })).toBeNull()
    expect(screen.getByRole('dialog', { name: /编辑视频/ })).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toHaveFocus())
  })
})

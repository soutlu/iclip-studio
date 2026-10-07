import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VideoEditor } from './video-editor'

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

let restoreMedia = () => {}

afterEach(() => {
  restoreMedia()
  restoreMedia = () => {}
  vi.restoreAllMocks()
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

  it('编辑结果读不出时长时说明合成为何按不下去', async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8, [EDITED_URL]: null })
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({
          items: [
            makeGenerationJob({
              outputUrl: EDITED_URL,
              rootJobId: ROOT_ID,
              sourceJobId: ROOT_ID,
              rangeStartMs: 2000,
              rangeEndMs: 4000,
              request: { prompt: '把背景换成海边' },
              createdAt: '2026-09-16T10:02:00Z',
            }),
          ],
        }),
      ),
    )
    await renderEditor()

    expect(
      await screen.findByText('读不到编辑结果的时长，无法合成；关掉编辑器重开可再试一次'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeDisabled()
  })
})

describe('版本条', () => {
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

  it('只有原片一版时没得切，不显示版本条', async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8 })
    serveChain([])
    await renderEditor()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '播放' })).not.toHaveAttribute('aria-disabled'),
    )
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
    expect(screen.queryByRole('group', { name: '预览版本' })).toBeNull()
  })

  it('结果回来的编辑叫「未合成」排在最前、自动选中；可对照原片与合成，点 V1 切回原片', async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8, [EDITED_URL]: 2 })
    serveChain([editSegment({ outputUrl: EDITED_URL })])
    const user = userEvent.setup()
    await renderEditor()

    const strip = await screen.findByRole('group', { name: '视频版本' })
    const entries = within(strip).getAllByRole('button')
    expect(entries.map((entry) => entry.getAttribute('aria-label'))).toEqual(['未合成', 'V1'])
    await waitFor(() => expect(entries[0]).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByRole('group', { name: '预览版本' })).toBeVisible()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()

    await user.click(within(strip).getByRole('button', { name: 'V1' }))
    expect(within(strip).getByRole('button', { name: 'V1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByRole('button', { name: '合成成片' })).toBeNull()
    expect(screen.queryByRole('group', { name: '预览版本' })).toBeNull()
    expect(screen.getByRole('button', { name: '下载' })).toBeEnabled()
  })

  it('还在生成的编辑挂着走表摆进来，但没有可看的预览，点不动', async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8 })
    serveChain([editSegment({ status: 'submitted' })])
    const user = userEvent.setup()
    await renderEditor()

    const strip = await screen.findByRole('group', { name: '视频版本' })
    const running = within(strip).getByRole('button', { name: '未合成 · 生成中' })
    expect(running).toHaveAttribute('aria-disabled', 'true')
    expect(running).toHaveTextContent(/\d+:\d{2}/)
    await user.click(running)
    expect(running).toHaveAttribute('aria-pressed', 'false')
    expect(within(strip).getByRole('button', { name: 'V1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})

describe('放大预览', () => {
  const renderPlayable = async () => {
    restoreMedia = stubMediaDurations({ [ROOT_URL]: 8 })
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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { finishFrameLoads } from '@/testing/timeline-frames'
import { VIDEO_MODELS } from '@/testing/video-models'
import { Frames } from '../editing/timeline'
import type { GenerationJob } from '../storyboard.api'
import { draftStorageKey } from './use-draft'
import { VideoEditor } from './video-editor'

const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())
const referenceSamples = vi.hoisted(() => [] as { url: string; start: number; end: number }[])
type HeldRead = {
  promise: Promise<null>
  resolve: (track: null) => void
  reject: (cause: Error) => void
}
const audioReads = vi.hoisted(() => ({
  opened: [] as string[],
  held: new Map<string, HeldRead>(),
}))

vi.mock('mediabunny', async () => {
  const { createMediaReaderMock } = await import('@/testing/media-reader')
  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }
  class Mp4OutputFormat {}
  class Output {
    readonly target: BufferTarget
    state = 'pending'
    constructor(options: { target: BufferTarget }) {
      this.target = options.target
    }
    addVideoTrack = () => {}
    start = () => Promise.resolve()
    finalize = () => {
      this.target.buffer = new ArrayBuffer(8)
      this.state = 'finalized'
      return Promise.resolve()
    }
    cancel = () => Promise.resolve()
  }
  class Quality {}
  class VideoSampleSource {
    add = () => Promise.resolve()
    close = () => {}
  }
  class VideoSampleSink {
    private readonly url: string
    constructor(track: { url: string }) {
      this.url = track.url
    }
    async *samples(start: number, end: number) {
      referenceSamples.push({ url: this.url, start, end })
      yield {
        timestamp: start,
        duration: end - start,
        setTimestamp: () => {},
        setDuration: () => {},
        close: () => {},
      }
    }
  }
  return {
    ...createMediaReaderMock(files, (url) => {
      audioReads.opened.push(url)
      return audioReads.held.get(url)?.promise ?? Promise.resolve(null)
    }),
    BufferTarget,
    Quality,
    VideoSampleSink,
    VideoSampleSource,
    canEncodeVideo: () => Promise.resolve(true),
    Mp4OutputFormat,
    Output,
  }
})

const CONVERSATION = 'conversation-1'
const ROOT_URL = 'https://example.com/root.mp4'
const EDITED_URL = 'https://example.com/edited.mp4'
const OTHER_URL = 'https://example.com/other.mp4'
const COMPOSITE_URL = 'https://example.com/composite.mp4'
const ROOT_ID = '0f6a2c9e-8d4b-4c1e-9a7f-3b5d6e8f1a2b'
const EDIT_ID = '1a2b3c4d-1111-4111-8111-111111111111'
const SECOND_EDIT_ID = '2b3c4d5e-2222-4222-8222-222222222222'
const COMPOSITE_ID = '3c4d5e6f-3333-4333-8333-333333333333'
const root = makeGenerationJob({ id: ROOT_ID, outputUrl: ROOT_URL, shotIndex: 1 })
const rootWithShotPrompts = makeGenerationJob({
  ...root,
  request: {
    shot: {
      global_settings: '写实',
      timeline: [
        { timestamps: [0, 2], prompt: '推着单车走过', image_indexes: [] },
        { timestamps: [2, 8], prompt: '停在面包店门口', image_indexes: [] },
      ],
    },
  },
})

let stageNetworkState: number = HTMLMediaElement.NETWORK_LOADING

const stopVideoDownload = () => {
  stageNetworkState = HTMLMediaElement.NETWORK_IDLE
  fireEvent.suspend(screen.getByLabelText('视频播放器'))
}

const editorOf = (video = root) => (
  <>
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={() => {}}
      shotIndex={1}
      video={video}
    />
    <Toaster />
  </>
)

const renderEditor = (video = root) =>
  renderWithProviders(editorOf(video), { initialPath: '/c/test' })

const editSegment = (overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({
    rootJobId: ROOT_ID,
    sourceJobId: ROOT_ID,
    rangeStartMs: 2000,
    rangeEndMs: 4000,
    outputUrl: EDITED_URL,
    durationMs: 3000,
    shotIndex: 1,
    request: { prompt: '把背景换成海边' },
    createdAt: '2026-09-16T10:02:00Z',
    ...overrides,
  })

const composite = (overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({
    operation: 'compose',
    rootJobId: ROOT_ID,
    sourceJobId: ROOT_ID,
    outputUrl: COMPOSITE_URL,
    shotIndex: 1,
    createdAt: '2026-09-16T10:05:00Z',
    finishedAt: '2026-09-16T10:06:00Z',
    ...overrides,
  })

const serveJobs = (items: () => readonly GenerationJob[]) =>
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const rootJobId = new URL(request.url).searchParams.get('rootJobId')
      return HttpResponse.json({
        items: items().filter((job) => rootJobId === null || job.rootJobId === rootJobId),
      })
    }),
  )
const serveChain = (items: readonly GenerationJob[]) => serveJobs(() => items)

const videoFile = () => new HttpResponse(new Uint8Array([1, 2, 3]))
const downloaded = (jobId: string) => ({ jobId, name: 'video.downloaded' })
const watchDownloads = (respond: () => Response | Promise<Response> = videoFile) => {
  const calls: unknown[] = []
  server.use(
    http.get('https://example.com/:file', ({ request }) => {
      calls.push(request.url)
      return respond()
    }),
    http.post('*/api/tracking/events', async ({ request }) => {
      calls.push(await request.json())
      return new HttpResponse(null, { status: 204 })
    }),
  )
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = () => 'blob:http://localhost/video'
      static override revokeObjectURL() {}
    },
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return calls
}

const timeline = () => screen.findByRole('region', { name: '视频编辑时间线' })
const originalTrack = async () => within(await timeline()).getByRole('group', { name: '原片' })
const shot = async (no: number) =>
  within(await originalTrack()).getByRole('button', { name: new RegExp(`^镜头 ${no} ·`) })
const editTrack = () => screen.getByRole('group', { name: '编辑片段' })
const block = (name: RegExp | string) => within(editTrack()).getByRole('button', { name })
const partEye = (name: RegExp | string) =>
  within(within(editTrack()).getByRole('group', { name })).getByRole('button', {
    name: /选用这一段$/,
  })
const shotEye = (no: number) =>
  within(screen.getByRole('group', { name: '原片' })).getByRole('button', {
    name: new RegExp(`^(关闭|开启)镜头 ${no}$`),
  })
const storeWholeEdit = () =>
  window.localStorage.setItem(
    draftStorageKey(CONVERSATION, ROOT_ID),
    JSON.stringify({
      entries: [
        ...[1, 2].map((no) => ({ kind: 'shot', no, t0: no - 1, t1: no })),
        ...[1, 2, 3].map((seg) => ({ kind: 'edit', editId: EDIT_ID, seg, t0: seg - 1, t1: seg })),
        ...[5, 6, 7, 8].map((no) => ({ kind: 'shot', no, t0: no - 1, t1: no })),
      ],
      closed: [],
    }),
  )
const draftTrack = () => screen.getByRole('group', { name: '草稿' })
const draftNames = () =>
  within(draftTrack())
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'))

const card = () => screen.queryByRole('region', { name: 'AI 改段' })
const openCard = () => screen.getByRole('region', { name: 'AI 改段' })
const smallCard = (name: RegExp | string) => screen.getByRole('region', { name })
const requestBox = () => within(openCard()).getByLabelText('修改要求')
const generateButton = () => within(openCard()).getByRole('button', { name: '生成视频' })
const viewButton = (name: '版本' | '剪辑') =>
  within(screen.getByRole('group', { name: '查看方式' })).getByRole('button', { name })
const versionRows = () => screen.getByRole('group', { name: '视频版本' })
const versionButton = (label: string) => within(versionRows()).getByRole('button', { name: label })
const findVersion = async (label: string) =>
  within(await screen.findByRole('group', { name: '视频版本' })).findByRole('button', {
    name: label,
  })
const controls = () => screen.getByRole('group', { name: '播放控件' })
const failureNotice = () => within(controls()).queryByRole('button', { name: /失败：/ })
const buttonNames = (container: HTMLElement) =>
  within(container)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? button.textContent)
const composeButton = () => within(controls()).getByRole('button', { name: /合成新版本|正在合成/ })
const playhead = () => screen.getByRole('slider', { name: '时间线播放位置' })
const playButton = () => screen.getByRole('button', { name: '播放' })
const readyToPlay = () => waitFor(() => expect(playButton()).not.toHaveAttribute('aria-disabled'))

beforeEach(() => {
  server.use(
    http.get('*/api/generations/video-models', () =>
      HttpResponse.json({ ...VIDEO_MODELS, default: 'wan3.0-video' }),
    ),
  )
  files.set(ROOT_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
  files.set(COMPOSITE_URL, { keyframes: [0, 2, 5], duration: 9 })
  files.set(EDITED_URL, { keyframes: [0, 1, 2], duration: 3 })
  files.set(OTHER_URL, { keyframes: [0], duration: 1.5 })
  window.localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLMediaElement,
    url: string,
  ) {
    src?.set?.call(this, url)
    if (!this.isConnected) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  })
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1280)
  stubIntersectionObserver()
  stageNetworkState = HTMLMediaElement.NETWORK_LOADING
  vi.spyOn(HTMLMediaElement.prototype, 'networkState', 'get').mockImplementation(
    () => stageNetworkState,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  files.clear()
  referenceSamples.length = 0
  for (const held of audioReads.held.values()) held.resolve(null)
  audioReads.held.clear()
  audioReads.opened.length = 0
})

describe('时间线缩略图限量排队', () => {
  const mediaOf = (name: string) => `https://bucket.oss-cn-hangzhou.aliyuncs.com/${name}.mp4`
  const timesOf = (images: readonly HTMLImageElement[]) =>
    images.map((image) => Number(/t_(\d+),/.exec(image.getAttribute('src') ?? '')?.[1]))
  const framesOf = (mediaUrl: string) => <Frames part={{ mediaUrl, start: 1, end: 4 }} />
  const imagesIn = (container: HTMLElement) => [...container.querySelectorAll('img')]

  it('全部进入可视区时只请求 3 张，一张加载完才出下一张', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('limit')))
    await viewport.scroll(true)
    expect(timesOf(imagesIn(view.container))).toEqual([1250, 1750, 2250])

    const [first] = imagesIn(view.container)
    if (first === undefined) throw new Error('没有图')
    fireEvent.load(first)
    expect(timesOf(imagesIn(view.container))).toEqual([1250, 1750, 2250, 2750])
  })

  it('加载失败的格子留空，也让出名额', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('failed')))
    await viewport.scroll(true)
    const [first] = imagesIn(view.container)
    if (first === undefined) throw new Error('没有图')
    fireEvent.error(first)
    expect(timesOf(imagesIn(view.container))).toEqual([1750, 2250, 2750])
  })

  it('不在可视区的不请求', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('outside')))
    await viewport.scroll(false)
    expect(imagesIn(view.container)).toEqual([])
  })

  it('还在排队就离开可视区的不再请求，已开始的继续', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('left')))
    await viewport.scroll(true)
    await viewport.scroll(false)
    const running = imagesIn(view.container)
    expect(running).toHaveLength(3)
    for (const image of running) fireEvent.load(image)
    expect(imagesIn(view.container)).toHaveLength(3)
  })

  it('卸载时释放名额：加载到一半关掉，后面的还能开始', async () => {
    const viewport = stubIntersectionObserver()
    const view = render(framesOf(mediaOf('closed')))
    await viewport.scroll(true)
    view.unmount()
    const next = render(framesOf(mediaOf('after-closed')))
    await viewport.scroll(true)
    expect(imagesIn(next.container)).toHaveLength(3)
  })

  it('加载过的图再次挂载直接显示，不等可视区也不排队', async () => {
    const viewport = stubIntersectionObserver()
    const media = mediaOf('seen')
    const view = render(framesOf(media))
    await viewport.scroll(true)
    finishFrameLoads(view.container)
    view.unmount()

    await viewport.scroll(false)
    const again = render(framesOf(media))
    expect(imagesIn(again.container)).toHaveLength(6)
  })
})

describe('波形等视频停止下载再读', () => {
  const silentMarks = async () => within(await timeline()).findAllByText('无声')
  const hold = (url: string) => {
    let resolve: HeldRead['resolve'] = () => {}
    let reject: HeldRead['reject'] = () => {}
    const promise = new Promise<null>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    const held = { promise, resolve, reject }
    audioReads.held.set(url, held)
    return held
  }

  it('视频下载中不读波形，停止下载后才读', async () => {
    serveChain([])
    await renderEditor()
    await originalTrack()
    expect(audioReads.opened).toEqual([])
    expect(within(await timeline()).queryByText('无声')).toBeNull()

    stopVideoDownload()
    expect((await silentMarks()).length).toBeGreaterThan(0)
    expect(audioReads.opened).toEqual([ROOT_URL])
  })

  it('读过的波形再次打开时直接显示，不等视频也不重读', async () => {
    serveChain([])
    const view = await renderEditor()
    await originalTrack()
    stopVideoDownload()
    await silentMarks()

    view.rerender(null)
    view.rerender(editorOf())
    expect((await silentMarks()).length).toBeGreaterThan(0)
    expect(audioReads.opened).toEqual([ROOT_URL])
  })

  it.each([
    { outcome: '读完', finish: (held: HeldRead) => held.resolve(null) },
    { outcome: '读失败', finish: (held: HeldRead) => held.reject(new Error('文件损坏')) },
  ])('同一时间只读一个文件，前一个 $outcome 后才读下一个', async ({ finish }) => {
    const held = hold(ROOT_URL)
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()
    await originalTrack()
    await within(editTrack()).findByRole('button', { name: /第 1 段/ })

    stopVideoDownload()
    await waitFor(() => expect(audioReads.opened).toEqual([ROOT_URL]))
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    expect(audioReads.opened).toEqual([ROOT_URL])

    finish(held)
    await waitFor(() => expect(audioReads.opened).toEqual([ROOT_URL, EDITED_URL]))
  })

  const expectKeyframeFailureShown = async () => {
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('视频时长无效，无法分段')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeVisible()
    expect(screen.queryByText('正在读取视频信息…')).toBeNull()
  }

  it('剪辑视图读不到原片关键帧：舞台没有视频可等，直接读波形，仍有失败提示', async () => {
    files.delete(ROOT_URL)
    serveChain([])
    await renderEditor()
    await waitFor(() => expect(audioReads.opened).toEqual([ROOT_URL]))
    await expectKeyframeFailureShown()
  })

  it('版本视图读不到这一版的关键帧：舞台没有视频可等，直接读波形，仍有失败提示', async () => {
    const opened = composite({ id: COMPOSITE_ID })
    files.delete(COMPOSITE_URL)
    serveChain([root, opened])
    await renderEditor(opened)
    await waitFor(() => expect(audioReads.opened).toContain(COMPOSITE_URL))
    await expectKeyframeFailureShown()
  })
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
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({
          ...VIDEO_MODELS,
          ...models,
          clipModels: models.items.flatMap((id) =>
            VIDEO_MODELS.clipModels.filter((model) => model.id === id),
          ),
        }),
      ),
    )
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    await waitFor(() =>
      expect(within(openCard()).getByRole('button', { name: '编辑模型' })).toHaveTextContent(
        expected,
      ),
    )
  })

  it('模型清单读不到时卡里给出重新加载入口，点了再拉一次', async () => {
    let requests = 0
    server.use(
      http.get('*/api/generations/video-models', () => {
        requests += 1
        return HttpResponse.json({ detail: '模型清单读不到' }, { status: 500 })
      }),
    )
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    expect(await within(openCard()).findByText(/模型清单读不到/)).toBeVisible()
    await user.click(within(openCard()).getByRole('button', { name: '重新加载模型' }))

    await waitFor(() => expect(requests).toBe(2))
  })

  it('从原片打开是剪辑：原片轨按关键帧分镜头，没有音轨写「无声」；编辑轨第一行都是占位；没选时没有卡', async () => {
    serveChain([])
    await renderEditor()

    expect(viewButton('剪辑')).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(await originalTrack()).getAllByRole('button', { name: /^镜头 \d ·/ }),
    ).toHaveLength(8)
    expect(draftNames()).toHaveLength(8)
    stopVideoDownload()
    expect((await within(await timeline()).findAllByText('无声')).length).toBeGreaterThan(0)
    expect(within(editTrack()).getAllByRole('button', { name: /^生成镜头 \d$/ })).toHaveLength(8)
    expect(card()).toBeNull()
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
    expect(controls()).toHaveTextContent('共 8.0 秒')
    expect(composeButton()).toHaveTextContent('合成新版本')
    expect(composeButton()).toBeDisabled()
    expect(within(controls()).queryByRole('button', { name: '下载' })).toBeNull()
  })

  it('在合成上做的编辑段不在编辑轨上；区间对不上镜头的也在，名字按碰到的镜头叫', async () => {
    serveChain([
      editSegment({ sourceJobId: COMPOSITE_ID }),
      editSegment({ rangeStartMs: 1500, rangeEndMs: 2500, outputUrl: OTHER_URL }),
    ])
    await renderEditor()
    await originalTrack()
    expect(
      await within(editTrack()).findByRole('button', { name: '镜头 2–3 的编辑片段 · 1.5 秒' }),
    ).toBeVisible()
    expect(within(editTrack()).getAllByRole('button', { name: /的编辑片段/ })).toHaveLength(1)
  })
})

describe('AI 改段的弹出卡', () => {
  let imageSize = { width: 720, height: 1280 }
  beforeEach(() => {
    loginAs(mockAuthUser)
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
    imageSize = { width: 720, height: 1280 }
    vi.stubGlobal(
      'Image',
      class {
        crossOrigin = ''
        naturalWidth = imageSize.width
        naturalHeight = imageSize.height
        onload: (() => void) | null = null
        set src(_url: string) {
          queueMicrotask(() => this.onload?.())
        }
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('点镜头弹卡：卡头写选了哪几个镜头、原片区间与做法；不抢焦点，方向键照常改选中，卡跟着换', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()

    await user.click(await shot(2))
    expect(within(openCard()).getByText('镜头 2 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('原片 1.0 – 2.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(await shot(2)).toHaveFocus()

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(within(openCard()).getByText('镜头 2–3 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('原片 1.0 – 3.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(await shot(3)).toHaveFocus()
  })

  it('点编辑轨第一行的占位与点那个镜头一样', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(block('生成镜头 4'))
    expect(within(openCard()).getByText('镜头 4 · 视频生成')).toBeVisible()
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')
  })

  it('拖长、缩短选区：卡头的镜头、原片起止、首尾帧跟着变，卡不重新弹出、要求还在；提交的区间就是选区', async () => {
    const ossRoot = 'https://bucket.oss-cn-hangzhou.aliyuncs.com/root.mp4'
    files.set(ossRoot, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 200 }),
    )
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor(makeGenerationJob({ ...root, outputUrl: ossRoot }))
    await user.click(await shot(2))
    const opened = openCard()
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')

    act(() => screen.getByRole('slider', { name: '裁剪结尾' }).focus())
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}')
    act(() => screen.getByRole('slider', { name: '裁剪开头' }).focus())
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')

    expect(openCard()).toBe(opened)
    expect(requestBox()).toHaveTextContent('换成黄昏的暖光')
    expect(within(openCard()).getByText('镜头 1–3 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('原片 0.7 – 2.5 秒 · 视频和原声一起重做')).toBeVisible()
    const [first, last] = within(openCard()).getAllByRole('presentation')
    expect(first).toHaveAttribute('src', expect.stringContaining('t_700,'))
    expect(last).toHaveAttribute('src', expect.stringContaining('t_2400,'))
    expect(await shot(1)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'false')

    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]).toMatchObject({ range_start_ms: 700, range_end_ms: 2500 })
    expect(referenceSamples).toEqual([{ url: ossRoot, start: 0.7, end: 2.5 }])
  })

  it('拖选区把手期间卡上的首帧、尾帧停在按下时那一帧，松手后换成新的起止', async () => {
    const ossRoot = 'https://bucket.oss-cn-hangzhou.aliyuncs.com/root.mp4'
    files.set(ossRoot, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 200 }),
    )
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(makeGenerationJob({ ...root, outputUrl: ossRoot }))
    await user.click(await shot(2))
    const frames = () =>
      within(openCard())
        .getAllByRole('presentation')
        .map((img) => img.getAttribute('src'))
    const pressed = frames()
    expect(pressed).toEqual([
      expect.stringContaining('t_1000,'),
      expect.stringContaining('t_1900,'),
    ])

    const end = Object.assign(screen.getByRole('slider', { name: '裁剪结尾' }), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 200 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 230 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 250 })
    expect(within(openCard()).getByText('原片 1.0 – 2.5 秒 · 视频和原声一起重做')).toBeVisible()
    expect(frames()).toEqual(pressed)

    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(frames()).toEqual([
      expect.stringContaining('t_1000,'),
      expect.stringContaining('t_2400,'),
    ])
  })

  it('收起时还在上传的参考图留不下来：展开后卡里说出几张要重新添加，写好的字照旧；再改要求提示收起', async () => {
    server.use(http.post('*/api/uploads/sign', () => delay('infinite')))
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    pasteTextIntoComposer(requestBox(), '色调参考')
    pasteFilesIntoComposer(requestBox(), [
      new File(['png-bytes'], '黄昏.png', { type: 'image/png' }),
    ])
    expect(within(requestBox()).getByText('黄昏.png')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(card()).toBeNull()

    await user.click(screen.getByRole('button', { name: /^展开镜头 2 · 视频生成/ }))
    expect(
      within(openCard()).getByText('有 1 张图片收起时尚未上传完成，未能保留，请重新添加'),
    ).toBeVisible()
    expect(requestBox()).toHaveTextContent('色调参考')
    expect(within(requestBox()).queryByText('黄昏.png')).toBeNull()

    pasteTextIntoComposer(requestBox(), '，暖一点')
    expect(within(openCard()).queryByText(/张图片收起时尚未上传完成/)).toBeNull()
  })

  it('Seedance 编辑不足 4 秒时禁用，相邻镜头合计 4 秒后才可提交', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    pasteTextIntoComposer(requestBox(), '保留动作，调整灯光')

    expect(await within(openCard()).findByText(/编辑至少需要 4 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
    await user.keyboard('{Shift>}')
    await user.click(await shot(3))
    await user.click(await shot(4))
    await user.click(await shot(5))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('原片 1.0 – 5.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(generateButton()).toBeEnabled()
  })

  it('Seedance 编辑超过 30 秒时禁止提交并显示上限', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    files.set(ROOT_URL, { keyframes: [0], duration: 31 })
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(1))
    pasteTextIntoComposer(requestBox(), '调整灯光')
    expect(await within(openCard()).findByText(/编辑最多支持 30 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
  })

  it('图生滑杆逐秒调整并遵循模型边界，切换模式保留时长，提交期间禁止调节', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    let accept = () => {}
    const acceptance = new Promise<void>((resolve) => (accept = resolve))
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        await acceptance
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    expect(within(openCard()).queryByRole('slider', { name: '生成时长（秒）' })).toBeNull()
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    pasteTextIntoComposer(requestBox(), '人物转身')
    pasteFilesIntoComposer(requestBox(), [new File(['png'], '人物.png', { type: 'image/png' })])
    await waitFor(() => expect(generateButton()).toBeEnabled())
    const duration = () => within(openCard()).getByRole('slider', { name: '生成时长（秒）' })
    const currentDuration = () => within(openCard()).getByLabelText('当前生成时长')
    expect(duration()).toHaveAttribute('aria-valuemin', '4')
    expect(duration()).toHaveAttribute('aria-valuemax', '30')
    act(() => duration().focus())
    await user.keyboard('{Home}{ArrowLeft}')
    expect(currentDuration()).toHaveTextContent(/^4\s*秒$/)
    await user.keyboard('{ArrowRight}')
    expect(currentDuration()).toHaveTextContent(/^5\s*秒$/)
    await user.keyboard('{End}{ArrowRight}')
    expect(currentDuration()).toHaveTextContent(/^30\s*秒$/)

    await user.click(within(openCard()).getByRole('radio', { name: '编辑' }))
    expect(within(openCard()).queryByRole('slider', { name: '生成时长（秒）' })).toBeNull()
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    expect(currentDuration()).toHaveTextContent(/^30\s*秒$/)
    await user.click(within(openCard()).getByRole('button', { name: '图生模型' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-0' }))

    expect(currentDuration()).toHaveTextContent(/^30\s*秒$/)
    expect(duration()).toHaveAttribute('aria-valuemin', '4')
    expect(duration()).toHaveAttribute('aria-valuemax', '15')
    expect(within(openCard()).getByText(/图生时长须为 4–15 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
    act(() => duration().focus())
    await user.keyboard('{End}')
    expect(currentDuration()).toHaveTextContent(/^15\s*秒$/)
    expect(generateButton()).toBeEnabled()
    await user.click(generateButton())
    try {
      await waitFor(() => expect(submitted).toHaveLength(1))
      expect(submitted[0]).toMatchObject({
        model: 'vendor-a-seedance-2-0',
        seconds: 15,
        reference_video_urls: [],
      })
      expect(duration().closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'true')
      fireEvent.keyDown(duration(), { key: 'Home' })
      expect(currentDuration()).toHaveTextContent(/^15\s*秒$/)
    } finally {
      await act(async () => accept())
    }
    await waitFor(() =>
      expect(duration().closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'false'),
    )
  })

  it('图生 1 张图作首帧：粘贴自动上传，正文不写引用，删除的图不发送，插入首帧后保持原地址', async () => {
    const sourceUrl = 'https://test.oss-cn-hangzhou.aliyuncs.com/source.mp4'
    files.set(sourceUrl, { keyframes: [0, 1, 2, 3, 4], duration: 5 })
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor(makeGenerationJob({ ...root, outputUrl: sourceUrl }))
    await user.click(await shot(2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    const image = (name: string) => new File(['png'], name, { type: 'image/png' })
    pasteFilesIntoComposer(requestBox(), [image('保留.png')])
    await waitFor(() => expect(within(requestBox()).queryByRole('progressbar')).toBeNull())
    expect(generateButton()).toBeDisabled()
    fireEvent.keyDown(requestBox(), { key: 'Enter' })
    expect(submitted).toHaveLength(0)
    pasteTextIntoComposer(requestBox(), '人物转身 ')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    pasteFilesIntoComposer(requestBox(), [image('删除.png')])
    await waitFor(() => expect(generateButton()).toBeEnabled())
    fireEvent.keyDown(requestBox(), { key: 'Backspace', keyCode: 8 })
    expect(within(requestBox()).queryByText('删除.png')).toBeNull()
    expect(within(requestBox()).getByText('保留.png')).toBeVisible()
    expect(within(requestBox()).queryByText('选区首帧')).toBeNull()
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]?.['reference_image_urls']).toEqual([expect.stringMatching(/\/mock-oss\//)])
    expect(submitted[0]?.['prompt']).toBe('人物转身')
    expect(submitted[0]?.['reference_video_urls']).toEqual([])
    expect(submitted[0]?.['source_job_id']).toBe(ROOT_ID)
    expect(referenceSamples).toEqual([])
    await waitFor(() => expect(generateButton()).toBeEnabled())

    await user.click(await shot(3))
    act(() => requestBox().focus())
    await user.keyboard('{Control>}a{/Control}{Backspace}')
    expect(requestBox().textContent).toBe('')
    await user.keyboard('@选区首帧{Enter}')
    expect(within(requestBox()).getByText('选区首帧')).toBeVisible()
    pasteTextIntoComposer(requestBox(), '人物走开')
    await user.click(await shot(4))
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[1]?.['reference_image_urls']).toEqual([
      `${sourceUrl}?x-oss-process=video/snapshot,t_2000,f_jpg,w_1280,h_0`,
    ])
    expect(submitted[1]?.['prompt']).toBe('人物走开')
    expect(submitted[1]?.['reference_video_urls']).toEqual([])
  })

  it.each([
    {
      name: '画幅与原片不同，按默认框裁好另传',
      image: { width: 1280, height: 720 },
      cropped: true,
    },
    { name: '画幅与原片相同，原样发送', image: { width: 720, height: 1280 }, cropped: false },
  ])('图生 1 张图作首帧：$name', async ({ image, cropped }) => {
    imageSize = image
    const drawn: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: (_image: CanvasImageSource, ...rect: number[]) => drawn.push(rect),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['jpg-bytes'], { type: 'image/jpeg' })),
    )
    const uploads: { contentType: string; url: string }[] = []
    server.events.on('response:mocked', async ({ request, response }) => {
      if (!/\/api\/uploads\/[^/]+\/confirm$/.test(request.url)) return
      uploads.push((await response.clone().json()) as { contentType: string; url: string })
    })
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    pasteTextIntoComposer(requestBox(), '人物转身')
    pasteFilesIntoComposer(requestBox(), [new File(['png'], '首帧.png', { type: 'image/png' })])
    await waitFor(() => expect(generateButton()).toBeEnabled())

    if (cropped) {
      const tip = await screen.findByRole('tooltip')
      expect(within(tip).getByText('首帧 · 已裁成 9:16 · 图片偏小')).toBeVisible()
      expect(within(tip).getByRole('group', { name: '拖动选择保留的部分' })).toBeVisible()
      expect(within(requestBox()).getByRole('img', { name: '已裁切' })).toBeVisible()
    } else {
      expect(within(requestBox()).queryByRole('img', { name: '已裁切' })).toBeNull()
    }
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(1))

    const [original, croppedUpload] = uploads
    if (cropped) {
      expect(drawn).toEqual([[438, 0, 405, 720, 0, 0, 405, 720]])
      expect(croppedUpload?.contentType).toBe('image/jpeg')
      expect(submitted[0]?.['reference_image_urls']).toEqual([croppedUpload?.url])
    } else {
      expect(drawn).toEqual([])
      expect(uploads).toHaveLength(1)
      expect(submitted[0]?.['reference_image_urls']).toEqual([original?.url])
    }
    expect(submitted[0]?.['prompt']).toBe('人物转身')
  })

  it('参考图上限取模型返回的张数：Seedance 2.5 图生可引用 11 张并全部提交', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    pasteFilesIntoComposer(
      requestBox(),
      Array.from(
        { length: 11 },
        (_, index) => new File(['png'], `参考${index + 1}.png`, { type: 'image/png' }),
      ),
    )

    await waitFor(() => expect(generateButton()).toBeEnabled())
    expect(within(requestBox()).getAllByText(/^参考\d+\.png$/)).toHaveLength(11)
    expect(within(openCard()).queryByText(/最多/)).toBeNull()
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]?.['model']).toBe('vendor-a-seedance-2-5')
    expect(submitted[0]?.['reference_image_urls']).toHaveLength(11)
  })

  it('模型清单读不到时不套用参考图上限，也不能生成', async () => {
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({ detail: '模型清单读不到' }, { status: 500 }),
      ),
    )
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    expect(await within(openCard()).findByText(/模型清单读不到/)).toBeVisible()
    pasteFilesIntoComposer(
      requestBox(),
      Array.from(
        { length: 11 },
        (_, index) => new File(['png'], `参考${index + 1}.png`, { type: 'image/png' }),
      ),
    )

    await waitFor(() =>
      expect(within(requestBox()).getAllByText(/^参考\d+\.png$/)).toHaveLength(11),
    )
    expect(within(openCard()).queryByText(/最多/)).toBeNull()
    expect(within(openCard()).getByText('暂无可用的视频模型', { selector: 'p' })).toBeVisible()
    expect(generateButton()).toBeDisabled()
  })

  it('图生 1–2 张图与编辑都必须写文字，3 张及以上的图生只有图片也能提交，按钮与 Enter 遵循同一条件', async () => {
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    const image = (name: string) => new File(['png'], name, { type: 'image/png' })
    pasteFilesIntoComposer(requestBox(), [image('参考1.png')])
    await waitFor(() => expect(within(requestBox()).queryByRole('progressbar')).toBeNull())
    expect(generateButton()).toBeDisabled()
    pasteFilesIntoComposer(requestBox(), [image('参考2.png'), image('参考3.png')])
    await waitFor(() => expect(generateButton()).toBeEnabled())

    await user.click(within(openCard()).getByRole('radio', { name: '编辑' }))
    expect(generateButton()).toBeDisabled()
    pasteTextIntoComposer(requestBox(), '   ')
    fireEvent.keyDown(requestBox(), { key: 'Enter' })
    expect(generateButton()).toBeDisabled()
    expect(submitted).toHaveLength(0)

    pasteTextIntoComposer(requestBox(), '调整灯光')
    expect(generateButton()).toBeEnabled()
    fireEvent.keyDown(requestBox(), { key: 'Enter' })
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]?.['prompt']).toMatch(/^@Image1@Image2@Image3\s+调整灯光$/)
    const uploaded = expect.stringMatching(/\/mock-oss\//) as unknown
    expect(submitted[0]?.['reference_image_urls']).toEqual([uploaded, uploaded, uploaded])
    expect(submitted[0]?.['reference_video_urls']).toEqual([expect.stringMatching(/\/mock-oss\//)])
  })

  it.each(['图生', '编辑'] as const)(
    '%s 提交后保留输入；结果出现在编辑轨上，同样镜头在跑时不能再生成，完成后可再交一次',
    async (mode) => {
      server.use(
        http.get('*/api/generations/video-models', () =>
          HttpResponse.json({
            ...VIDEO_MODELS,
            default: 'wan3.0-video',
            items: ['wan3.0-video'],
            clipModels: VIDEO_MODELS.clipModels.filter((model) => model.id === 'wan3.0-video'),
          }),
        ),
      )
      const chain: GenerationJob[] = []
      const confirmedImages: string[] = []
      server.events.on('response:mocked', async ({ request, response }) => {
        if (!/\/api\/uploads\/[^/]+\/confirm$/.test(request.url)) return
        const body = (await response.clone().json()) as { contentType: string; url: string }
        if (body.contentType.startsWith('image/')) confirmedImages.push(body.url)
      })
      const submitted: Record<string, unknown>[] = []
      serveJobs(() => chain)
      server.use(
        http.post('*/api/generations/video-edits', async ({ request }) => {
          submitted.push((await request.json()) as Record<string, unknown>)
          const created = editSegment({
            status: 'submitted',
            outputUrl: null,
            durationMs: null,
            rangeStartMs: 1000,
            rangeEndMs: 3000,
            createdAt: new Date(Date.UTC(2026, 8, 16, 10, 2, chain.length)).toISOString(),
          })
          chain.push(created)
          return HttpResponse.json({ generation: created }, { status: 202 })
        }),
      )
      const user = userEvent.setup()
      const view = await renderEditor()
      await user.click(await shot(2))
      await user.keyboard('{Shift>}')
      await user.click(await shot(3))
      await user.keyboard('{/Shift}')
      await waitFor(() =>
        expect(within(openCard()).getByRole('button', { name: '编辑模型' })).toHaveTextContent(
          'wan3.0-video',
        ),
      )
      await user.click(within(openCard()).getByRole('radio', { name: mode }))
      const prompt = (text: string) =>
        mode === '图生'
          ? text
          : text.replace('光线参考', '光线参考@Image1').replace('构图参考', '构图参考@Image2')

      const image = (name: string) => new File(['png-bytes'], `${name}.png`, { type: 'image/png' })
      pasteTextIntoComposer(requestBox(), '光线参考')
      pasteFilesIntoComposer(requestBox(), [image('光线')])
      await waitFor(() => expect(generateButton()).toBeEnabled())
      await waitFor(() => expect(confirmedImages).toHaveLength(1))
      pasteTextIntoComposer(requestBox(), '，构图参考')
      pasteFilesIntoComposer(requestBox(), [image('构图')])
      expect(generateButton()).toBeDisabled()
      await waitFor(() => expect(generateButton()).toBeEnabled())
      await user.click(generateButton())

      await waitFor(() => expect(submitted).toHaveLength(1))
      expect(submitted[0]).toMatchObject({
        source_job_id: ROOT_ID,
        range_start_ms: 1000,
        range_end_ms: 3000,
        model: 'wan3.0-video',
        prompt: prompt('光线参考，构图参考'),
      })
      await waitFor(() => expect(confirmedImages).toHaveLength(2))
      expect(submitted[0]?.['reference_image_urls']).toEqual(confirmedImages)

      expect(
        await within(editTrack()).findByRole('button', { name: '镜头 2–3 · 生成中' }),
      ).toBeVisible()
      expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')
      expect(requestBox()).toHaveTextContent('光线参考光线.png，构图参考构图.png')
      expect(within(openCard()).queryByRole('alert')).toBeNull()
      expect(
        within(openCard()).getByText('这几个镜头正在生成，无法再次生成；请等待生成完成'),
      ).toBeVisible()
      expect(generateButton()).toBeDisabled()

      act(() => requestBox().focus())
      pasteTextIntoComposer(requestBox(), '，镜头缓慢推进')
      fireEvent.keyDown(requestBox(), { key: 'Enter' })
      expect(submitted).toHaveLength(1)

      chain.splice(
        0,
        chain.length,
        ...chain.map((job) => ({
          ...job,
          status: 'completed' as const,
          outputUrl: EDITED_URL,
          durationMs: 2000,
        })),
      )
      await act(() => view.queryClient.invalidateQueries())
      await waitFor(() => expect(generateButton()).toBeEnabled())
      await user.click(generateButton())
      await waitFor(() => expect(submitted).toHaveLength(2))
      expect(submitted[1]).toMatchObject({
        prompt: prompt('光线参考，构图参考，镜头缓慢推进'),
        reference_image_urls: confirmedImages,
      })
      expect(
        await within(editTrack()).findByRole('button', { name: '镜头 2–3 · 第 2 次 · 生成中' }),
      ).toBeVisible()
      expect(partEye('镜头 2–3 第 1 次生成的编辑片段 · 第 1 段 · 1.0 秒')).toHaveAccessibleName(
        '选用这一段',
      )

      await user.click(await shot(1))
      expect(requestBox()).toHaveTextContent('光线参考光线.png，构图参考构图.png，镜头缓慢推进')
    },
  )

  it('草稿里选用了编辑段时，参考片段仍只从原片上取选区那一段', async () => {
    storeWholeEdit()
    serveChain([editSegment({ id: EDIT_ID })])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await waitFor(() => expect(shotEye(3)).toHaveAccessibleName('开启镜头 3'))
    await user.click(await shot(2))
    await user.keyboard('{Shift>}')
    await user.click(await shot(3))
    await user.click(await shot(4))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('镜头 2–4 · 视频生成')).toBeVisible()
    pasteTextIntoComposer(requestBox(), '整体调暖')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]).toMatchObject({ range_start_ms: 1000, range_end_ms: 4000 })
    expect(referenceSamples).toEqual([{ url: ROOT_URL, start: 1, end: 4 }])
  })

  it('多次复制镜头提示词依次追加，保留已有文字和参考图，浮窗保持打开', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(rootWithShotPrompts)
    await user.click(await shot(2))
    pasteTextIntoComposer(requestBox(), '换成黄昏')
    pasteFilesIntoComposer(requestBox(), [
      new File(['png-bytes'], '参考光线.png', { type: 'image/png' }),
    ])
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '镜头提示词' }))
    const panel = screen.getByRole('dialog', { name: '镜头提示词' })

    await user.click(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' }))
    await user.click(within(panel).getByRole('button', { name: '复制镜头 2 到输入框' }))
    await user.click(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' }))

    expect(requestBox()).toHaveTextContent(/换成黄昏.*推着单车走过\s*停在面包店门口\s*推着单车走过/)
    expect(requestBox().textContent?.match(/推着单车走过/g)).toHaveLength(2)
    expect(within(requestBox()).getByText('参考光线.png')).toBeVisible()
    expect(panel).toBeVisible()
  })

  it('输入卡收起后复制会展开并追加，Escape 只关闭镜头提示词浮窗', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(rootWithShotPrompts)
    await user.click(await shot(2))
    pasteTextIntoComposer(requestBox(), '换成黄昏')
    await user.keyboard('{Escape}')
    expect(card()).toBeNull()

    await user.click(screen.getByRole('button', { name: '镜头提示词' }))
    await user.click(screen.getByRole('button', { name: '复制镜头 2 到输入框' }))
    expect(requestBox()).toHaveTextContent(/换成黄昏\s*停在面包店门口/)
    expect(screen.getByRole('dialog', { name: '镜头提示词' })).toBeVisible()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: '镜头提示词' })).toBeNull()
    expect(openCard()).toBeVisible()
    expect(requestBox()).toHaveTextContent(/换成黄昏\s*停在面包店门口/)
    expect(screen.getByRole('dialog', { name: /编辑视频/ })).toBeVisible()
  })
})

describe('原片预览', () => {
  const stageVideo = () => screen.getByLabelText('视频播放器')
  const stageLabel = () => screen.queryByText(/^原片 · 镜头/)
  const draftBlock = (name: RegExp) => within(draftTrack()).getByRole('button', { name })

  it('选中已关掉的镜头：舞台放原片、停在选区开头，时间按原片，左上角注明镜头与选区', async () => {
    storeWholeEdit()
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    await user.click(draftBlock(/第 1 段/))
    expect(stageVideo()).toHaveAttribute('src', EDITED_URL)
    expect(stageLabel()).toBeNull()

    await user.click(await shot(4))
    expect(stageVideo()).toHaveAttribute('src', ROOT_URL)
    expect(playhead()).toHaveValue('3')
    expect(controls()).toHaveTextContent('00:03.00 / 00:08.00')
    expect(controls()).toHaveTextContent('共 9.0 秒 · 比原片长 1.0 秒')
    expect(stageLabel()).toBeVisible()
    expect(screen.getByText('3.0 秒 · 选区 3.0–4.0')).toBeVisible()
  })

  it('点卡片 ✕、点标尺、选草稿块都回到草稿预览，标签消失；✕ 时播放头回到原来的合成时间', async () => {
    storeWholeEdit()
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    await user.click(draftBlock(/第 1 段/))
    await user.click(await shot(4))
    expect(stageLabel()).toBeVisible()

    await user.click(within(openCard()).getByRole('button', { name: '收起' }))
    expect(stageLabel()).toBeNull()
    expect(stageVideo()).toHaveAttribute('src', EDITED_URL)
    expect(playhead()).toHaveValue('2')
    expect(controls()).toHaveTextContent('00:02.00 / 00:09.00')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '展开镜头 4 · 视频生成' })).toBeVisible()

    await user.click(await shot(4))
    expect(stageLabel()).toBeVisible()
    fireEvent.change(playhead(), { target: { value: '4.5' } })
    expect(stageLabel()).toBeNull()
    expect(stageVideo()).toHaveAttribute('src', EDITED_URL)
    expect(controls()).toHaveTextContent('00:04.50 / 00:09.00')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')

    await user.click(await shot(4))
    expect(stageLabel()).toBeVisible()
    await user.click(draftBlock(/第 2 段/))
    expect(stageLabel()).toBeNull()
    expect(playhead()).toHaveValue('3')
    expect(controls()).toHaveTextContent('00:03.00 / 00:09.00')

    await user.click(await shot(4))
    expect(stageLabel()).toBeVisible()
    await user.click(block('镜头 3–4 的编辑片段 · 第 3 段 · 1.0 秒'))
    expect(stageLabel()).toBeNull()
    expect(controls()).toHaveTextContent('00:03.00 / 00:08.00')
  })

  it('两种预览切换时正在播放的停下', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    await readyToPlay()
    await user.click(playButton())
    expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
    await user.click(within(draftTrack()).getByRole('button', { name: '镜头 5 · 1.0 秒 · 原片' }))
    expect(stageLabel()).toBeNull()
    expect(playButton()).toBeVisible()

    await user.click(playButton())
    expect(screen.getByRole('button', { name: '暂停' })).toBeVisible()
    await user.click(await shot(3))
    expect(stageLabel()).toBeVisible()
    expect(playButton()).toBeVisible()
  })
})

describe('草稿与编辑轨', () => {
  const PART_1 = '镜头 3–4 的编辑片段 · 第 1 段 · 1.0 秒'
  const shotsOnly = (nos: readonly number[]) => nos.map((no) => `镜头 ${no} · 1.0 秒 · 原片`)
  const parts = (segs: readonly number[]) =>
    segs.map((seg) => `镜头 3–4 的编辑片段 · 第 ${seg} 段 · 1.0 秒 · 已选用`)
  const smallCardOf = (title: string) => screen.queryByRole('region', { name: title })

  it('点编辑轨上完成的一段：选用并选中它在草稿里那块，覆盖的镜头默认关；再点取消', async () => {
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(await within(editTrack()).findByRole('button', { name: PART_1 }))

    expect(draftNames()).toEqual([...shotsOnly([1, 2]), ...parts([1]), ...shotsOnly([5, 6, 7, 8])])
    expect(shotEye(3)).toHaveAccessibleName('开启镜头 3')
    expect(shotEye(4)).toHaveAttribute('aria-pressed', 'false')
    expect(partEye(PART_1)).toHaveAccessibleName('取消选用这一段')
    expect(within(draftTrack()).getByRole('button', { name: /第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      within(smallCard('镜头 3–4 的编辑片段')).getByText('第 1 段 · 1.0 秒 · 已选用'),
    ).toBeVisible()
    expect(playhead()).toHaveValue('2')
    expect(controls()).toHaveTextContent('共 7.0 秒 · 比原片短 1.0 秒')
    expect(screen.getByRole('slider', { name: '裁剪结尾' })).toBeVisible()
    const stored = JSON.parse(
      window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID)) ?? '{}',
    ) as { entries: { kind: string }[] }
    expect(stored.entries.map((entry) => entry.kind)).toEqual([
      'shot',
      'shot',
      'edit',
      'shot',
      'shot',
      'shot',
      'shot',
    ])

    await user.click(block(PART_1))
    expect(draftNames()).toEqual(shotsOnly([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(smallCardOf('镜头 3–4 的编辑片段')).toBeNull()
    expect(shotEye(3)).toHaveAccessibleName('关闭镜头 3')
  })

  const selectPart = async () => {
    await originalTrack()
    await userEvent.click(await within(editTrack()).findByRole('button', { name: PART_1 }))
    return within(smallCard('镜头 3–4 的编辑片段')).getByRole('button', { name: '下载视频' })
  }

  it('小卡下载编辑段：下的是生成的整个文件，保存后按这条编辑段记一次下载', async () => {
    const calls = watchDownloads()
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()

    await userEvent.click(await selectPart())

    await waitFor(() => expect(calls).toEqual([EDITED_URL, downloaded(EDIT_ID)]))
  })

  it('小卡下载失败时提示且不记下载，重试成功才记一次', async () => {
    let attempts = 0
    const calls = watchDownloads(() =>
      (attempts += 1) === 1 ? new HttpResponse(null, { status: 503 }) : videoFile(),
    )
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()

    const download = await selectPart()
    await userEvent.click(download)
    expect(await screen.findByText('视频下载失败，请重试')).toBeVisible()
    await waitFor(() => expect(download).not.toHaveAttribute('aria-disabled'))
    await userEvent.click(download)

    await waitFor(() => expect(calls).toEqual([EDITED_URL, EDITED_URL, downloaded(EDIT_ID)]))
  })

  it('小卡下载不动选中、选用和播放', async () => {
    const calls = watchDownloads()
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()
    const download = await selectPart()
    const namesBefore = draftNames()
    const storedBefore = window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))

    await userEvent.click(download)
    await waitFor(() => expect(calls).toHaveLength(2))

    expect(smallCard('镜头 3–4 的编辑片段')).toBeVisible()
    expect(within(draftTrack()).getByRole('button', { name: /第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(draftNames()).toEqual(namesBefore)
    expect(partEye(PART_1)).toHaveAccessibleName('取消选用这一段')
    expect(window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))).toBe(storedBefore)
    expect(playButton()).toBeVisible()
    expect(playhead()).toHaveValue('2')
  })

  it('镜头和还在生成的编辑片段的小卡没有下载入口', async () => {
    serveChain([
      editSegment({ id: EDIT_ID, status: 'submitted', outputUrl: null, durationMs: null }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()

    await user.click(within(draftTrack()).getByRole('button', { name: '镜头 2 · 1.0 秒 · 原片' }))
    expect(buttonNames(smallCard('镜头 2'))).toEqual(['关闭'])

    await user.click(await within(editTrack()).findByRole('button', { name: '镜头 3–4 · 生成中' }))
    expect(buttonNames(smallCard('镜头 3–4 · 正在生成'))).toEqual(['关闭'])
  })

  it('小眼睛只开关、不改选中；重新打开的镜头排在同一位置已有的编辑段后面', async () => {
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await within(editTrack()).findByRole('button', { name: PART_1 })
    for (const seg of [1, 2, 3]) await user.click(partEye(new RegExp(`第 ${seg} 段`)))
    expect(draftNames()).toEqual([
      ...shotsOnly([1, 2]),
      ...parts([1, 2, 3]),
      ...shotsOnly([5, 6, 7, 8]),
    ])
    expect(controls()).toHaveTextContent('共 9.0 秒 · 比原片长 1.0 秒')
    expect(smallCardOf('镜头 3–4 的编辑片段')).toBeNull()

    await user.click(shotEye(4))
    expect(draftNames()).toEqual([
      ...shotsOnly([1, 2]),
      ...parts([1, 2, 3]),
      ...shotsOnly([4, 5, 6, 7, 8]),
    ])
    expect(card()).toBeNull()
  })

  it('选中草稿里一块出把手与小卡；键盘修剪后后面的块跟着移、播放头跟到结尾；Delete 拿掉它，再打开是整个镜头', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(within(draftTrack()).getByRole('button', { name: '镜头 2 · 1.0 秒 · 原片' }))
    expect(within(smallCard('镜头 2')).getByText('1.0 秒 · 原片')).toBeVisible()
    expect(playhead()).toHaveValue('1')

    act(() => screen.getByRole('slider', { name: '裁剪结尾' }).focus())
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(within(smallCard('镜头 2')).getByText('0.5 秒（这个镜头 1.0 秒）· 原片')).toBeVisible()
    expect(screen.getByRole('slider', { name: '裁剪结尾' })).toHaveFocus()
    expect(controls()).toHaveTextContent('共 7.5 秒 · 比原片短 0.5 秒')
    await waitFor(() => expect(playhead()).toHaveValue('1.5'))

    await user.keyboard('{Delete}')
    expect(shotEye(2)).toHaveAccessibleName('开启镜头 2')
    expect(smallCardOf('镜头 2')).toBeNull()
    expect(controls()).toHaveTextContent('共 7.0 秒')

    await user.click(shotEye(2))
    expect(draftNames()).toEqual(shotsOnly([1, 2, 3, 4, 5, 6, 7, 8]))
  })

  it('拖草稿块的左、右把手：拖动中草稿不存，松手或丢失捕获都只保存一次并更新总长', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 200 }),
    )
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(within(draftTrack()).getByRole('button', { name: '镜头 2 · 1.0 秒 · 原片' }))
    const key = draftStorageKey(CONVERSATION, ROOT_ID)
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const draftWrites = () => writes.mock.calls.filter(([written]) => written === key)

    const start = Object.assign(screen.getByRole('slider', { name: '裁剪开头' }), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 100 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 140 })
    await waitFor(() => expect(controls()).toHaveTextContent('00:01.40 / 00:08.00'))
    expect(playhead()).toHaveValue('1.4')
    expect(controls()).toHaveTextContent('共 8.0 秒')
    expect(draftWrites()).toEqual([])

    fireEvent.pointerUp(start, { pointerId: 1 })
    await waitFor(() => expect(controls()).toHaveTextContent('00:01.00 / 00:07.60'))
    expect(playhead()).toHaveValue('1')
    expect(controls()).toHaveTextContent('共 7.6 秒 · 比原片短 0.4 秒')
    expect(draftWrites()).toHaveLength(1)
    expect(within(smallCard('镜头 2')).getByText('0.6 秒（这个镜头 1.0 秒）· 原片')).toBeVisible()

    const end = Object.assign(screen.getByRole('slider', { name: '裁剪结尾' }), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 160 })
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 150 })
    await waitFor(() => expect(controls()).toHaveTextContent('00:01.50 / 00:07.60'))
    expect(playhead()).toHaveValue('1.5')
    expect(controls()).toHaveTextContent('共 7.6 秒')
    expect(draftWrites()).toHaveLength(1)

    fireEvent.lostPointerCapture(end, { pointerId: 2 })
    await waitFor(() => expect(controls()).toHaveTextContent('共 7.5 秒'))
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(draftWrites()).toHaveLength(2)
  })

  it('往右拉长草稿块：舞台按拖动中的草稿停在这块的结尾，不是后面那一块', async () => {
    storeWholeEdit()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 850, height: 200 }),
    )
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    await user.click(within(draftTrack()).getByRole('button', { name: /第 3 段/ }))
    act(() => screen.getByRole('slider', { name: '裁剪结尾' }).focus())
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await waitFor(() => expect(controls()).toHaveTextContent('共 8.5 秒'))

    const end = Object.assign(screen.getByRole('slider', { name: '裁剪结尾' }), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 450 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 490 })
    await waitFor(() => expect(controls()).toHaveTextContent('00:04.90 / 00:08.50'))
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', EDITED_URL)
    expect(playhead()).toHaveValue('4.9')
    expect(controls()).toHaveTextContent('共 8.5 秒')

    fireEvent.pointerUp(end, { pointerId: 1 })
    await waitFor(() => expect(controls()).toHaveTextContent('共 8.9 秒'))
    expect(controls()).toHaveTextContent('00:04.90 / 00:08.90')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', EDITED_URL)
  })

  it('关键帧读不出的编辑段写「无法读取」，不能选用', async () => {
    files.delete(EDITED_URL)
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()
    await originalTrack()
    expect(await within(editTrack()).findByText('镜头 3–4 · 无法读取')).toBeVisible()
    expect(controls()).toHaveTextContent('共 8.0 秒')
  })

  it('选着一条在跑的编辑片段，小卡写进度；它完成后不再选着，也不自动选用', async () => {
    let chain = [
      editSegment({ id: EDIT_ID, status: 'submitted', outputUrl: null, durationMs: null }),
    ]
    serveJobs(() => chain)
    const user = userEvent.setup()
    const view = await renderEditor()
    await originalTrack()
    await user.click(await within(editTrack()).findByRole('button', { name: '镜头 3–4 · 生成中' }))
    expect(within(smallCard('镜头 3–4 · 正在生成')).getByText('完成后显示在编辑轨')).toBeVisible()

    chain = [editSegment({ id: EDIT_ID })]
    await act(() => view.queryClient.invalidateQueries())
    await waitFor(() => expect(smallCardOf('镜头 3–4 · 正在生成')).toBeNull())
    expect(await within(editTrack()).findByRole('button', { name: PART_1 })).toBeVisible()
    expect(partEye(PART_1)).toHaveAccessibleName('选用这一段')
  })

  it('存着的草稿对得上就照它恢复', async () => {
    storeWholeEdit()
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    expect(draftNames()).toEqual([
      ...shotsOnly([1, 2]),
      ...parts([1, 2, 3]),
      ...shotsOnly([5, 6, 7, 8]),
    ])
  })

  it('编辑记录还没读回来时草稿不能改：时间线不出现、不能合成，存着的草稿不被覆盖；读回来后照它恢复', async () => {
    storeWholeEdit()
    const key = draftStorageKey(CONVERSATION, ROOT_ID)
    const stored = window.localStorage.getItem(key)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/generations', async ({ request }) => {
        if (new URL(request.url).searchParams.get('rootJobId') !== null) await held
        return HttpResponse.json({ items: [editSegment({ id: EDIT_ID })] })
      }),
    )
    await renderEditor()
    expect(await screen.findByText('正在读取分段…')).toBeVisible()
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(screen.queryByRole('region', { name: '视频编辑时间线' })).toBeNull()
    expect(composeButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' })
    expect(window.localStorage.getItem(key)).toBe(stored)

    act(() => release())
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    expect(draftNames()).toEqual([
      ...shotsOnly([1, 2]),
      ...parts([1, 2, 3]),
      ...shotsOnly([5, 6, 7, 8]),
    ])
    expect(window.localStorage.getItem(key)).toBe(stored)
  })

  it('存着的草稿对不上时从最近一次合成还原；和它一样就不能再合成', async () => {
    window.localStorage.setItem(
      draftStorageKey(CONVERSATION, ROOT_ID),
      JSON.stringify({
        entries: [{ kind: 'edit', editId: 'gone', seg: 1, t0: 0, t1: 1 }],
        closed: [],
      }),
    )
    serveChain([
      editSegment({ id: EDIT_ID }),
      composite({
        id: COMPOSITE_ID,
        request: {
          segments: [
            { sourceJobId: ROOT_ID, start: 0, end: 2, url: ROOT_URL },
            { sourceJobId: EDIT_ID, start: 0, end: null, url: EDITED_URL },
            { sourceJobId: ROOT_ID, start: 4, end: 8, url: ROOT_URL },
          ],
        },
      }),
    ])
    await renderEditor()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    expect(draftNames()).toEqual([
      ...shotsOnly([1, 2]),
      ...parts([1, 2, 3]),
      ...shotsOnly([5, 6, 7, 8]),
    ])
    expect(composeButton()).toBeDisabled()
  })

  it('存不进浏览器时提示一次，改动照常生效', async () => {
    serveChain([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(shotEye(2))
    await user.click(shotEye(3))
    expect(shotEye(3)).toHaveAccessibleName('开启镜头 3')
    expect(
      await screen.findAllByText('当前浏览器无法保存草稿，关闭编辑器后草稿将丢失'),
    ).toHaveLength(1)
  })
})

describe('失败提醒', () => {
  const failedEdit = (overrides: Partial<GenerationJob>) =>
    editSegment({ status: 'failed', outputUrl: null, durationMs: null, ...overrides })

  it('失败的编辑段不占编辑轨；工具条上写最近的一条，编辑段与合成按失败先后混排，后面写另有几条', async () => {
    serveChain([
      failedEdit({ id: EDIT_ID, errorMessage: '上游失败', finishedAt: '2026-09-16T10:03:00Z' }),
      failedEdit({
        id: SECOND_EDIT_ID,
        rangeStartMs: 5000,
        rangeEndMs: 6000,
        errorMessage: '模型超时',
        createdAt: '2026-09-16T10:04:00Z',
        finishedAt: '2026-09-16T10:07:00Z',
      }),
      composite({
        id: COMPOSITE_ID,
        status: 'failed',
        outputUrl: null,
        errorMessage: '拼接失败',
        finishedAt: '2026-09-16T10:06:00Z',
      }),
    ])
    await renderEditor()
    await originalTrack()

    await waitFor(() => expect(failureNotice()).toHaveTextContent('镜头 6 生成失败：模型超时'))
    expect(controls()).toHaveTextContent('另有 2 条')
    expect(within(editTrack()).queryByRole('button', { name: /^镜头/ })).toBeNull()
    expect(within(editTrack()).getByRole('button', { name: '生成镜头 3' })).toBeVisible()
    expect(controls()).toHaveTextContent('共 8.0 秒')
  })

  it('点 ✕ 关掉最近的一条，下一条顶上；关掉的记在浏览器里，重新打开编辑器也不再出现', async () => {
    serveChain([
      failedEdit({ id: EDIT_ID, errorMessage: '上游失败', finishedAt: '2026-09-16T10:03:00Z' }),
      composite({
        id: COMPOSITE_ID,
        status: 'failed',
        outputUrl: null,
        errorMessage: '拼接失败',
        finishedAt: '2026-09-16T10:06:00Z',
      }),
    ])
    const user = userEvent.setup()
    const first = await renderEditor()
    await waitFor(() => expect(failureNotice()).toHaveTextContent('合成失败：拼接失败'))
    await user.click(within(controls()).getByRole('button', { name: '关闭提醒' }))

    expect(failureNotice()).toHaveTextContent('镜头 3–4 生成失败：上游失败')
    expect(controls()).not.toHaveTextContent('另有')
    first.unmount()

    await renderEditor()
    await waitFor(() => expect(failureNotice()).toHaveTextContent('镜头 3–4 生成失败：上游失败'))
    await user.click(within(controls()).getByRole('button', { name: '关闭提醒' }))
    expect(failureNotice()).toBeNull()
  })

  it('点编辑段的失败：回到剪辑，选中那几个镜头，生成卡写上次失败的原因；重新提交后提醒与红字都不再出现', async () => {
    loginAs(mockAuthUser)
    const chain: GenerationJob[] = [failedEdit({ id: EDIT_ID, errorMessage: '上游失败' })]
    serveJobs(() => chain)
    server.use(
      http.post('*/api/generations/video-edits', () => {
        const created = editSegment({
          id: SECOND_EDIT_ID,
          status: 'submitted',
          outputUrl: null,
          createdAt: '2026-09-16T10:09:00Z',
        })
        chain.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(viewButton('版本'))
    const notice = await waitFor(() => {
      const found = failureNotice()
      if (found === null) throw new Error('还没有失败提醒')
      return found
    })
    await user.click(notice)

    expect(viewButton('剪辑')).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(5)).toHaveAttribute('aria-pressed', 'false')
    expect(within(openCard()).getByText('镜头 3–4 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('上次生成失败：上游失败')).toBeVisible()

    pasteTextIntoComposer(requestBox(), '换成黄昏')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())

    expect(
      await within(editTrack()).findByRole('button', { name: '镜头 3–4 · 生成中' }),
    ).toBeVisible()
    expect(failureNotice()).toBeNull()
    expect(within(openCard()).queryByText(/上次生成失败/)).toBeNull()
  })

  it('失败按实际区间算：碰到同样镜头、区间不同的生成不顶掉它；点提醒选区恢复成那次生成的起止', async () => {
    serveChain([
      failedEdit({ id: EDIT_ID, rangeStartMs: 2500, rangeEndMs: 4000, errorMessage: '上游失败' }),
      editSegment({
        id: SECOND_EDIT_ID,
        status: 'submitted',
        outputUrl: null,
        createdAt: '2026-09-16T10:09:00Z',
      }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await waitFor(() => expect(failureNotice()).toHaveTextContent('镜头 3–4 生成失败：上游失败'))

    await user.click(await shot(3))
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(within(openCard()).getByText('镜头 3–4 · 视频生成')).toBeVisible()
    expect(within(openCard()).queryByText(/上次生成失败/)).toBeNull()

    const notice = failureNotice()
    if (notice === null) throw new Error('没有失败提醒')
    await user.click(notice)
    expect(screen.getByText('2.5 秒 · 选区 2.5–4.0')).toBeVisible()
    expect(screen.getByRole('slider', { name: '裁剪开头' })).toHaveAttribute('aria-valuenow', '2.5')
    expect(within(openCard()).getByText('上次生成失败：上游失败')).toBeVisible()
  })

  it('点合成的失败回到剪辑视图，不选中东西；之后又提交过合成就不再提醒', async () => {
    const chain: GenerationJob[] = [
      editSegment({ id: EDIT_ID }),
      composite({
        id: COMPOSITE_ID,
        status: 'failed',
        outputUrl: null,
        errorMessage: '拼接失败',
        request: { segments: [] },
      }),
    ]
    serveJobs(() => chain)
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = composite({
          id: '4d5e6f70-4444-4444-8444-444444444444',
          status: 'submitted',
          outputUrl: null,
          createdAt: '2026-09-16T10:09:00Z',
          finishedAt: null,
        })
        chain.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(await within(editTrack()).findByRole('button', { name: /第 1 段/ }))
    await user.click(viewButton('版本'))
    await waitFor(() => expect(failureNotice()).toHaveTextContent('合成失败：拼接失败'))
    const notice = failureNotice()
    if (notice === null) throw new Error('没有失败提醒')
    await user.click(notice)

    expect(viewButton('剪辑')).toHaveAttribute('aria-pressed', 'true')
    expect(card()).toBeNull()
    expect(screen.queryByRole('region', { name: /的编辑片段$/ })).toBeNull()
    await user.click(composeButton())
    await waitFor(() => expect(failureNotice()).toBeNull())
  })
})

describe('合成与版本视图', () => {
  it('合成提交失败时提示原因，内容不变可重试', async () => {
    serveChain([editSegment({ id: EDIT_ID })])
    server.use(
      http.post('*/api/generations/video-composites', () =>
        HttpResponse.json({ detail: '合成服务不可用' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(await within(editTrack()).findByRole('button', { name: /第 1 段/ }))
    await user.click(composeButton())
    expect(await screen.findByText(/合成服务不可用/)).toBeVisible()
    expect(composeButton()).toBeEnabled()
  })

  it('从一次合成打开：版本按新旧排列；上下键跳过合成中，Enter 与空格选版后从头停着', async () => {
    const opened = composite({ id: COMPOSITE_ID })
    serveChain([
      root,
      opened,
      composite({
        id: '4d5e6f70-4444-4444-8444-444444444444',
        createdAt: '2026-09-16T10:07:00Z',
        finishedAt: null,
        outputUrl: null,
        status: 'submitted',
      }),
    ])
    const user = userEvent.setup()
    await renderEditor(opened)

    await waitFor(() => expect(viewButton('版本')).toHaveAttribute('aria-pressed', 'true'))
    expect(await findVersion('V2')).toHaveAttribute('aria-pressed', 'true')
    expect(buttonNames(versionRows())).toEqual(['合成中', 'V2', 'V1 原片'])
    expect(versionButton('合成中')).toBeDisabled()
    expect(within(controls()).getByRole('button', { name: '下载' })).toBeEnabled()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    expect(playhead()).toHaveAttribute('max', '9')
    fireEvent.change(playhead(), { target: { value: '4' } })
    expect(controls()).toHaveTextContent('00:04.00')

    versionButton('V2').focus()
    await user.keyboard('{ArrowUp}')
    expect(versionButton('V2')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(versionButton('V1 原片')).toHaveFocus()
    await user.keyboard(' ')
    expect(versionButton('V1 原片')).toHaveAttribute('aria-pressed', 'true')
    expect(versionButton('V2')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(controls()).toHaveTextContent('共 8.0 秒'))
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
    expect(playhead()).toHaveValue('0')
    expect(playButton()).toBeVisible()

    await user.keyboard('{ArrowUp}{Enter}')
    expect(versionButton('V2')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', COMPOSITE_URL)
    expect(playhead()).toHaveValue('0')
    expect(playButton()).toBeVisible()
  })

  it('版本视图「下载」不弹菜单，保存期间不能再点；下的和记的都是正在看的版本', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = watchDownloads(async () => {
      await held
      return videoFile()
    })
    const opened = composite({ id: COMPOSITE_ID })
    serveChain([root, opened])
    const user = userEvent.setup()
    await renderEditor(opened)
    await findVersion('V2')
    const download = () => within(controls()).getByRole('button', { name: '下载' })

    await user.click(download())
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(calls).toEqual([COMPOSITE_URL]))
    expect(download()).toBeDisabled()
    release()
    await waitFor(() => expect(calls).toEqual([COMPOSITE_URL, downloaded(COMPOSITE_ID)]))
    await waitFor(() => expect(download()).toBeEnabled())

    await user.click(versionButton('V1 原片'))
    await user.click(download())
    await waitFor(() =>
      expect(calls).toEqual([
        COMPOSITE_URL,
        downloaded(COMPOSITE_ID),
        ROOT_URL,
        downloaded(ROOT_ID),
      ]),
    )
  })

  it('提交失败保留输入和错误，允许重新提交', async () => {
    loginAs(mockAuthUser)
    serveChain([])
    server.use(
      http.post('*/api/generations/video-edits', () =>
        HttpResponse.json({ detail: '编辑任务提交失败' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    pasteTextIntoComposer(requestBox(), '保留这条修改要求')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())

    expect(await within(openCard()).findByText(/编辑任务提交失败/)).toBeVisible()
    expect(requestBox()).toHaveTextContent('保留这条修改要求')
    expect(generateButton()).toBeEnabled()
    expect(within(editTrack()).queryByRole('button', { name: /^镜头/ })).toBeNull()
  })
})

describe('放大预览', () => {
  const renderPlayable = async () => {
    serveChain([])
    await renderEditor()
    await readyToPlay()
    return screen.getByLabelText<HTMLVideoElement>('视频播放器')
  }

  it('放大与还原保留播放进度和声音状态，不调用浏览器全屏', async () => {
    const requestFullscreen = vi.fn()
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    try {
      const user = userEvent.setup()
      const video = await renderPlayable()
      expect(video).toHaveAttribute('src', ROOT_URL)
      video.currentTime = 1.25
      await user.click(screen.getByRole('button', { name: '开启声音' }))

      await user.click(screen.getByRole('button', { name: '放大' }))
      const overlay = screen.getByRole('dialog', { name: '放大预览' })
      expect(within(overlay).getByLabelText<HTMLVideoElement>('视频播放器').currentTime).toBe(1.25)
      expect(within(overlay).queryByRole('button', { name: '放大' })).toBeNull()
      await user.click(within(overlay).getByRole('button', { name: '静音' }))
      expect(within(overlay).getByRole('button', { name: '开启声音' })).toBeVisible()
      await user.click(within(overlay).getByRole('button', { name: '开启声音' }))

      await user.click(within(overlay).getByRole('button', { name: '关闭' }))
      expect(screen.queryByRole('dialog', { name: '放大预览' })).toBeNull()
      const restored = within(
        screen.getByRole('dialog', { name: /编辑视频/ }),
      ).getByLabelText<HTMLVideoElement>('视频播放器')
      expect(restored).toHaveAttribute('src', ROOT_URL)
      expect(restored.currentTime).toBe(1.25)
      expect(screen.getByRole('button', { name: '静音' })).toBeVisible()

      await user.click(screen.getByRole('button', { name: '放大' }))
      await user.click(screen.getByRole('button', { name: '关闭预览' }))
      expect(screen.queryByRole('dialog', { name: '放大预览' })).toBeNull()
      expect(screen.getByLabelText<HTMLVideoElement>('视频播放器').currentTime).toBe(1.25)
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

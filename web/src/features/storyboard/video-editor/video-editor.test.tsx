import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VIDEO_MODELS } from '@/testing/video-models'
import type { GenerationJob } from '../storyboard.api'
import { picksStorageKey } from './use-picks'
import { VideoEditor } from './video-editor'

// jsdom 读不了真文件：mediabunny 换成按地址给关键帧表与时长的替身。
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())
const referenceSamples = vi.hoisted(() => [] as { url: string; start: number; end: number }[])

vi.mock('mediabunny', () => {
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
    getPrimaryVideoTrack = () =>
      Promise.resolve({
        url: this.url,
        canDecode: () => Promise.resolve(true),
        computeDuration: () => Promise.resolve(files.get(this.url)?.duration ?? 0),
        getDisplayWidth: () => Promise.resolve(720),
        getDisplayHeight: () => Promise.resolve(1280),
      })
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
  return {
    BufferTarget,
    Quality,
    VideoSampleSink,
    VideoSampleSource,
    canEncodeVideo: () => Promise.resolve(true),
    EncodedPacketSink,
    Input,
    Mp4OutputFormat,
    Output,
    UrlSource,
    MP4: {},
    QTFF: {},
  }
})

const CONVERSATION = 'conversation-1'
const ROOT_URL = 'https://example.com/root.mp4'
const EDITED_URL = 'https://example.com/edited.mp4'
const OTHER_URL = 'https://example.com/other.mp4'
const COMPOSITE_URL = 'https://example.com/composite.mp4'
const EDIT_RESULT_URLS: ReadonlySet<string> = new Set([EDITED_URL, OTHER_URL])
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

const renderEditor = (video = root, onClose = () => {}) =>
  renderWithProviders(
    <>
      <VideoEditor
        conversationId={CONVERSATION}
        loading={false}
        onClose={onClose}
        shotIndex={1}
        video={video}
      />
      <Toaster />
    </>,
    { initialPath: '/c/test' },
  )

/** 编辑段：默认换镜头 3–4（原片 2–4 秒），已完成、出 3 秒。 */
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

/** 列表接口：带 rootJobId 时只给这条原作的编辑链，否则是整段对话的视频记录。 */
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

const timeline = () => screen.findByRole('region', { name: '视频编辑时间线' })
const originalTrack = async () => within(await timeline()).getByRole('group', { name: '原片' })
const shot = async (no: number) =>
  within(await originalTrack()).getByRole('button', { name: new RegExp(`^镜头 ${no} ·`) })
const editTrack = () => screen.getByRole('group', { name: '编辑片段' })
const block = (name: RegExp | string) => within(editTrack()).getByRole('button', { name })

const card = () => screen.queryByRole('region', { name: 'AI 改段' })
const openCard = () => screen.getByRole('region', { name: 'AI 改段' })
const blockCard = () => screen.getByRole('region', { name: '编辑片段' })
const requestBox = () => within(openCard()).getByLabelText('修改要求')
const generateButton = () => within(openCard()).getByRole('button', { name: '生成视频' })
const viewButton = (name: '版本' | '剪辑') =>
  within(screen.getByRole('group', { name: '查看方式' })).getByRole('button', { name })
const versionRows = () => screen.getByRole('group', { name: '视频版本' })
const versionButton = (label: string) => within(versionRows()).getByRole('button', { name: label })
/** 等版本行读好关键帧画出来，再找其中一行。 */
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

let restoreMedia = () => {}

beforeEach(() => {
  server.use(
    http.get('*/api/generations/video-models', () =>
      HttpResponse.json({ ...VIDEO_MODELS, default: 'wan3.0-video' }),
    ),
  )
  files.set(ROOT_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
  files.set(COMPOSITE_URL, { keyframes: [0, 2, 5], duration: 9 })
  window.localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  // jsdom 不读视频元数据：编辑器另起一个不挂进页面的 <video> 读原片尺寸，给它补 720×1280 并发 loadedmetadata；
  // 页面上播放用的 <video> 不受影响，探编辑结果时长的仍由各用例用 stubMediaDurations 给。
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLMediaElement,
    url: string,
  ) {
    src?.set?.call(this, url)
    if (!this.isConnected && !EDIT_RESULT_URLS.has(url))
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  })
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(720)
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1280)
})

afterEach(() => {
  restoreMedia()
  restoreMedia = () => {}
  vi.restoreAllMocks()
  files.clear()
  referenceSamples.length = 0
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
    expect(within(await originalTrack()).getAllByRole('button')).toHaveLength(8)
    expect(within(await timeline()).getAllByText('无声').length).toBeGreaterThan(0)
    expect(within(editTrack()).getAllByRole('button', { name: /^生成镜头 \d$/ })).toHaveLength(8)
    expect(card()).toBeNull()
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
    expect(controls()).toHaveTextContent('共 8.0 秒')
    expect(composeButton()).toHaveTextContent('合成新版本')
    expect(composeButton()).toBeDisabled()
    expect(within(controls()).queryByRole('button', { name: '下载' })).toBeNull()
  })

  it('标题栏只有标题与关闭；工具条左边是查看方式、播放与时间，右边是总长、镜头提示词、静音、放大，最右是合成或下载', async () => {
    const opened = composite({ id: COMPOSITE_ID })
    serveChain([root, opened])
    const user = userEvent.setup()
    await renderEditor(opened)

    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    const header = screen.getByRole('heading', { name: /编辑视频/ }).closest('header')
    if (header === null) throw new Error('没有标题栏')
    expect(buttonNames(header)).toEqual(['关闭视频编辑'])
    expect(header).toHaveTextContent('镜头组 1')
    expect(buttonNames(controls())).toEqual([
      '版本',
      '剪辑',
      '播放',
      '镜头提示词',
      '开启声音',
      '放大',
      '下载',
    ])
    await user.click(viewButton('剪辑'))
    expect(buttonNames(controls()).at(-1)).toBe('合成新版本')
  })

  it('在合成上做的、没对齐镜头的编辑段不在编辑轨上', async () => {
    serveChain([
      editSegment({ sourceJobId: COMPOSITE_ID }),
      editSegment({ rangeStartMs: 1500, rangeEndMs: 2500 }),
    ])
    await renderEditor()
    await originalTrack()
    expect(within(editTrack()).queryByRole('button', { name: /^镜头/ })).toBeNull()
  })
})

describe('AI 改段的弹出卡', () => {
  // 图生读原图尺寸用的 Image 桩：读到的都是 imageSize。
  let imageSize = { width: 720, height: 1280 }
  // jsdom 不解码图片，上传前的尺寸校验读这个桩。
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

  it('Escape 把卡收成胶囊，未提交的字还在；点胶囊展开、光标进输入框；换了选区要求不清空', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    // jsdom 里 ProseMirror 量不了点击位置，直接给焦点。
    act(() => requestBox().focus())
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
    await user.keyboard('{Escape}')

    expect(card()).toBeNull()
    expect(screen.getByRole('dialog', { name: /编辑视频/ })).toBeVisible()
    const mini = screen.getByRole('button', { name: '展开镜头 2 · 视频生成，未提交' })
    expect(mini).toHaveFocus()

    await user.click(mini)
    expect(requestBox()).toHaveTextContent('换成黄昏的暖光')
    expect(requestBox()).toHaveFocus()

    await user.click(await shot(5))
    expect(within(openCard()).getByText('镜头 5 · 视频生成')).toBeVisible()
    expect(requestBox()).toHaveTextContent('换成黄昏的暖光')
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

  it('拖播放头、按播放都把卡收起；点选区里的镜头只展开、不改选中', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))
    expect(openCard()).toBeVisible()

    fireEvent.change(playhead(), { target: { value: '4.5' } })
    expect(card()).toBeNull()
    expect(screen.getByRole('button', { name: '展开镜头 2 · 视频生成' })).toBeVisible()

    await user.click(await shot(2))
    expect(openCard()).toBeVisible()
    expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')

    await readyToPlay()
    await user.click(playButton())
    expect(card()).toBeNull()
    expect(screen.getByRole('button', { name: '展开镜头 2 · 视频生成' })).toBeVisible()
  })

  it('镜头短于模型下限时卡头写原因，写了要求也生成不了', async () => {
    files.set(ROOT_URL, { keyframes: [0, 0.5, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(1))

    expect(
      within(openCard()).getByText(
        '该模型编辑至少需要 1 秒，无法生成视频；请按住 Shift 选择相邻片段',
      ),
    ).toBeVisible()
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
    expect(generateButton()).toBeDisabled()
  })

  it('能交给 AI 时，写了要求才能生成', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    expect(generateButton()).toBeDisabled()
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
    await waitFor(() => expect(generateButton()).toBeEnabled())
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
      // 要裁的图放进来后自己打开预览卡，卡里是裁切框。
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
      // 图生 2 张图依次作首帧、尾帧，正文不写引用；编辑时都是参考图。
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
      expect(block('镜头 2–3 · 第 1 次 · 2.0 秒 · 未选用')).toBeVisible()

      await user.click(await shot(1))
      expect(requestBox()).toHaveTextContent('光线参考光线.png，构图参考构图.png，镜头缓慢推进')
    },
  )

  it('选中里有已选用的编辑片段时，编辑参考用它的结果，替换区间仍按原片时间', async () => {
    files.set(EDITED_URL, { keyframes: [0, 1, 2], duration: 3 })
    window.localStorage.setItem(picksStorageKey(CONVERSATION, ROOT_ID), JSON.stringify([EDIT_ID]))
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
    await waitFor(async () => expect(await shot(3)).toHaveAccessibleName(/已换成编辑片段$/))
    await user.click(await shot(2))
    await user.keyboard('{Shift>}')
    await user.click(await shot(4))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('镜头 2–4 · 视频生成')).toBeVisible()
    pasteTextIntoComposer(requestBox(), '整体调暖')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())

    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]).toMatchObject({ range_start_ms: 1000, range_end_ms: 4000 })
    expect(referenceSamples).toEqual([
      { url: ROOT_URL, start: 1, end: 2 },
      { url: EDITED_URL, start: 0, end: 3 },
    ])
  })

  it('打开镜头提示词显示完整列表，选区变化不筛选也不自动填入', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(rootWithShotPrompts)
    await originalTrack()
    await user.click(screen.getByRole('button', { name: '镜头提示词' }))

    const panel = screen.getByRole('dialog', { name: '镜头提示词' })
    expect(within(panel).getByText('推着单车走过')).toBeVisible()
    expect(within(panel).getByText('停在面包店门口')).toBeVisible()
    expect(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' })).toBeDisabled()
    expect(card()).toBeNull()

    await user.click(await shot(2))
    expect(requestBox().textContent).toBe('')
    expect(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' })).toBeEnabled()
    await user.click(await shot(7))
    expect(requestBox().textContent).toBe('')
    expect(within(panel).getByText('推着单车走过')).toBeVisible()
    expect(within(panel).getByText('停在面包店门口')).toBeVisible()
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

  it('没有结构化镜头时显示空状态，不从整段提示词解析镜头', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(makeGenerationJob({ ...root, request: { prompt: '0–2 秒：推着单车走过' } }))
    await user.click(await shot(2))
    await user.click(screen.getByRole('button', { name: '镜头提示词' }))

    const panel = screen.getByRole('dialog', { name: '镜头提示词' })
    expect(within(panel).getByText('暂无镜头提示词')).toBeVisible()
    expect(within(panel).queryByRole('button', { name: /复制镜头/ })).toBeNull()
    expect(requestBox().textContent).toBe('')
  })
})

describe('选中只把播放头放到选区开头，空格播放', () => {
  const pauseButton = () => screen.queryByRole('button', { name: '暂停' })

  it('点镜头只选中、不播放，播放头在它开头；⇧ 点扩选仍在选区开头；播放中点镜头停在它开头', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()

    await user.click(await shot(2))
    expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')
    await readyToPlay()
    expect(pauseButton()).toBeNull()
    expect(playhead()).toHaveValue('1')

    fireEvent.change(playhead(), { target: { value: '5.5' } })
    await user.keyboard('{Shift>}')
    await user.click(await shot(3))
    await user.keyboard('{/Shift}')
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')
    expect(playhead()).toHaveValue('1')

    await user.click(playButton())
    expect(pauseButton()).toBeVisible()
    await user.click(await shot(4))
    expect(pauseButton()).toBeNull()
    expect(playButton()).toBeVisible()
    expect(playhead()).toHaveValue('3')
  })

  it('←/→ 与 ⇧←/→ 播放头在选区开头；空格在镜头上播放、暂停，不改选中', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await shot(2))

    await user.keyboard('{ArrowRight}')
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(playhead()).toHaveValue('2')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')
    expect(playhead()).toHaveValue('2')
    await user.keyboard('{Shift>}{ArrowLeft}{ArrowLeft}{/Shift}')
    expect(await shot(2)).toHaveFocus()
    expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'false')
    expect(playhead()).toHaveValue('1')

    await readyToPlay()
    await user.keyboard(' ')
    expect(pauseButton()).toBeVisible()
    expect(await shot(2)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard(' ')
    expect(playButton()).toBeVisible()
  })

  it('选用编辑片段后，播放头停在它替换的那段开头；标尺按原片时间定位', async () => {
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(block(/^镜头 3–4 · 3\.0 秒/))
    await waitFor(() => expect(playhead()).toHaveValue('2'))
    // 原片 5 秒在合成里是第 6 秒：编辑片段比它替换的长 1 秒。
    fireEvent.change(playhead(), { target: { value: '5' } })
    expect(controls()).toHaveTextContent('00:06.00')
  })
})

describe('编辑轨与选用', () => {
  it('点可用的编辑片段立即选用：替换的镜头调淡，总长按选用算；再选同样镜头的另一次，前一条取消', async () => {
    serveChain([
      editSegment({ id: EDIT_ID }),
      editSegment({
        id: SECOND_EDIT_ID,
        outputUrl: OTHER_URL,
        durationMs: 1500,
        createdAt: '2026-09-16T10:03:00Z',
      }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()

    await user.click(block(/^镜头 3–4 · 第 1 次/))
    expect(block(/^镜头 3–4 · 第 1 次/)).toHaveAccessibleName(
      '镜头 3–4 · 第 1 次 · 3.0 秒 · 已选用',
    )
    expect(block(/^镜头 3–4 · 第 1 次/)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(3)).toHaveAccessibleName('镜头 3 · 2–3 秒 · 已换成编辑片段')
    expect(within(blockCard()).getByText('3.0 秒 · 已选用')).toBeVisible()
    expect(controls()).toHaveTextContent('共 9.0 秒 · 比原片长 1.0 秒')
    expect(card()).toBeNull()
    expect(
      JSON.parse(window.localStorage.getItem(picksStorageKey(CONVERSATION, ROOT_ID)) ?? ''),
    ).toEqual([EDIT_ID])

    await user.click(block(/^镜头 3–4 · 第 2 次/))
    expect(block(/^镜头 3–4 · 第 2 次/)).toHaveAccessibleName(/已选用$/)
    expect(block(/^镜头 3–4 · 第 1 次/)).toHaveAccessibleName(/未选用$/)
    expect(controls()).toHaveTextContent('共 7.5 秒 · 比原片短 0.5 秒')
  })

  it('「改用原片」取消选用，并选中换回来的镜头', async () => {
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(block(/^镜头 3–4/))
    await user.click(within(blockCard()).getByRole('button', { name: '改用原片' }))

    expect(block(/^镜头 3–4/)).toHaveAccessibleName(/未选用$/)
    expect(within(openCard()).getByText('镜头 3–4 · 视频生成')).toBeVisible()
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(await shot(4)).toHaveAttribute('aria-pressed', 'true')
    expect(controls()).toHaveTextContent('共 8.0 秒')
  })

  it('点被替换的镜头选中整条编辑片段；Shift 按单位扩选', async () => {
    window.localStorage.setItem(picksStorageKey(CONVERSATION, ROOT_ID), JSON.stringify([EDIT_ID]))
    serveChain([editSegment({ id: EDIT_ID })])
    const user = userEvent.setup()
    await renderEditor()
    await waitFor(async () => expect(await shot(4)).toHaveAccessibleName(/已换成编辑片段$/))

    await user.click(await shot(4))
    expect(within(openCard()).getByText('镜头 3–4 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('原片 2.0 – 4.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(await shot(3)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Shift>}')
    await user.click(await shot(5))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('镜头 3–5 · 视频生成')).toBeVisible()
  })

  it('时长还在读的编辑片段写「读取中」，不能选用', async () => {
    serveChain([editSegment({ durationMs: null })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(block('镜头 3–4 · 读取中'))
    expect(within(blockCard()).getByText('镜头 3–4 · 读取中')).toBeVisible()
    expect(controls()).toHaveTextContent('共 8.0 秒')
  })

  it('时长读不出的编辑片段写「无法读取」，不能选用', async () => {
    restoreMedia = stubMediaDurations({ [EDITED_URL]: null })
    serveChain([editSegment({ durationMs: null })])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(
      await within(editTrack()).findByRole('button', { name: '镜头 3–4 · 无法读取' }),
    )
    expect(within(blockCard()).getByText('镜头 3–4 · 无法读取')).toBeVisible()
    expect(controls()).toHaveTextContent('共 8.0 秒')
  })

  it('选着一条在跑的编辑片段，它完成后不再选着，也不自动选用', async () => {
    let chain = [
      editSegment({ id: EDIT_ID, status: 'submitted', outputUrl: null, durationMs: null }),
    ]
    serveJobs(() => chain)
    const user = userEvent.setup()
    const view = await renderEditor()
    await originalTrack()
    await user.click(block('镜头 3–4 · 生成中'))
    expect(within(blockCard()).getByText('镜头 3–4 · 生成中')).toBeVisible()

    chain = [editSegment({ id: EDIT_ID })]
    await act(() => view.queryClient.invalidateQueries())
    await waitFor(() => expect(screen.queryByRole('region', { name: '编辑片段' })).toBeNull())
    expect(block(/^镜头 3–4/)).toHaveAccessibleName(/未选用$/)
  })

  it('存着的选用可用就照它恢复', async () => {
    window.localStorage.setItem(picksStorageKey(CONVERSATION, ROOT_ID), JSON.stringify([EDIT_ID]))
    serveChain([editSegment({ id: EDIT_ID })])
    await renderEditor()
    await waitFor(() => expect(block(/^镜头 3–4/)).toHaveAccessibleName(/已选用$/))
    expect(controls()).toHaveTextContent('共 9.0 秒')
  })

  it('没存过选用时照最近一次合成推出来', async () => {
    serveChain([
      editSegment({ id: EDIT_ID }),
      composite({
        id: COMPOSITE_ID,
        request: {
          segments: [
            { sourceJobId: ROOT_ID, start: 0, end: 2, url: ROOT_URL },
            { sourceJobId: EDIT_ID, start: 0, end: 3, url: EDITED_URL },
            { sourceJobId: ROOT_ID, start: 4, end: 8, url: ROOT_URL },
          ],
        },
      }),
    ])
    await renderEditor()
    await waitFor(() => expect(block(/^镜头 3–4/)).toHaveAccessibleName(/已选用$/))
    // 和最近一次合成一样，不能再合成。
    expect(composeButton()).toBeDisabled()
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
    await user.click(block(/^镜头 3–4/))
    await user.click(viewButton('版本'))
    await waitFor(() => expect(failureNotice()).toHaveTextContent('合成失败：拼接失败'))
    const notice = failureNotice()
    if (notice === null) throw new Error('没有失败提醒')
    await user.click(notice)

    expect(viewButton('剪辑')).toHaveAttribute('aria-pressed', 'true')
    expect(card()).toBeNull()
    expect(screen.queryByRole('region', { name: '编辑片段' })).toBeNull()
    await user.click(composeButton())
    await waitFor(() => expect(failureNotice()).toBeNull())
  })
})

describe('合成与版本视图', () => {
  it('合成：原片相连部分并成一段、编辑片段整段；完成后自动切到版本视图看新版本，只能下载、不能合成', async () => {
    let chain: GenerationJob[] = [editSegment({ id: EDIT_ID })]
    const composed: Record<string, unknown>[] = []
    serveJobs(() => chain)
    server.use(
      http.post('*/api/generations/video-composites', async ({ request }) => {
        const body = (await request.json()) as { segments: unknown[] }
        composed.push(body)
        // 后端把各段原样记进请求，另带上出处地址。
        const created = composite({
          id: COMPOSITE_ID,
          status: 'submitted',
          outputUrl: null,
          finishedAt: null,
          request: { segments: body.segments },
        })
        chain = [...chain, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const view = await renderEditor()
    await originalTrack()
    expect(composeButton()).toBeDisabled()
    await user.click(block(/^镜头 3–4/))
    expect(composeButton()).toBeEnabled()
    await user.click(composeButton())

    await waitFor(() => expect(composed).toHaveLength(1))
    expect(composed[0]).toEqual({
      conversationId: CONVERSATION,
      taskId: null,
      baseJobId: ROOT_ID,
      segments: [
        { sourceJobId: ROOT_ID, start: 0, end: 2 },
        { sourceJobId: EDIT_ID, start: 0, end: null },
        { sourceJobId: ROOT_ID, start: 4, end: 8 },
      ],
    })
    expect(await within(controls()).findByRole('button', { name: '正在合成' })).toBeDisabled()
    await user.click(viewButton('版本'))
    expect(await findVersion('合成中')).toBeDisabled()
    expect(versionButton('V1 原片')).toHaveAttribute('aria-pressed', 'true')
    await user.click(viewButton('剪辑'))

    chain = chain.map((job) =>
      job.id === COMPOSITE_ID
        ? {
            ...job,
            status: 'completed' as const,
            outputUrl: COMPOSITE_URL,
            finishedAt: '2026-09-16T10:09:00Z',
          }
        : job,
    )
    await act(() => view.queryClient.invalidateQueries())
    await waitFor(() => expect(viewButton('版本')).toHaveAttribute('aria-pressed', 'true'))
    expect(await findVersion('V2')).toHaveAttribute('aria-pressed', 'true')
    expect(within(controls()).getByRole('button', { name: '下载' })).toBeEnabled()
    expect(within(controls()).queryByRole('button', { name: /合成/ })).toBeNull()
    expect(await screen.findByLabelText('视频播放器')).toHaveAttribute('src', COMPOSITE_URL)

    await user.click(viewButton('剪辑'))
    expect(composeButton()).toBeDisabled()
  })

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
    await user.click(block(/^镜头 3–4/))
    await user.click(composeButton())
    expect(await screen.findByText(/合成服务不可用/)).toBeVisible()
    expect(composeButton()).toBeEnabled()
  })

  it('从一次合成打开：版本视图看那一版；每个版本一行、最新的在最上，点原片那行舞台换成原片、从头停着', async () => {
    const opened = composite({ id: COMPOSITE_ID })
    serveChain([root, opened])
    const user = userEvent.setup()
    await renderEditor(opened)

    await waitFor(() => expect(viewButton('版本')).toHaveAttribute('aria-pressed', 'true'))
    expect(await findVersion('V2')).toHaveAttribute('aria-pressed', 'true')
    expect(buttonNames(versionRows())).toEqual(['V2', 'V1 原片'])
    expect(within(controls()).getByRole('button', { name: '下载' })).toBeEnabled()
    await waitFor(() => expect(controls()).toHaveTextContent('共 9.0 秒'))
    // 两行共用最长那一版的比例。
    expect(playhead()).toHaveAttribute('max', '9')
    fireEvent.change(playhead(), { target: { value: '4' } })
    expect(controls()).toHaveTextContent('00:04.00')

    await user.click(versionButton('V1 原片'))
    expect(versionButton('V1 原片')).toHaveAttribute('aria-pressed', 'true')
    expect(versionButton('V2')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(controls()).toHaveTextContent('共 8.0 秒'))
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
    expect(playhead()).toHaveValue('0')
    expect(playButton()).toBeVisible()
  })

  it('失败的合成不占版本行', async () => {
    serveChain([
      composite({ id: COMPOSITE_ID, status: 'failed', outputUrl: null, errorMessage: '拼接失败' }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await originalTrack()
    await user.click(viewButton('版本'))

    expect(await findVersion('V1 原片')).toHaveAttribute('aria-pressed', 'true')
    expect(within(versionRows()).getAllByRole('button')).toHaveLength(1)
  })

  it('提交未受理时不能切换查看方式、不能关闭或离开；受理后都恢复', async () => {
    loginAs(mockAuthUser)
    const chain: GenerationJob[] = []
    let accept = () => {}
    const acceptance = new Promise<void>((resolve) => (accept = resolve))
    serveJobs(() => chain)
    server.use(
      http.post('*/api/generations/video-edits', async () => {
        await acceptance
        const created = editSegment({
          status: 'submitted',
          outputUrl: null,
          rangeStartMs: 1000,
          rangeEndMs: 2000,
        })
        chain.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { router } = await renderEditor(root, onClose)
    await user.click(await shot(2))
    pasteTextIntoComposer(requestBox(), '换成黄昏')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    try {
      expect(within(openCard()).getByRole('button', { name: '正在提交' })).toBeDisabled()
      expect(viewButton('版本')).toBeDisabled()
      await user.click(screen.getByRole('button', { name: '关闭视频编辑' }))
      expect(onClose).not.toHaveBeenCalled()
      await act(async () => {
        void router.navigate({ to: '/c/$conversationId', params: { conversationId: 'other' } })
      })
      expect(router.state.location.pathname).toBe('/c/test')
    } finally {
      await act(async () => accept())
    }
    expect(
      await within(editTrack()).findByRole('button', { name: '镜头 2 · 生成中' }),
    ).toBeVisible()
    expect(viewButton('版本')).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '关闭视频编辑' }))
    expect(onClose).toHaveBeenCalledOnce()
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

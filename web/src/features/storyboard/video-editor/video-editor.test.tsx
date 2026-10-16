import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { delay, http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { VIDEO_MODELS } from '@/testing/video-models'
import type { GenerationJob } from '../storyboard.api'
import { draftStorageKey } from './use-edit-draft'
import { viewStorageKey } from './use-picked-view'
import { VideoEditor } from './video-editor'

/** mediabunny 的替身：按地址给关键帧表与时长，都没有音轨；切参考片段时直接给几个字节。jsdom 读不了真文件。 */
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())
/** 按地址挡住读文件：放进一个没兑现的 Promise，读关键帧就停在那里，兑现了才读完。默认不挡。 */
const fileGates = vi.hoisted(() => new Map<string, Promise<void>>())
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
    getPrimaryVideoTrack = async () => {
      await fileGates.get(this.url)
      return {
        url: this.url,
        canDecode: () => Promise.resolve(true),
        computeDuration: () => Promise.resolve(files.get(this.url)?.duration ?? 0),
        getDisplayWidth: () => Promise.resolve(720),
        getDisplayHeight: () => Promise.resolve(1280),
      }
    }
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
const ROOT_ID = '0f6a2c9e-8d4b-4c1e-9a7f-3b5d6e8f1a2b'
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

const renderEditor = (job = root, onClose = () => {}) =>
  renderWithProviders(
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={onClose}
      root={job}
      shotIndex={1}
    />,
    { initialPath: '/c/test' },
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

/** 时间线上第 n 段。jsdom 没有指针捕获，按下段时会捕获指针（好分辨是点还是拖），这里补上。 */
const segmentOf = (track: HTMLElement, position: number) =>
  Object.assign(within(track).getByRole('button', { name: new RegExp(`^第 ${position} 段`) }), {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })

const card = () => screen.queryByRole('region', { name: 'AI 改段' })
const openCard = () => screen.getByRole('region', { name: 'AI 改段' })
const requestBox = () => within(openCard()).getByLabelText('修改要求')
const generateButton = () => within(openCard()).getByRole('button', { name: '生成视频' })
const versionStrip = () => screen.getByRole('group', { name: '视频版本' })
const versionButton = (label: string) =>
  within(versionStrip()).getByRole('button', { name: new RegExp(`^${label}(?: ·|$)`) })
const scopeButton = (name: '整片' | '片段') =>
  within(screen.getByRole('group', { name: '视频预览范围' })).getByRole('button', {
    name,
  })

let restoreMedia = () => {}

beforeEach(() => {
  // 既有剪辑交互使用支持 1 秒编辑的 Wan；Seedance 边界用例显式选择自己的模型。
  server.use(
    http.get('*/api/generations/video-models', () =>
      HttpResponse.json({ ...VIDEO_MODELS, default: 'wan3.0-video' }),
    ),
  )
  // 原片 8 秒，每秒一个关键帧。
  files.set(ROOT_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6, 7], duration: 8 })
  window.localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  restoreMedia()
  restoreMedia = () => {}
  vi.restoreAllMocks()
  files.clear()
  referenceSamples.length = 0
  fileGates.clear()
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
    await user.click(segmentOf(await timeline(), 2))

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
    await user.click(segmentOf(await timeline(), 2))

    expect(await within(openCard()).findByText(/模型清单读不到/)).toBeVisible()
    await user.click(within(openCard()).getByRole('button', { name: '重新加载模型' }))

    await waitFor(() => expect(requests).toBe(2))
  })

  it('时间线按关键帧分段，原声没有音轨时写「无声」；没选段时没有卡', async () => {
    serveChain([])
    await renderEditor()

    const track = await timeline()
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(8)
    expect(within(track).getAllByText('无声').length).toBeGreaterThan(0)
    expect(card()).toBeNull()
  })

  it('原声下面有字幕轨与音乐轨，现在都是空的', async () => {
    serveChain([])
    await renderEditor()

    const track = await timeline()
    expect(within(track).getByText('字幕')).toBeInTheDocument()
    expect(within(track).getByText('音乐')).toBeInTheDocument()
    expect(within(track).getByTestId('timeline-captions')).toBeEmptyDOMElement()
    expect(within(track).getByTestId('timeline-music')).toBeEmptyDOMElement()
  })
})

describe('AI 改段的弹出卡', () => {
  // 加参考图要有上传权限；jsdom 不解码图片，上传前的尺寸校验读这个桩。
  beforeEach(() => {
    loginAs(mockAuthUser)
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('点段弹卡：卡头写要改哪几段、区间与做法；不抢焦点，方向键照常改选中，卡跟着换', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()

    await user.click(segmentOf(track, 2))
    expect(within(openCard()).getByText('第 2 段 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('1.0 – 2.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(segmentOf(track, 2)).toHaveFocus()

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(within(openCard()).getByText('第 2–3 段 · 视频生成')).toBeVisible()
    expect(within(openCard()).getByText('1.0 – 3.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(segmentOf(track, 3)).toHaveFocus()
  })

  it('Escape 把卡收成胶囊，未提交的字还在；点胶囊展开、光标进输入框；换了选区要求不清空', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))

    // 点进卡里才聚焦输入框（jsdom 里 ProseMirror 量不了点击位置，直接给焦点）。
    act(() => requestBox().focus())
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
    await user.keyboard('{Escape}')

    expect(card()).toBeNull()
    expect(screen.getByRole('dialog', { name: /编辑视频/ })).toBeVisible()
    const mini = screen.getByRole('button', { name: '展开第 2 段 · 视频生成，未提交' })
    expect(mini).toHaveFocus()

    await user.click(mini)
    expect(requestBox()).toHaveTextContent('换成黄昏的暖光')
    expect(requestBox()).toHaveFocus()

    // 换一段：卡跟着换，要求留着。
    await user.click(segmentOf(track, 5))
    expect(within(openCard()).getByText('第 5 段 · 视频生成')).toBeVisible()
    expect(requestBox()).toHaveTextContent('换成黄昏的暖光')
  })

  it('收起时还在上传的参考图留不下来：展开后卡里说出几张要重新添加，写好的字照旧；再改要求提示收起', async () => {
    // 签名一直不回：图片停在上传中。
    server.use(http.post('*/api/uploads/sign', () => delay('infinite')))
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(segmentOf(await timeline(), 2))

    pasteTextIntoComposer(requestBox(), '色调参考')
    pasteFilesIntoComposer(requestBox(), [
      new File(['png-bytes'], '黄昏.png', { type: 'image/png' }),
    ])
    expect(within(requestBox()).getByText('黄昏.png')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(card()).toBeNull()

    await user.click(screen.getByRole('button', { name: /^展开第 2 段 · 视频生成/ }))
    expect(
      within(openCard()).getByText('有 1 张图片收起时尚未上传完成，未能保留，请重新添加'),
    ).toBeVisible()
    expect(requestBox()).toHaveTextContent('色调参考')
    expect(within(requestBox()).queryByText('黄昏.png')).toBeNull()

    pasteTextIntoComposer(requestBox(), '，暖一点')
    expect(within(openCard()).queryByText(/张图片收起时尚未上传完成/)).toBeNull()
  })

  it('拖播放头、按播放都把卡收起；点选区里的段只展开、不改选中', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    expect(openCard()).toBeVisible()

    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '4.5' },
    })
    expect(card()).toBeNull()
    expect(screen.getByRole('button', { name: '展开第 2 段 · 视频生成' })).toBeVisible()

    await user.click(segmentOf(track, 2))
    expect(openCard()).toBeVisible()
    expect(segmentOf(track, 2)).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: '暂停' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '播放' })).not.toHaveAttribute('aria-disabled'),
    )
    await user.click(screen.getByRole('button', { name: '播放' }))
    expect(card()).toBeNull()
    expect(screen.getByRole('button', { name: '展开第 2 段 · 视频生成' })).toBeVisible()
  })

  it.each([
    {
      name: '短于 1 秒',
      keyframes: [0, 0.5, 1, 2, 3, 4, 5, 6, 7],
      prepare: async () => {},
      position: 1,
      reason: '该模型编辑至少需要 1 秒；请按住 Shift 选择相邻片段',
    },
    {
      name: '拆过',
      keyframes: [0, 1, 2, 3, 4, 5, 6, 7],
      prepare: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(scopeButton('片段'))
        fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
          target: { value: '0.5' },
        })
        await user.click(screen.getByRole('button', { name: '拆分' }))
      },
      position: 1,
      reason: '该模型编辑至少需要 1 秒；请按住 Shift 选择相邻片段',
    },
  ])(
    '选区不能交给 AI（$name）：卡头写原因，写了要求也生成不了',
    async ({ keyframes, prepare, position, reason }) => {
      files.set(ROOT_URL, { keyframes, duration: 8 })
      serveChain([])
      const user = userEvent.setup()
      await renderEditor()
      const track = await timeline()
      await prepare(user)
      await user.click(segmentOf(track, position))

      expect(within(openCard()).getByText(reason)).toBeVisible()
      pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
      expect(generateButton()).toBeDisabled()
    },
  )

  it('能交给 AI 时，写了要求才能生成', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(segmentOf(await timeline(), 2))

    expect(generateButton()).toBeDisabled()
    pasteTextIntoComposer(requestBox(), '换成黄昏的暖光')
    await waitFor(() => expect(generateButton()).toBeEnabled())
  })

  it('Seedance 编辑不足 4 秒时禁用，相邻选区合计 4 秒后才可提交', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    pasteTextIntoComposer(requestBox(), '保留动作，调整灯光')

    expect(await within(openCard()).findByText(/编辑至少需要 4 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
    await user.keyboard('{Shift>}')
    await user.click(segmentOf(track, 3))
    await user.click(segmentOf(track, 4))
    await user.click(segmentOf(track, 5))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('1.0 – 5.0 秒 · 视频和原声一起重做')).toBeVisible()
    expect(generateButton()).toBeEnabled()
  })

  it('Seedance 编辑超过 30 秒时禁止提交并显示上限', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    files.set(ROOT_URL, { keyframes: [0], duration: 31 })
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(segmentOf(await timeline(), 1))
    pasteTextIntoComposer(requestBox(), '调整灯光')
    expect(await within(openCard()).findByText(/编辑最多支持 30 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
  })

  it('不足 4 秒的选区仍可图生；切换模型不静默改掉超出范围的输出时长', async () => {
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(VIDEO_MODELS)))
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    pasteTextIntoComposer(requestBox(), '人物转身')
    pasteFilesIntoComposer(requestBox(), [new File(['png'], '人物.png', { type: 'image/png' })])
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(within(openCard()).getByRole('button', { name: '生成时长' }))
    await user.click(screen.getByRole('menuitemradio', { name: '30 秒' }))
    await user.click(within(openCard()).getByRole('button', { name: '图生模型' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-0' }))

    expect(within(openCard()).getByRole('button', { name: '生成时长' })).toHaveTextContent('30 秒')
    expect(within(openCard()).getByText(/图生时长须为 4–15 秒/)).toBeVisible()
    expect(generateButton()).toBeDisabled()
    await user.click(within(openCard()).getByRole('button', { name: '生成时长' }))
    expect(screen.queryByRole('menuitemradio', { name: '16 秒' })).toBeNull()
    await user.click(screen.getByRole('menuitemradio', { name: '15 秒' }))
    expect(generateButton()).toBeEnabled()
  })

  it('图生只提交正文引用：粘贴自动上传并引用，删除的图与未插入首帧不发送，插入首帧后保持原地址', async () => {
    const sourceUrl = 'https://test.oss-cn-hangzhou.aliyuncs.com/source.mp4'
    files.set(sourceUrl, { keyframes: [0, 1, 2, 3, 4], duration: 5 })
    serveChain([])
    const submitted: Record<string, unknown>[] = []
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>)
        return HttpResponse.json(
          { generation: editSegment({ status: 'submitted' }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor(makeGenerationJob({ ...root, outputUrl: sourceUrl }))
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.click(within(openCard()).getByRole('radio', { name: '图生' }))
    pasteTextIntoComposer(requestBox(), '人物转身，保持造型')
    const image = (name: string) => new File(['png'], name, { type: 'image/png' })
    pasteFilesIntoComposer(requestBox(), [image('保留.png')])
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
    expect(submitted[0]?.['prompt']).toBe('人物转身，保持造型@Image1')
    expect(referenceSamples).toEqual([])

    await user.click(segmentOf(track, 3))
    pasteTextIntoComposer(requestBox(), '继续转身，参考')
    act(() => requestBox().focus())
    await user.keyboard('@选区首帧{Enter}')
    expect(within(requestBox()).getByText('选区首帧')).toBeVisible()
    await user.click(segmentOf(track, 4))
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[1]?.['reference_image_urls']).toEqual([
      `${sourceUrl}?x-oss-process=video/snapshot,t_2000,f_jpg,w_1280,h_0`,
    ])
  })

  it('提交：参考图按出现的先后编成 @Image1、@Image2 与 reference_image_urls；成功后要求清空', async () => {
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
    // 受理的编辑段进链里，轮询照样看得到它在跑。
    const chain: ReturnType<typeof makeGenerationJob>[] = []
    // 图片按上传确认的先后记下地址；两张图一张传完再加下一张，先后就是正文里的先后。
    const confirmedImages: string[] = []
    server.events.on('response:mocked', async ({ request, response }) => {
      if (!/\/api\/uploads\/[^/]+\/confirm$/.test(request.url)) return
      const body = (await response.clone().json()) as { contentType: string; url: string }
      if (body.contentType.startsWith('image/')) confirmedImages.push(body.url)
    })
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: chain })),
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>
        const created = editSegment({ status: 'submitted', rangeStartMs: 1000, rangeEndMs: 3000 })
        chain.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Shift>}')
    await user.click(segmentOf(track, 3))
    await user.keyboard('{/Shift}')
    await waitFor(() =>
      expect(within(openCard()).getByRole('button', { name: '编辑模型' })).toHaveTextContent(
        'wan3.0-video',
      ),
    )

    const image = (name: string) => new File(['png-bytes'], `${name}.png`, { type: 'image/png' })
    pasteTextIntoComposer(requestBox(), '光线参考')
    pasteFilesIntoComposer(requestBox(), [image('光线')])
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await waitFor(() => expect(confirmedImages).toHaveLength(1))
    pasteTextIntoComposer(requestBox(), '，构图参考')
    pasteFilesIntoComposer(requestBox(), [image('构图')])
    // 第二张传着时生成钮灰着，传完才亮。
    expect(generateButton()).toBeDisabled()
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())

    await waitFor(() => expect(submitted).toBeDefined())
    expect(submitted).toMatchObject({
      range_start_ms: 1000,
      range_end_ms: 3000,
      model: 'wan3.0-video',
      prompt: '光线参考@Image1，构图参考@Image2',
    })
    await waitFor(() => expect(confirmedImages).toHaveLength(2))
    expect(submitted?.['reference_image_urls']).toEqual(confirmedImages)

    // 在侧栏显示生成状态，保留当前选用的原片，其他段照常可选。
    expect(await within(versionStrip()).findByRole('button', { name: /V1 · 生成中/ })).toBeVisible()
    expect(within(track).queryByRole('img', { name: /AI 生成中/ })).toBeNull()
    expect(within(track).queryByRole('status')).toBeNull()
    expect(segmentOf(track, 2)).toHaveAttribute('aria-pressed', 'true')
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')

    // 再选一段：要求已经清空。
    await user.click(segmentOf(track, 1))
    expect(requestBox().textContent).toBe('')
  })

  it('有原作镜头和参考图时仍由用户填写要求，换选区保留手动输入', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(
      makeGenerationJob({
        ...root,
        request: {
          shot: {
            global_settings: '写实',
            timeline: [
              { timestamps: [0, 2], prompt: '@Image1 推着单车走过', image_indexes: [1] },
              { timestamps: [2, 8], prompt: '停在面包店门口', image_indexes: [] },
            ],
          },
          reference_image_urls: ['https://example.com/refs/boy.png'],
        },
      }),
    )
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    expect(requestBox().textContent).toBe('')
    expect(generateButton()).toBeDisabled()

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(requestBox().textContent).toBe('')
    expect(generateButton()).toBeDisabled()

    pasteTextIntoComposer(requestBox(), '换成黄昏')
    await user.click(segmentOf(track, 7))
    expect(requestBox()).toHaveTextContent('换成黄昏')
    await waitFor(() => expect(generateButton()).toBeEnabled())
  })

  it('打开镜头提示词显示完整列表，选区变化不筛选也不自动填入', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(rootWithShotPrompts)
    const track = await timeline()
    await user.click(screen.getByRole('button', { name: '镜头提示词' }))

    const panel = screen.getByRole('dialog', { name: '镜头提示词' })
    expect(within(panel).getByText('推着单车走过')).toBeVisible()
    expect(within(panel).getByText('停在面包店门口')).toBeVisible()
    expect(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' })).toBeDisabled()
    expect(card()).toBeNull()

    await user.click(segmentOf(track, 2))
    expect(requestBox().textContent).toBe('')
    expect(within(panel).getByRole('button', { name: '复制镜头 1 到输入框' })).toBeEnabled()
    await user.click(segmentOf(track, 7))
    expect(requestBox().textContent).toBe('')
    expect(within(panel).getByText('推着单车走过')).toBeVisible()
    expect(within(panel).getByText('停在面包店门口')).toBeVisible()
  })

  it('多次复制镜头提示词依次追加，保留已有文字和参考图，浮窗保持打开', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor(rootWithShotPrompts)
    await user.click(segmentOf(await timeline(), 2))
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
    await user.click(segmentOf(await timeline(), 2))
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
    await user.click(segmentOf(await timeline(), 2))
    await user.click(screen.getByRole('button', { name: '镜头提示词' }))

    const panel = screen.getByRole('dialog', { name: '镜头提示词' })
    expect(within(panel).getByText('暂无镜头提示词')).toBeVisible()
    expect(within(panel).queryByRole('button', { name: /复制镜头/ })).toBeNull()
    expect(requestBox().textContent).toBe('')
  })
})

describe('整片版本与片段选用', () => {
  it('整片预览按时间线选用的媒体播放，选用编辑结果后无需合成', async () => {
    serveChain([editSegment({ outputUrl: EDITED_URL, durationMs: 2500 })])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 3))
    await user.click(versionButton('V1'))
    await user.click(scopeButton('整片'))
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '3' },
    })

    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', EDITED_URL)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.5 秒')
    expect(within(segmentOf(track, 3)).getByText('V1')).toBeVisible()
  })

  it('提交未受理就显示提交中，受理后原位成为生成中', async () => {
    loginAs(mockAuthUser)
    const chain: GenerationJob[] = []
    let accept = () => {}
    const acceptance = new Promise<void>((resolve) => (accept = resolve))
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: chain })),
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
    await user.click(segmentOf(await timeline(), 2))
    pasteTextIntoComposer(requestBox(), '换成黄昏')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    try {
      const submitting = within(versionStrip()).getByRole('button', { name: /提交中/ })
      expect(submitting).toBeDisabled()
      expect(within(submitting).queryByRole('img', { name: '新结果' })).toBeNull()
      expect(chain).toHaveLength(0)
      expect(submitting).toHaveAccessibleName('V1 · 提交中')
      expect(scopeButton('整片')).toBeDisabled()
      expect(scopeButton('片段')).toBeDisabled()
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
      await within(versionStrip()).findByRole('button', { name: 'V1 · 生成中' }),
    ).toBeDisabled()
    expect(within(versionStrip()).queryByRole('button', { name: /提交中/ })).toBeNull()
    expect(scopeButton('整片')).toBeEnabled()
    expect(scopeButton('片段')).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '关闭视频编辑' }))
    expect(onClose).toHaveBeenCalledOnce()
    await act(() =>
      router.navigate({ to: '/c/$conversationId', params: { conversationId: 'other' } }),
    )
    expect(router.state.location.pathname).toBe('/c/other')
  })

  it('提交失败移除提交中候选，保留输入和错误，允许关闭或重新提交', async () => {
    loginAs(mockAuthUser)
    serveChain([])
    let fail = () => {}
    const submission = new Promise<void>((resolve) => (fail = resolve))
    server.use(
      http.post('*/api/generations/video-edits', async () => {
        await submission
        return HttpResponse.json({ detail: '编辑任务提交失败' }, { status: 503 })
      }),
    )
    const user = userEvent.setup()
    const onClose = vi.fn()
    await renderEditor(root, onClose)
    await user.click(segmentOf(await timeline(), 2))
    pasteTextIntoComposer(requestBox(), '保留这条修改要求')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    expect(within(versionStrip()).getByRole('button', { name: 'V1 · 提交中' })).toBeDisabled()
    await act(async () => fail())

    expect(await within(openCard()).findByText(/编辑任务提交失败/)).toBeVisible()
    expect(within(versionStrip()).getAllByRole('button')).toHaveLength(1)
    expect(versionButton('原片')).toBeVisible()
    expect(requestBox()).toHaveTextContent('保留这条修改要求')
    expect(generateButton()).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '关闭视频编辑' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('生成中和失败没有新结果绿点，完成并可播放后才显示，查看后消失', async () => {
    const running = editSegment({ status: 'submitted', outputUrl: null })
    const failed = editSegment({ status: 'submitted', outputUrl: null })
    let chain = [running, failed]
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: chain })))
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 3))
    expect(within(versionStrip()).getAllByRole('button', { name: /生成中/ })).toHaveLength(2)
    expect(within(versionStrip()).queryByRole('img', { name: '新结果' })).toBeNull()
    expect(within(versionStrip()).queryByRole('button', { name: /新结果/ })).toBeNull()

    chain = [running, { ...failed, status: 'failed', errorMessage: '上游失败' }]
    await act(() => view.queryClient.invalidateQueries())
    expect(await within(versionStrip()).findByRole('button', { name: /失败/ })).toBeDisabled()
    expect(within(versionStrip()).queryByRole('img', { name: '新结果' })).toBeNull()

    chain = [
      { ...running, status: 'completed', outputUrl: EDITED_URL, durationMs: 2500 },
      { ...failed, status: 'failed', errorMessage: '上游失败' },
    ]
    await act(() => view.queryClient.invalidateQueries())
    const completed = await within(versionStrip()).findByRole('button', { name: /新结果/ })
    expect(within(completed).getByRole('img', { name: '新结果' })).toBeVisible()
    expect(within(versionStrip()).getAllByRole('img', { name: '新结果' })).toHaveLength(1)
    await user.click(completed)
    expect(within(versionStrip()).queryByRole('img', { name: '新结果' })).toBeNull()
  })

  it('整片与片段共用现有版本栏，原片单独命名且时间线不挂编号', async () => {
    serveChain([])
    const user = userEvent.setup()
    await renderEditor()

    const track = await timeline()
    expect(versionButton('原片')).toBeVisible()
    expect(screen.getByRole('group', { name: '视频预览范围' })).toBeVisible()
    expect(within(versionStrip()).queryByRole('button', { name: /未合成/ })).toBeNull()
    expect(within(track).queryByText('原片')).toBeNull()
    expect(within(track).queryAllByText(/^V\d+$/)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '合成成片' })).toBeNull()
    await user.click(segmentOf(track, 2))
    expect(scopeButton('片段')).toHaveAttribute('aria-pressed', 'true')
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    expect(within(track).queryByText('原片')).toBeNull()
  })

  it('已有编辑结果只列为候选；点击 V1 才选用，查看整片保留选择，恢复原片清除编号', async () => {
    restoreMedia = stubMediaDurations({ [EDITED_URL]: 2.5 })
    serveChain([editSegment({ outputUrl: EDITED_URL, durationMs: 2500 })])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    // 已编辑区间归成一段，但仍然使用原来的 2 秒素材。
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.0 秒')
    await user.click(segmentOf(track, 3))
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    expect(versionButton('V1')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
    await user.click(versionButton('V1'))
    expect(versionButton('V1')).toHaveAttribute('aria-pressed', 'true')
    expect(within(segmentOf(track, 3)).getByText('V1')).toBeVisible()
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', EDITED_URL)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.5 秒')
    expect(screen.getByRole('button', { name: '合成成片' })).toBeEnabled()

    await user.click(scopeButton('整片'))
    expect(within(versionStrip()).getAllByRole('button')).toHaveLength(1)
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
    expect(within(segmentOf(track, 3)).getByText('V1')).toBeVisible()
    await user.click(segmentOf(track, 3))
    expect(versionButton('V1')).toHaveAttribute('aria-pressed', 'true')
    await user.click(versionButton('原片'))
    expect(within(segmentOf(track, 3)).queryByText('原片')).toBeNull()
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.0 秒')
    expect(within(track).queryAllByText(/^V\d+$/)).toHaveLength(0)
  })

  it('生成状态只在侧边版本栏，保留当前素材和片段高亮，其他片段可以继续剪辑', async () => {
    serveChain([editSegment({ status: 'submitted' })])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 3))
    expect(versionButton('V1')).toHaveAccessibleName(/生成中/)
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    expect(segmentOf(track, 3)).toHaveAttribute('aria-pressed', 'true')
    expect(within(track).queryByRole('img', { name: /AI 生成中/ })).toBeNull()
    expect(within(track).queryByRole('status')).toBeNull()
    await user.click(segmentOf(track, 1))
    await user.keyboard('{Delete}')
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(6)
    expect(screen.getByRole('button', { name: '合成成片' })).toBeEnabled()
  })

  it('结果时长读不出来时不能选用，保留当前素材并说明失败', async () => {
    restoreMedia = stubMediaDurations({ [EDITED_URL]: null })
    serveChain([editSegment({ outputUrl: EDITED_URL })])
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 3))
    await user.click(versionButton('V1'))
    expect(await screen.findByText(/结果时长读取失败/)).toBeVisible()
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.0 秒')
  })

  it('存着的剪辑选择读不出来：恢复原片并说明，已有候选仍能选择', async () => {
    window.localStorage.setItem(draftStorageKey(CONVERSATION, ROOT_ID), '{"version":1')
    serveChain([])
    await renderEditor()
    expect(
      await screen.findByText('剪辑选择读取失败，已恢复原片；生成结果仍可在片段版本中选择'),
    ).toBeVisible()
    expect(await timeline()).toBeVisible()
  })

  it('剪了就存进浏览器：删掉一段后重开，选择和时长仍然保留', async () => {
    serveChain([])
    const user = userEvent.setup()
    const { unmount } = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    await waitFor(() =>
      expect(window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))).not.toBeNull(),
    )
    unmount()
    await renderEditor()
    expect(within(await timeline()).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent(
      '共 7.0 秒 · 比 原片 短 1.0 秒',
    )
  })
})

describe('片段版本的提交来源', () => {
  it('在已选 V1 上继续编辑，参考使用当前结果，版本仍绑定原片替换区间', async () => {
    loginAs(mockAuthUser)
    files.set(EDITED_URL, { keyframes: [0], duration: 2.5 })
    const used = editSegment({ outputUrl: EDITED_URL, durationMs: 2500 })
    serveChain([used])
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(
          {
            generation: editSegment({
              status: 'submitted',
              sourceJobId: ROOT_ID,
              rangeStartMs: 2000,
              rangeEndMs: 4000,
            }),
          },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await user.click(segmentOf(await timeline(), 3))
    await user.click(versionButton('V1'))
    pasteTextIntoComposer(requestBox(), '鞋底再厚一点')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toBeDefined())
    expect(submitted).toMatchObject({
      source_job_id: ROOT_ID,
      range_start_ms: 2000,
      range_end_ms: 4000,
      prompt: '鞋底再厚一点',
    })
    expect(referenceSamples).toEqual([{ url: EDITED_URL, start: 0, end: 2.5 }])
  })

  it('选中已编辑区间及相邻原片，用当前内容生成更大范围，采用后只替换这个范围', async () => {
    loginAs(mockAuthUser)
    files.set(EDITED_URL, { keyframes: [0], duration: 3 })
    const used = editSegment({ outputUrl: EDITED_URL, durationMs: 3000 })
    const wideUrl = 'https://example.com/wide.mp4'
    files.set(wideUrl, { keyframes: [0], duration: 5 })
    const wide = editSegment({ outputUrl: wideUrl, durationMs: 5000, rangeEndMs: 6000 })
    const chain = [used]
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: chain })),
      http.post('*/api/generations/video-edits', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>
        chain.push(wide)
        return HttpResponse.json({ generation: wide }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 3))
    await user.click(versionButton('V1'))
    await user.keyboard('{Shift>}')
    await user.click(segmentOf(track, 4))
    await user.click(segmentOf(track, 5))
    await user.keyboard('{/Shift}')
    expect(within(openCard()).getByText('2.0 – 6.0 秒 · 视频和原声一起重做')).toBeVisible()
    pasteTextIntoComposer(requestBox(), '相邻两段光线保持一致')
    await waitFor(() => expect(generateButton()).toBeEnabled())
    await user.click(generateButton())
    await waitFor(() => expect(submitted).toBeDefined())
    expect(submitted).toMatchObject({
      source_job_id: ROOT_ID,
      range_start_ms: 2000,
      range_end_ms: 6000,
    })
    expect(referenceSamples).toEqual([
      { url: EDITED_URL, start: 0, end: 3 },
      { url: ROOT_URL, start: 4, end: 5 },
      { url: ROOT_URL, start: 5, end: 6 },
    ])
    await user.click(
      await within(versionStrip()).findByRole('button', { name: /^V1(?: · 新结果)?$/ }),
    )
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(5)
    expect(segmentOf(track, 3)).toHaveAccessibleName('第 3 段 · 2–7 秒')
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 9.0 秒')
    await user.click(versionButton('原片'))
    expect(segmentOf(track, 3)).toHaveAccessibleName('第 3 段 · 2–6 秒')
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent('共 8.0 秒')
  })

  it('合成使用各段最终选用的版本与顺序，没有采用的候选不进入请求', async () => {
    const first = editSegment({
      rangeStartMs: 1000,
      rangeEndMs: 2000,
      outputUrl: EDITED_URL,
      durationMs: 1500,
    })
    const second = editSegment({
      rangeStartMs: 4000,
      rangeEndMs: 5000,
      outputUrl: 'https://example.com/other-edit.mp4',
      durationMs: 800,
    })
    serveChain([first, second])
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.post('*/api/generations/video-composites', async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(
          {
            generation: makeGenerationJob({
              operation: 'compose',
              status: 'submitted',
              rootJobId: ROOT_ID,
              sourceJobId: ROOT_ID,
            }),
          },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.click(versionButton('V1'))
    await user.click(segmentOf(track, 5))
    await user.click(versionButton('V1'))
    await user.click(versionButton('原片'))
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(submitted).toBeDefined())
    expect(submitted).toMatchObject({
      baseJobId: ROOT_ID,
      segments: [
        { sourceJobId: ROOT_ID, start: 0, end: 1 },
        { sourceJobId: first.id, start: 0, end: 1.5 },
        ...[2, 3, 4, 5, 6, 7].map((start) => ({ sourceJobId: ROOT_ID, start, end: start + 1 })),
      ],
    })
    expect(JSON.stringify(submitted)).not.toContain(second.id)
  })
})

describe('刷新与切换页面后的编辑历史', () => {
  const V1_URL = 'https://example.com/v2.mp4'
  const COMPOSITE_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
  const EDIT_ON_COMPOSITE_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'

  /** V1：在原片上删掉一段拼成的 7 秒成片，服务端给齐合成记录的字段。 */
  const composite = (overrides: Parameters<typeof makeGenerationJob>[0] = {}) =>
    makeGenerationJob({
      id: COMPOSITE_ID,
      operation: 'compose',
      rootJobId: ROOT_ID,
      sourceJobId: ROOT_ID,
      shotIndex: 1,
      createdAt: '2026-09-16T10:05:00Z',
      finishedAt: '2026-09-16T10:06:00Z',
      outputUrl: V1_URL,
      durationMs: 7000,
      request: { segments: [] },
      ...overrides,
    })
  const runningComposite = () =>
    composite({ status: 'submitted', finishedAt: null, outputUrl: null, durationMs: null })

  /** 基于 V1 改 2–4 秒（V1 的第 3–4 段）的编辑段。 */
  const editOnComposite = (overrides: Parameters<typeof makeGenerationJob>[0] = {}) =>
    editSegment({
      id: EDIT_ON_COMPOSITE_ID,
      sourceJobId: COMPOSITE_ID,
      shotIndex: 1,
      createdAt: '2026-09-16T10:10:00Z',
      ...overrides,
    })

  /** 服务端上的记录：按真实接口口径筛 rootJobId、按创建时刻倒序、从 before 之后截 limit。 */
  let records: GenerationJob[] = []
  const serveRecords = (gate?: Promise<void>) =>
    server.use(
      http.get('*/api/generations', async ({ request }) => {
        await gate
        const params = new URL(request.url).searchParams
        const rootJobId = params.get('rootJobId')
        const before = params.get('before')
        const sorted = records
          .filter((job) => rootJobId === null || job.rootJobId === rootJobId)
          .toSorted(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
          )
        const from = before === null ? 0 : sorted.findIndex((job) => job.id === before) + 1
        const items = sorted.slice(from, from + Number(params.get('limit') ?? '50'))
        return HttpResponse.json({ items })
      }),
    )
  const serveComposeSubmit = () =>
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = runningComposite()
        records = [...records, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
  const finishComposite = () => {
    records = records.map((job) => (job.id === COMPOSITE_ID ? composite() : job))
  }

  const editorElement = () => (
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={() => {}}
      root={root}
      shotIndex={1}
    />
  )
  type View = Awaited<ReturnType<typeof renderEditor>>
  /** 刷新：新的 QueryClient（空缓存）、组件状态全丢，localStorage 留着。 */
  const refresh = async (view: View) => {
    view.unmount()
    return renderEditor()
  }
  /** 切换页面再回来：卸载再挂载，查询缓存留着。 */
  const switchAway = (view: View) => {
    view.rerender(null)
    view.rerender(editorElement())
  }

  const strip = () => screen.getByRole('group', { name: '视频版本' })
  const stripLabels = () =>
    within(strip())
      .getAllByRole('button')
      .map((entry) => entry.getAttribute('aria-label'))
  const pickedLabel = () =>
    within(strip())
      .getAllByRole('button')
      .find((entry) => entry.getAttribute('aria-pressed') === 'true')
      ?.getAttribute('aria-label')
  const segmentNames = (track: HTMLElement) =>
    within(track)
      .getAllByRole('button', { name: /^第 \d+ 段/ })
      .map((entry) => entry.getAttribute('aria-label'))
  /** 控制条上的总长与比原版长短（不含播放头时刻）。 */
  const readout = () =>
    screen.getByRole('group', { name: '播放控件' }).textContent.match(/共 [\d.]+ 秒/)?.[0]
  const stored = (versionJobId: string) =>
    window.localStorage.getItem(draftStorageKey(CONVERSATION, versionJobId))

  beforeEach(() => {
    // V1 7 秒，每秒一个关键帧。
    files.set(V1_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6], duration: 7 })
    records = []
  })

  it('合成完成后查看新整片，刷新与切换页面仍保留原基底上的剪辑选择', async () => {
    serveRecords()
    serveComposeSubmit()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(ROOT_ID)).toContain(COMPOSITE_ID))
    finishComposite()
    await act(() => view.queryClient.invalidateQueries())
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(segmentNames(track)).toHaveLength(7)
    await waitFor(() => expect(stored(ROOT_ID)).not.toContain(COMPOSITE_ID))
    expect(stored(ROOT_ID)).not.toBeNull()
    const saved = stored(ROOT_ID)

    const refreshed = await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(pickedLabel()).toBe('V1')
    expect(segmentNames(await timeline())).toHaveLength(7)
    expect(stored(ROOT_ID)).toBe(saved)
    switchAway(refreshed)
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(segmentNames(await timeline())).toHaveLength(7)
    expect(stored(ROOT_ID)).toBe(saved)
  })

  it('最新版上裁剪、删段、调序后刷新或切换页面，顺序、时长和基底都保留', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))
    await user.click(segmentOf(track, 3))
    const trimEnd = screen.getByRole('slider', { name: '裁剪该段结尾' })
    fireEvent.keyDown(trimEnd, { key: 'ArrowLeft' })
    fireEvent.keyDown(trimEnd, { key: 'ArrowLeft' })
    await user.click(segmentOf(track, 6))
    await user.keyboard('{Delete}')
    await user.click(segmentOf(track, 1))
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const names = segmentNames(track)
    const total = readout()
    expect(names).toHaveLength(6)
    await user.click(scopeButton('整片'))
    const refreshed = await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(segmentNames(await timeline())).toEqual(names)
    expect(readout()).toBe(total)
    expect(pickedLabel()).toBeUndefined()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '拆分' })).toBeDisabled()
    await user.click(scopeButton('片段'))
    expect(readout()).toBe(total)
    switchAway(refreshed)
    await waitFor(() =>
      expect(segmentNames(screen.getByRole('region', { name: '视频编辑时间线' }))).toEqual(names),
    )
  })

  it('用户选用的 AI 片段与删段一起保存，刷新后不会退回原片或改选其他候选', async () => {
    records = [composite(), editOnComposite({ outputUrl: EDITED_URL, durationMs: 2500 })]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(6))
    await user.click(segmentOf(track, 3))
    await user.click(versionButton('V1'))
    await user.click(segmentOf(track, 6))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).toContain(EDIT_ON_COMPOSITE_ID))
    const names = segmentNames(track)
    const total = readout()
    await refresh(view)
    const reopened = await timeline()
    expect(segmentNames(reopened)).toEqual(names)
    expect(readout()).toBe(total)
    expect(within(segmentOf(reopened, 3)).getByText('V1')).toBeVisible()
    expect(screen.queryByText(/剪辑选择读取失败/)).toBeNull()
  })

  it('生成期间刷新仍保留原片和其他剪辑；完成只新增候选，用户点击后才替换', async () => {
    records = [composite(), editOnComposite({ status: 'submitted' })]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 1))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const refreshed = await refresh(view)
    const reopened = await timeline()
    expect(segmentNames(reopened)).toHaveLength(5)
    await user.click(segmentOf(reopened, 2))
    expect(versionButton('V1')).toHaveAccessibleName(/生成中/)
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    records = records.map((job) =>
      job.id === EDIT_ON_COMPOSITE_ID
        ? editOnComposite({ outputUrl: EDITED_URL, durationMs: 2500 })
        : job,
    )
    await act(() => refreshed.queryClient.invalidateQueries())
    await waitFor(() => expect(versionButton('V1')).not.toHaveAccessibleName(/生成中/))
    expect(versionButton('原片')).toHaveAttribute('aria-pressed', 'true')
    expect(readout()).toContain('共 6.0 秒')
    await user.click(versionButton('V1'))
    expect(versionButton('V1')).toHaveAttribute('aria-pressed', 'true')
    expect(readout()).toContain('共 6.5 秒')
  })

  it.each([false, true])(
    '合成期间关闭，回来时已完成=%s：等待会落定，剪辑选择保留，整片可切回原片',
    async (finishBeforeReopen) => {
      serveRecords()
      serveComposeSubmit()
      const user = userEvent.setup()
      const view = await renderEditor()
      await user.click(segmentOf(await timeline(), 2))
      await user.keyboard('{Delete}')
      await user.click(screen.getByRole('button', { name: '合成成片' }))
      await waitFor(() => expect(stored(ROOT_ID)).toContain(COMPOSITE_ID))
      view.unmount()
      if (finishBeforeReopen) finishComposite()
      const reopened = await renderEditor()
      expect(segmentNames(await timeline())).toHaveLength(7)
      if (!finishBeforeReopen) {
        finishComposite()
        await act(() => reopened.queryClient.invalidateQueries())
      }
      await user.click(scopeButton('整片'))
      await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
      await waitFor(() => expect(stored(ROOT_ID)).not.toContain(COMPOSITE_ID))
      expect(stored(ROOT_ID)).not.toBeNull()
      await user.click(versionButton('原片'))
      expect(pickedLabel()).toBe('原片')
      expect(segmentNames(await timeline())).toHaveLength(8)
      expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
      await user.click(scopeButton('整片'))
      expect(segmentNames(await timeline())).toHaveLength(7)
    },
  )

  it('合成期间查看其他整片，关闭再回来：新整片仍可查看，当前剪辑不会被旧成片覆盖', async () => {
    const NEXT_ID = '4c5d6e7f-8091-4b2c-9d3e-4f5a6b7c8d9e'
    records = [composite()]
    serveRecords()
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = composite({
          id: NEXT_ID,
          sourceJobId: COMPOSITE_ID,
          status: 'submitted',
          outputUrl: null,
          finishedAt: null,
          createdAt: '2026-09-16T10:20:00Z',
        })
        records = [...records, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(COMPOSITE_ID)).toContain(NEXT_ID))
    await user.click(scopeButton('整片'))
    await user.click(versionButton('原片'))
    view.unmount()
    records = records.map((job) =>
      job.id === NEXT_ID
        ? {
            ...job,
            status: 'completed',
            finishedAt: '2026-09-16T10:21:00Z',
            outputUrl: 'https://example.com/v3.mp4',
          }
        : job,
    )
    files.set('https://example.com/v3.mp4', { keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })
    await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1', '原片']))
    expect(segmentNames(await timeline())).toHaveLength(6)
    expect(stored(COMPOSITE_ID)).not.toBeNull()
    await user.click(versionButton('原片'))
    expect(pickedLabel()).toBe('原片')
    expect(segmentNames(await timeline())).toHaveLength(8)
    await user.click(scopeButton('整片'))
    expect(segmentNames(await timeline())).toHaveLength(6)
  })

  it('查看原片时合成失败：说明失败原因，保留当前剪辑并可重新合成', async () => {
    const NEXT_ID = '3b4c5d6e-7f80-4a1b-8c2d-3e4f5a6b7c8d'
    records = [composite()]
    serveRecords()
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = composite({
          id: NEXT_ID,
          sourceJobId: COMPOSITE_ID,
          status: 'submitted',
          finishedAt: null,
          outputUrl: null,
          createdAt: '2026-09-16T10:20:00Z',
        })
        records = [...records, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(COMPOSITE_ID)).toContain(NEXT_ID))
    await user.click(scopeButton('整片'))
    await user.click(versionButton('原片'))
    records = records.map((job) =>
      job.id === NEXT_ID ? { ...job, status: 'failed', errorMessage: '素材下载失败' } : job,
    )
    await act(() => view.queryClient.invalidateQueries())
    expect(await screen.findByText(/合成失败：素材下载失败/)).toBeVisible()
    expect(pickedLabel()).toBe('原片')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toContain(NEXT_ID))
    expect(stored(COMPOSITE_ID)).not.toBeNull()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeDisabled()
    await user.click(scopeButton('整片'))
    expect(screen.getByRole('button', { name: '合成成片' })).toBeEnabled()
  })

  it('查看历史时播放器和时间线同步，刷新保留历史选择，返回整片仍是保存的剪辑', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    const names = segmentNames(track)
    await user.click(scopeButton('整片'))
    await user.click(versionButton('原片'))
    expect(segmentNames(track)).toHaveLength(8)
    expect(readout()).toBe('共 8.0 秒')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', ROOT_URL)
    expect(screen.getByRole('button', { name: '下载' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '拆分' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const saved = stored(COMPOSITE_ID)
    let releaseChain = () => {}
    serveRecords(new Promise<void>((resolve) => (releaseChain = resolve)))
    await refresh(view)
    expect(await screen.findByText('正在读取分段…')).toBeVisible()
    await act(async () => releaseChain())
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(pickedLabel()).toBe('原片')
    expect(segmentNames(await timeline())).toHaveLength(8)
    expect(stored(COMPOSITE_ID)).toBe(saved)
    await user.click(versionButton('V1'))
    expect(segmentNames(await timeline())).toHaveLength(7)
    expect(readout()).toBe('共 7.0 秒')
    expect(screen.getByLabelText('视频播放器')).toHaveAttribute('src', V1_URL)
    expect(stored(COMPOSITE_ID)).toBe(saved)
    await user.click(scopeButton('整片'))
    expect(segmentNames(await timeline())).toEqual(names)
    expect(pickedLabel()).toBeUndefined()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()
  })

  it.each([
    {
      name: '记着的那一版已不在',
      value: JSON.stringify({ jobId: 'gone', baseJobId: 'gone', view: 'whole' }),
    },
    { name: '记着的读不出来', value: '{"jobId":' },
  ])('$name：恢复最新版，已保存的片段选择照常显示', async ({ value }) => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    view.unmount()
    window.localStorage.setItem(viewStorageKey(CONVERSATION, ROOT_ID), value)
    await renderEditor()
    expect(segmentNames(await timeline())).toHaveLength(6)
    await user.click(scopeButton('整片'))
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
    expect(pickedLabel()).toBeUndefined()
  })

  it('链与关键帧分批到达时，不用原片分段装载或覆盖 V1 上保存的选择', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const names = segmentNames(await timeline())
    let releaseChain = () => {}
    serveRecords(new Promise<void>((resolve) => (releaseChain = resolve)))
    let releaseV1 = () => {}
    fileGates.set(V1_URL, new Promise<void>((resolve) => (releaseV1 = resolve)))
    await refresh(view)
    expect(await screen.findByText('正在读取分段…')).toBeVisible()
    await act(async () => releaseChain())
    expect(stored(COMPOSITE_ID)).not.toBeNull()
    await act(async () => releaseV1())
    await waitFor(() =>
      expect(segmentNames(screen.getByRole('region', { name: '视频编辑时间线' }))).toEqual(names),
    )
  })

  it('链上超过 100 条编辑记录，较早的合成仍出现在整片版本栏', async () => {
    records = [
      composite(),
      ...Array.from({ length: 100 }, (_, at) =>
        editOnComposite({
          id: crypto.randomUUID(),
          status: 'failed',
          errorMessage: '上游超时',
          createdAt: new Date(Date.parse('2026-09-16T11:00:00Z') + at * 1000).toISOString(),
        }),
      ),
    ]
    serveRecords()
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    await user.click(scopeButton('整片'))
    await waitFor(() => expect(stripLabels()).toEqual(['V1', '原片']))
  })

  it('超过 100 条记录时，已选用的早期 AI 结果仍可恢复，不会按较新失败结果重建', async () => {
    const used = editSegment({ outputUrl: EDITED_URL, durationMs: 2500 })
    records = [used]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 3))
    await user.click(versionButton('V1'))
    await user.click(segmentOf(track, 7))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(ROOT_ID)).toContain(used.id))
    const names = segmentNames(track)
    records = [
      used,
      ...Array.from({ length: 100 }, (_, at) =>
        editSegment({
          status: 'failed',
          errorMessage: '上游超时',
          createdAt: new Date(Date.parse('2026-09-16T11:00:00Z') + at * 1000).toISOString(),
        }),
      ),
    ]
    await refresh(view)
    expect(segmentNames(await timeline())).toEqual(names)
    expect(screen.queryByText(/剪辑选择读取失败/)).toBeNull()
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

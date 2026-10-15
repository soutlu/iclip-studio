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
import type { GenerationJob } from '../storyboard.api'
import { draftStorageKey } from './use-edit-draft'
import { viewStorageKey } from './use-picked-view'
import { VideoEditor } from './video-editor'

/** mediabunny 的替身：按地址给关键帧表与时长，都没有音轨；切参考片段时直接给几个字节。jsdom 读不了真文件。 */
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())
/** 按地址挡住读文件：放进一个没兑现的 Promise，读关键帧就停在那里，兑现了才读完。默认不挡。 */
const fileGates = vi.hoisted(() => new Map<string, Promise<void>>())

vi.mock('mediabunny', () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = null
  }
  class Mp4OutputFormat {}
  class Output {
    readonly target: BufferTarget
    constructor(options: { target: BufferTarget }) {
      this.target = options.target
    }
  }
  const Conversion = {
    init: ({ output }: { output: Output }) =>
      Promise.resolve({
        isValid: true,
        discardedTracks: [],
        execute: () => {
          output.target.buffer = new ArrayBuffer(8)
          return Promise.resolve()
        },
      }),
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
      return { url: this.url }
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
    Conversion,
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

const renderEditor = (job = root) =>
  renderWithProviders(
    <VideoEditor
      conversationId={CONVERSATION}
      loading={false}
      onClose={() => {}}
      root={job}
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
    server.use(http.get('*/api/generations/video-models', () => HttpResponse.json(models)))
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
      reason: '时长不足 1 秒，无法生成视频；请点击相邻的段一并选中',
    },
    {
      name: '拆过',
      keyframes: [0, 1, 2, 3, 4, 5, 6, 7],
      prepare: async (user: ReturnType<typeof userEvent.setup>) => {
        fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
          target: { value: '0.5' },
        })
        await user.click(screen.getByRole('button', { name: '拆分' }))
      },
      position: 1,
      reason: '含已剪辑的段，无法生成视频；请先点击「合成成片」',
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

  it('提交：参考图按出现的先后编成 @Image1、@Image2 与 reference_image_urls；成功后卡收走、要求清空', async () => {
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({ default: 'wan3.0-video', items: ['wan3.0-video'] }),
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
    await user.click(segmentOf(track, 3))
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
      prompt: '编辑视频，光线参考@Image1，构图参考@Image2',
    })
    await waitFor(() => expect(confirmedImages).toHaveLength(2))
    expect(submitted?.['reference_image_urls']).toEqual(confirmedImages)

    // 选中的两段换成锁定的占位，选区没了，卡也收走；点占位不弹卡。
    const running = await within(track).findByRole('img', { name: /AI 生成中/ })
    expect(card()).toBeNull()
    expect(screen.queryByRole('button', { name: /^展开第 \d/ })).toBeNull()
    await user.click(running)
    expect(card()).toBeNull()

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
    expect(screen.getByText(/正在查看 V1 原片/)).toBeVisible()
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

    expect(await screen.findByText('AI 修改失败：结果时长读取失败，已恢复原来的段')).toBeVisible()
    const track = await timeline()
    expect(within(track).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(8)
    expect(screen.queryByRole('group', { name: '视频版本' })).toBeNull()
  })

  it('存着的草稿读不出来：按服务端重建，并说一声', async () => {
    window.localStorage.setItem(draftStorageKey(CONVERSATION, ROOT_ID), '{"version":1')
    serveChain([])
    await renderEditor()

    expect(await screen.findByText('草稿读取失败，已根据 AI 生成结果重建')).toBeVisible()
    expect(window.localStorage.getItem(draftStorageKey(CONVERSATION, ROOT_ID))).toBeNull()
  })

  it('剪了就存进浏览器：删掉一段后重开，草稿还在', async () => {
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
    const reopened = await timeline()
    expect(within(reopened).getAllByRole('button', { name: /^第 \d 段/ })).toHaveLength(7)
    expect(screen.getByRole('group', { name: '播放控件' })).toHaveTextContent(
      '共 7.0 秒 · 比 V1 短 1.0 秒',
    )
  })
})

describe('刷新与切换页面后的编辑历史', () => {
  const V2_URL = 'https://example.com/v2.mp4'
  const COMPOSITE_ID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
  const EDIT_ON_V2_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'

  /** V2：在原片上删掉一段拼成的 7 秒成片，服务端给齐合成记录的字段。 */
  const composite = (overrides: Parameters<typeof makeGenerationJob>[0] = {}) =>
    makeGenerationJob({
      id: COMPOSITE_ID,
      operation: 'compose',
      rootJobId: ROOT_ID,
      sourceJobId: ROOT_ID,
      shotIndex: 1,
      createdAt: '2026-09-16T10:05:00Z',
      finishedAt: '2026-09-16T10:06:00Z',
      outputUrl: V2_URL,
      durationMs: 7000,
      request: { segments: [] },
      ...overrides,
    })
  const runningComposite = () =>
    composite({ status: 'submitted', finishedAt: null, outputUrl: null, durationMs: null })

  /** 基于 V2 改 2–4 秒（V2 的第 3–4 段）的编辑段。 */
  const editOnV2 = (overrides: Parameters<typeof makeGenerationJob>[0] = {}) =>
    editSegment({
      id: EDIT_ON_V2_ID,
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
    screen
      .getByRole('group', { name: '播放控件' })
      .textContent.match(/共 [\d.]+ 秒( · 比 V\d+ [短长] [\d.]+ 秒)?/)?.[0]
  const stored = (versionJobId: string) =>
    window.localStorage.getItem(draftStorageKey(CONVERSATION, versionJobId))

  beforeEach(() => {
    // V2 7 秒，每秒一个关键帧。
    files.set(V2_URL, { keyframes: [0, 1, 2, 3, 4, 5, 6], duration: 7 })
    records = []
  })

  it('情形 1：在 V1 上剪辑并合成出 V2 后刷新、再切换页面，版本条仍是 V2、V1，看的是新的 V2', async () => {
    serveRecords()
    serveComposeSubmit()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stripLabels()).toEqual(['未合成 · 合成中', 'V1']))

    finishComposite()
    await act(() => view.queryClient.invalidateQueries())
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    // 合成完成，基底那份草稿按设计清掉。
    await waitFor(() => expect(stored(ROOT_ID)).toBeNull())

    const refreshed = await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    expect(pickedLabel()).toBe('V2')
    expect(segmentNames(await timeline())).toHaveLength(7)

    switchAway(refreshed)
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    expect(pickedLabel()).toBe('V2')
  })

  it('情形 2：最新版上裁剪、删段、调序后刷新、切换页面，未合成草稿原样还在', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))

    // 裁剪第 3 段结尾两下，再删第 6 段，再把第 1 段往后挪一格。
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

    const refreshed = await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    expect(pickedLabel()).toBe('未合成')
    expect(segmentNames(await timeline())).toEqual(names)
    expect(readout()).toBe(total)

    switchAway(refreshed)
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    expect(segmentNames(await timeline())).toEqual(names)
  })

  it('情形 3：最新版上已完成的 AI 改段（未合成）加一次删段，刷新后两者都在，不提示重建', async () => {
    records = [composite(), editOnV2({ outputUrl: EDITED_URL, durationMs: 2500 })]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    // V2 的第 3–4 段换成 2.5 秒的 AI 结果：6 段。
    await waitFor(() => expect(segmentNames(track)).toHaveLength(6))
    await user.click(segmentOf(track, 6))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const names = segmentNames(track)
    const total = readout()

    await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    expect(segmentNames(await timeline())).toEqual(names)
    expect(readout()).toBe(total)
    expect(screen.queryByText(/草稿读取失败/)).toBeNull()
  })

  it('情形 4a：AI 改段还在跑时刷新，占位与其他剪辑都在；跑完后落成结果', async () => {
    records = [composite(), editOnV2({ status: 'submitted' })]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    expect(await within(track).findByRole('img', { name: /AI 生成中/ })).toBeVisible()
    await user.click(segmentOf(track, 1))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())

    const refreshed = await refresh(view)
    const reopened = await timeline()
    expect(await within(reopened).findByRole('img', { name: /AI 生成中/ })).toBeVisible()
    expect(segmentNames(reopened)).toHaveLength(4)
    expect(stripLabels()).toEqual(['未合成', 'V2', 'V1'])

    records = records.map((job) =>
      job.id === EDIT_ON_V2_ID ? editOnV2({ outputUrl: EDITED_URL, durationMs: 2500 }) : job,
    )
    await act(() => refreshed.queryClient.invalidateQueries())
    await waitFor(() =>
      expect(within(reopened).queryByRole('img', { name: /AI 生成中/ })).toBeNull(),
    )
    expect(segmentNames(reopened)).toHaveLength(5)
  })

  /** 情形 4b：合成跑着时刷新，草稿挂着「合成中」、剪辑都在；刷新后合成才完成，到 V2。 */
  const composeThenRefreshThenFinish = async () => {
    serveRecords()
    serveComposeSubmit()
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(ROOT_ID)).toContain(COMPOSITE_ID))

    const refreshed = await refresh(view)
    await waitFor(() => expect(stripLabels()).toEqual(['未合成 · 合成中', 'V1']))
    expect(segmentNames(await timeline())).toHaveLength(7)
    finishComposite()
    await act(() => refreshed.queryClient.invalidateQueries())
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    expect(pickedLabel()).toBe('V2')
    return user
  }

  it('情形 4b：刷新后合成才完成，基底 V1 那份草稿清掉（与不刷新时一样，见情形 1）', async () => {
    await composeThenRefreshThenFinish()

    await waitFor(() => expect(stored(ROOT_ID)).toBeNull())
  })

  it('合成期间关掉编辑器，回来时合成已完成：打开的是新的 V2，基底草稿清掉', async () => {
    serveRecords()
    serveComposeSubmit()
    const user = userEvent.setup()
    const view = await renderEditor()
    await user.click(segmentOf(await timeline(), 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(ROOT_ID)).toContain(COMPOSITE_ID))

    view.unmount()
    finishComposite()
    await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    await waitFor(() => expect(pickedLabel()).toBe('V2'))
    expect(stored(ROOT_ID)).toBeNull()
  })

  it('合成期间去看别的版本后关掉，回来再点那一版：停在它本身，不被带去新版本', async () => {
    const SECOND_ID = '4c5d6e7f-8091-4b2c-9d3e-4f5a6b7c8d9e'
    const second = (overrides: Parameters<typeof makeGenerationJob>[0]) =>
      composite({
        id: SECOND_ID,
        createdAt: '2026-09-16T10:20:00Z',
        finishedAt: null,
        ...overrides,
      })
    records = [composite()]
    serveRecords()
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = second({ status: 'submitted', outputUrl: null })
        records = [...records, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const view = await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    await user.click(within(strip()).getByRole('button', { name: 'V1' }))
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(8))
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(ROOT_ID)).toContain(SECOND_ID))
    await user.click(within(strip()).getByRole('button', { name: 'V2' }))

    view.unmount()
    records = records.map((job) =>
      job.id === SECOND_ID
        ? second({ finishedAt: '2026-09-16T10:21:00Z', outputUrl: 'https://example.com/v3.mp4' })
        : job,
    )
    files.set('https://example.com/v3.mp4', { keyframes: [0, 1, 2, 3, 4, 5, 6], duration: 7 })
    await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['V3', 'V2', 'V1']))
    expect(pickedLabel()).toBe('V2')

    await user.click(within(strip()).getByRole('button', { name: 'V1' }))
    await waitFor(() => expect(stored(ROOT_ID)).toBeNull())
    expect(pickedLabel()).toBe('V1')
  })

  it('不在看的那一版合成失败：提示说出是哪一版，那份草稿留着、不再等合成', async () => {
    const SECOND_ID = '3b4c5d6e-7f80-4a1b-8c2d-3e4f5a6b7c8d'
    const second = (overrides: Parameters<typeof makeGenerationJob>[0]) =>
      composite({ id: SECOND_ID, createdAt: '2026-09-16T10:20:00Z', ...overrides })
    records = [composite()]
    serveRecords()
    server.use(
      http.post('*/api/generations/video-composites', () => {
        const created = second({ status: 'submitted', finishedAt: null, outputUrl: null })
        records = [...records, created]
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const view = await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    await user.click(within(strip()).getByRole('button', { name: 'V1' }))
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(8))
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(stored(ROOT_ID)).toContain(SECOND_ID))

    // 合成跑着时去看 V2，之后那次合成失败。
    await user.click(within(strip()).getByRole('button', { name: 'V2' }))
    records = records.map((job) =>
      job.id === SECOND_ID
        ? second({ status: 'failed', outputUrl: null, errorMessage: '素材下载失败' })
        : job,
    )
    await act(() => view.queryClient.invalidateQueries())

    expect(await screen.findByText('V1 合成失败：素材下载失败')).toBeVisible()
    expect(pickedLabel()).toBe('V2')
    await waitFor(() => expect(stored(ROOT_ID)).not.toContain(SECOND_ID))
    expect(stored(ROOT_ID)).not.toBeNull()
  })

  it('情形 4b：刷新后合成才完成，再点 V1 停在 V1', async () => {
    const user = await composeThenRefreshThenFinish()

    await user.click(within(strip()).getByRole('button', { name: 'V1' }))
    expect(pickedLabel()).toBe('V1')
  })

  it('情形 5：已有 V2 时回到 V1 剪辑，刷新后仍在 V1 的「未合成」、剪辑都在；链读到前的暂态不动 V2 的草稿', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    // V2 上先删一段，留一份 V2 的草稿；再回到 V1 删一段。
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))
    await user.click(segmentOf(track, 7))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const v2Draft = stored(COMPOSITE_ID)
    await user.click(within(strip()).getByRole('button', { name: 'V1' }))
    await waitFor(() => expect(segmentNames(track)).toHaveLength(8))
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stripLabels()).toEqual(['V2', '未合成', 'V1']))
    await waitFor(() => expect(stored(ROOT_ID)).not.toBeNull())
    const names = segmentNames(track)

    // 刷新：链先挡着，这段时间版本里只有 V1。
    let releaseChain = () => {}
    serveRecords(new Promise<void>((resolve) => (releaseChain = resolve)))
    await refresh(view)
    expect(await screen.findByText('正在读取分段…')).toBeVisible()
    await act(async () => releaseChain())
    await waitFor(() => expect(stripLabels()).toEqual(['V2', '未合成', 'V1']))
    expect(pickedLabel()).toBe('未合成')
    expect(segmentNames(await timeline())).toEqual(names)
    expect(stored(COMPOSITE_ID)).toBe(v2Draft)

    await user.click(within(strip()).getByRole('button', { name: 'V2' }))
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    await user.click(within(strip()).getByRole('button', { name: '未合成' }))
    expect(segmentNames(await timeline())).toHaveLength(6)
  })

  it.each([
    { name: '记着的那一版已不在', value: JSON.stringify({ jobId: 'gone', view: 'version' }) },
    { name: '记着的读不出来', value: '{"jobId":' },
  ])('$name：看最新版，它的草稿照常显示', async ({ value }) => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())

    view.unmount()
    window.localStorage.setItem(viewStorageKey(CONVERSATION, ROOT_ID), value)
    await renderEditor()
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    expect(pickedLabel()).toBe('未合成')
    expect(segmentNames(await timeline())).toHaveLength(6)
  })

  it('情形 7：刷新后链比 V1 关键帧先到、V2 关键帧最后到，不用 V1 的分段装载，也不误删 V2 草稿', async () => {
    records = [composite()]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))
    await user.click(segmentOf(track, 2))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(COMPOSITE_ID)).not.toBeNull())
    const names = segmentNames(track)

    // 刷新：先挡住链与 V2 的关键帧，V1 的关键帧先读完。
    let releaseChain = () => {}
    serveRecords(new Promise<void>((resolve) => (releaseChain = resolve)))
    let releaseV2 = () => {}
    fileGates.set(V2_URL, new Promise<void>((resolve) => (releaseV2 = resolve)))
    await refresh(view)
    expect(await screen.findByText('正在读取分段…')).toBeVisible()
    await act(async () => releaseChain())
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
    expect(stored(COMPOSITE_ID)).not.toBeNull()

    await act(async () => releaseV2())
    await waitFor(() => expect(stripLabels()).toEqual(['未合成', 'V2', 'V1']))
    expect(segmentNames(await timeline())).toEqual(names)
  })

  it('链上记录超过 100 条：更早的合成被挤出那一页，刷新后 V2 仍应在版本条上', async () => {
    // V2 之后又在 V2 上提交了 100 次 AI 改段（失败的也占名额）。
    const laterEdits = Array.from({ length: 100 }, (_, at) =>
      editOnV2({
        id: crypto.randomUUID(),
        status: 'failed',
        errorMessage: '上游超时',
        createdAt: new Date(Date.parse('2026-09-16T11:00:00Z') + at * 1000).toISOString(),
      }),
    )
    records = [composite(), ...laterEdits]
    serveRecords()
    await renderEditor()

    await timeline()
    await waitFor(() => expect(stripLabels()).toEqual(['V2', 'V1']))
  })

  it('链上记录超过 100 条：草稿里用着的那条 AI 结果被挤出那一页，刷新后草稿应原样还在、不被重建', async () => {
    const used = editSegment({ outputUrl: EDITED_URL, durationMs: 2500 })
    records = [used]
    serveRecords()
    const user = userEvent.setup()
    const view = await renderEditor()
    const track = await timeline()
    // V1 第 3–4 段换成 AI 结果后共 7 段，再删最后一段。
    await waitFor(() => expect(segmentNames(track)).toHaveLength(7))
    await user.click(segmentOf(track, 7))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(stored(ROOT_ID)).not.toBeNull())
    const names = segmentNames(track)

    // 之后又在 V1 上提交了 100 次都失败的 AI 改段。
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
    const reopened = await timeline()
    await waitFor(() => expect(segmentNames(reopened)).toEqual(names))
    expect(screen.queryByText(/草稿读取失败/)).toBeNull()
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

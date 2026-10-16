import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guess } from 'web-audio-beat-detector'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { seedMockFilm } from '@/testing/mocks/film'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { stubWebAudio } from '@/testing/web-audio'
import type { ConversationTask } from '@/shared/workbench'
import { storyboardQueryKeys, type GenerationJob } from '../storyboard.api'
import { filmDraftStorageKey } from './use-film-draft'
import { WholeFilmEditor } from './whole-film-editor'

/** 拍点检测在 Web Worker 里跑，jsdom 没有：替身按用例给拍子。 */
vi.mock('web-audio-beat-detector', () => ({ guess: vi.fn() }))

const mediaFiles = vi.hoisted(
  () => new Map<string, { keyframes: number[]; duration: number; fail?: boolean }>(),
)

/** jsdom 不读取真实视频；仅替代媒体索引读取，组件和分段逻辑保持真实。 */
vi.mock('mediabunny', () => {
  class UrlSource {
    readonly url: string
    constructor(url: string) {
      this.url = url
    }
  }
  class Input {
    readonly url: string
    constructor({ source }: { source: UrlSource }) {
      this.url = source.url
    }
    getPrimaryVideoTrack = async () => {
      if (mediaFiles.get(this.url)?.fail) throw new Error('媒体索引读取失败')
      return { url: this.url }
    }
    computeDuration = async () => mediaFiles.get(this.url)?.duration ?? 4
    getPrimaryAudioTrack = () => Promise.resolve(null)
    dispose = () => {}
  }
  return {
    AudioSampleSink: class {},
    BufferTarget: class {},
    Conversion: {},
    EncodedPacketSink: class {
      readonly frames: number[]
      constructor(track: { url: string }) {
        this.frames = mediaFiles.get(track.url)?.keyframes ?? [0]
      }
      getFirstKeyPacket = async () =>
        this.frames[0] === undefined ? null : { timestamp: this.frames[0] }
      getNextKeyPacket = async (packet: { timestamp: number }) => {
        const next = this.frames[this.frames.indexOf(packet.timestamp) + 1]
        return next === undefined ? null : { timestamp: next }
      }
    },
    Input,
    Mp4OutputFormat: class {},
    Output: class {},
    UrlSource,
    MP4: {},
    QTFF: {},
  }
})

const CONVERSATION = 'conversation-1'
const TAKE_1 = '11111111-1111-4111-8111-111111111111'
const COMPOSITE_1 = '22222222-2222-4222-8222-222222222222'
const TAKE_2 = '33333333-3333-4333-8333-333333333333'
const LOOSE = '44444444-4444-4444-8444-444444444444'
const TASK = '55555555-5555-4555-8555-555555555555'

/** 一条成片：4 秒、完成时刻依次往后。 */
const video = (id: string, overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({
    id,
    outputUrl: `https://example.com/${id}.mp4`,
    durationMs: 4000,
    taskId: TASK,
    ...overrides,
  })

const VIDEOS = [
  video(TAKE_1, { shotIndex: 1, finishedAt: '2026-09-01T10:00:00Z' }),
  // 镜头组 1 的 V2：基于 V1 的合成。
  video(COMPOSITE_1, {
    shotIndex: 1,
    operation: 'compose',
    rootJobId: TAKE_1,
    sourceJobId: TAKE_1,
    finishedAt: '2026-09-01T11:00:00Z',
  }),
  video(TAKE_2, { shotIndex: 2, finishedAt: '2026-09-01T10:30:00Z' }),
  // 没有镜号的出片自成一组。
  video(LOOSE, { finishedAt: '2026-09-01T12:00:00Z' }),
]

const subtitle = (sourceJobId: string, overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({ kind: 'subtitle', sourceJobId, ...overrides })

/** 本对话的记录：视频、字幕记录与生成的音乐按 `kind` 分开答。 */
const serve = (videos: GenerationJob[], subtitles: GenerationJob[], music: GenerationJob[] = []) =>
  server.use(
    http.get('*/api/brand-templates', () => HttpResponse.json({ items: [] })),
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({
        items: kind === 'subtitle' ? subtitles : kind === 'audio' ? music : videos,
      })
    }),
  )

/** 对话此刻挂的需求单：与成片记录上的不是同一张（对话后来换了单），提交时要用它。 */
const CONVERSATION_TASK = '66666666-6666-4666-8666-666666666666'

const READY_TASK: ConversationTask = { kind: 'ready', taskId: CONVERSATION_TASK }

/** 打开编辑器；`task` 默认是读到了对话此刻的需求单。 */
const renderEditor = ({ task }: { task: ConversationTask } = { task: READY_TASK }) =>
  renderWithProviders(
    <WholeFilmEditor conversationId={CONVERSATION} onClose={() => {}} task={task} />,
  )

/** 「合成成片」现在不能点的原因：灰着，悬停亮出原因。 */
const composeBlockedBy = async (user: ReturnType<typeof userEvent.setup>) => {
  const compose = screen.getByRole('button', { name: '合成成片' })
  expect(compose).toHaveAttribute('aria-disabled', 'true')
  await user.hover(compose)
  return (await screen.findByRole('tooltip')).textContent
}

const timeline = () => screen.findByRole('region', { name: '整片时间线' })
const filmSegments = () => screen.queryAllByRole('button', { name: /^第 \d+ 段/ })

/** 从素材区末尾的「添加镜头组」选一版放进素材区。 */
const addMaterial = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await screen.findByRole('button', { name: '添加镜头组' }))
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) }))
  await waitFor(() => expect(screen.queryByText('正在读取镜头分段…')).toBeNull())
}

const lane = (name: string, index = 1) =>
  screen.getByRole('button', { name: new RegExp(`^${name} 镜头 ${index}，`) })

/** jsdom 没有布局与指针捕获：时间线 200px 宽，成片轨在 22–70px。 */
const stubLayout = () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  for (const group of screen.queryAllByRole('group', { name: / 素材$/ })) {
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(rect(0, 140, 200, 64))
    if (group.parentElement !== null)
      vi.spyOn(group.parentElement, 'getBoundingClientRect').mockReturnValue(rect(0, 140, 200, 64))
  }
  vi.spyOn(screen.getByTestId('film-lanes'), 'getBoundingClientRect').mockReturnValue(
    rect(0, 0, 200, 300),
  )
  vi.spyOn(screen.getByTestId('film-lane'), 'getBoundingClientRect').mockReturnValue(
    rect(0, 22, 200, 48),
  )
  vi.spyOn(
    screen.getByRole('region', { name: '时间线轨道，窄屏可横向滚动' }),
    'getBoundingClientRect',
  ).mockReturnValue(rect(0, 0, 200, 70))
}

beforeEach(() => {
  window.localStorage.clear()
  mediaFiles.clear()
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WholeFilmEditor', () => {
  it('合成提交最终字幕与各段，受理后显示合成中，完成后可预览与下载并按整片记账', async () => {
    seedFilm()
    const videos = [...VIDEOS]
    serve(videos, [
      subtitle(TAKE_1, {
        sentences: [{ startMs: 200, endMs: 800, text: '你好', speaker: 0 }],
      }),
    ])
    const filmId = '88888888-8888-4888-8888-888888888888'
    const filmUrl = 'https://example.com/whole-film.mp4'
    let body: unknown
    const tracked: unknown[] = []
    server.use(
      http.post('*/api/generations/whole-films', async ({ request }) => {
        body = await request.json()
        const created = video(filmId, {
          operation: 'compose',
          status: 'submitted',
          outputUrl: null,
          durationMs: null,
        })
        videos.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
      http.post('*/api/tracking/events', async ({ request }) => {
        tracked.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(filmUrl, () => HttpResponse.arrayBuffer(new ArrayBuffer(8))),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createUrl = vi.fn(() => 'blob:whole-film')
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createUrl
        static override revokeObjectURL = vi.fn()
      },
    )
    try {
      const user = userEvent.setup()
      const { queryClient } = await renderEditor()
      await timeline()
      const compose = screen.getByRole('button', { name: '合成成片' })
      await waitFor(() => expect(compose).not.toHaveAttribute('aria-disabled'))
      await user.click(compose)
      await waitFor(() =>
        expect(body).toEqual({
          conversationId: CONVERSATION,
          taskId: CONVERSATION_TASK,
          segments: [
            { sourceJobId: TAKE_1, startMs: 0, endMs: 1000, volume: 1 },
            { sourceJobId: TAKE_1, startMs: 1500, endMs: 3000, volume: 1 },
            { sourceJobId: TAKE_1, startMs: 500, endMs: 2000, volume: 1 },
          ],
          subtitles: [
            { startMs: 200, endMs: 800, text: '你好' },
            { startMs: 2500, endMs: 2800, text: '你好' },
          ],
        }),
      )
      expect(await screen.findByRole('button', { name: '整片合成中' })).toBeVisible()
      Object.assign(videos.at(-1) ?? {}, {
        status: 'completed',
        outputUrl: filmUrl,
        durationMs: 4000,
        finishedAt: '2026-10-14T10:00:00Z',
      })
      await act(() =>
        queryClient.invalidateQueries({ queryKey: storyboardQueryKeys.conversation(CONVERSATION) }),
      )
      await user.click(await screen.findByRole('button', { name: '整片 V1' }))
      expect(screen.getByLabelText('视频预览').querySelector('video')).toHaveAttribute(
        'src',
        filmUrl,
      )
      await user.click(screen.getByRole('button', { name: '下载视频' }))
      await waitFor(() => expect(tracked).toEqual([{ name: 'video.downloaded', jobId: filmId }]))
      await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('提交失败保留剪辑并允许重试，异步合成失败显示失败版本', async () => {
    seedFilm()
    const videos = [...VIDEOS]
    serve(videos, [])
    let attempts = 0
    const filmId = '88888888-8888-4888-8888-888888888888'
    server.use(
      http.post('*/api/generations/whole-films', () => {
        attempts += 1
        if (attempts === 1)
          return HttpResponse.json({ detail: '暂时无法提交，请重试' }, { status: 503 })
        const created = video(filmId, {
          operation: 'compose',
          status: 'submitted',
          outputUrl: null,
        })
        videos.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const { queryClient } = await renderEditor()
    await timeline()
    const compose = screen.getByRole('button', { name: '合成成片' })
    await waitFor(() => expect(compose).not.toHaveAttribute('aria-disabled'))
    await user.click(compose)
    expect(await screen.findByText('整片合成提交失败：暂时无法提交，请重试')).toBeVisible()
    expect(filmSegments()).toHaveLength(3)
    await user.click(compose)
    expect(await screen.findByRole('button', { name: '整片合成中' })).toBeVisible()
    Object.assign(videos.at(-1) ?? {}, {
      status: 'failed',
      errorMessage: 'internal ffmpeg debug output',
      finishedAt: '2026-10-14T10:00:00Z',
    })
    await act(() =>
      queryClient.invalidateQueries({ queryKey: storyboardQueryKeys.conversation(CONVERSATION) }),
    )
    await user.click(await screen.findByRole('button', { name: '整片合成失败' }))
    expect(screen.queryByText('internal ffmpeg debug output')).toBeNull()
    expect(screen.getByRole('button', { name: '下载' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '未合成的整片' }))
    expect(filmSegments()).toHaveLength(3)
    expect(attempts).toBe(2)
  })

  it('没有本地草稿时恢复最新整片，保留清空字幕的结果并能再次提交', async () => {
    const restored = video('88888888-8888-4888-8888-888888888888', {
      operation: 'compose',
      finishedAt: '2026-10-14T10:00:00Z',
      request: {
        segments: [{ sourceJobId: TAKE_1, startMs: 0, endMs: 4000 }],
        subtitles: [],
        music: null,
      },
    })
    serve(
      [...VIDEOS, restored],
      [
        subtitle(TAKE_1, {
          sentences: [{ startMs: 0, endMs: 2000, text: '这句已被清空', speaker: 0 }],
        }),
      ],
    )
    let body: unknown
    server.use(
      http.post('*/api/generations/whole-films', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ generation: restored }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    expect(await screen.findByText('已按 V1 恢复剪辑')).toBeVisible()
    expect(filmSegments()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '合成成片' }))
    await waitFor(() => expect(body).toMatchObject({ subtitles: [] }))
  })

  it('本地剪辑优先于已完成的版本；无法解析版本请求时明确提示并从空白开始', async () => {
    seedFilm()
    const completed = video('88888888-8888-4888-8888-888888888888', {
      operation: 'compose',
      finishedAt: '2026-10-14T10:00:00Z',
      request: {},
    })
    serve([...VIDEOS, completed], [])
    const first = await renderEditor()
    await timeline()
    expect(filmSegments()).toHaveLength(3)
    expect(screen.queryByText('V1 的剪辑读取失败，已从空白开始')).toBeNull()
    first.unmount()
    window.localStorage.removeItem(filmDraftStorageKey(CONVERSATION))
    await renderEditor()
    expect(await screen.findByText('V1 的剪辑读取失败，已从空白开始')).toBeVisible()
    expect(filmSegments()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '整片 V1' })).toBeVisible()
  })

  it('开局为空：成片轨是占位，素材区末尾常驻「添加镜头组」；选成片面板按版本组列出各版', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()

    const track = await timeline()
    expect(within(track).getByText('从下方素材轨选择镜头加入成片')).toBeVisible()
    expect(screen.getByText('成片轨还是空的')).toBeVisible()
    expect(await composeBlockedBy(user)).toBe('成片轨为空，无法合成；请先从素材轨挑段放入成片轨')

    await user.click(screen.getByRole('button', { name: '添加镜头组' }))
    const tiles = (await screen.findAllByRole('menuitem')).map((item) =>
      item.getAttribute('aria-label'),
    )
    expect(tiles).toEqual([
      '镜头组 1 生成 A 编辑版 1，4.0 秒',
      '镜头组 1 生成 A 原版，4.0 秒',
      '镜头组 2 生成 A 原版，4.0 秒',
      '视频 1 生成 A 原版，4.0 秒',
    ])

    await user.click(screen.getByRole('menuitem', { name: /^镜头组 1 生成 A 编辑版 1/ }))
    expect(
      await screen.findByRole('button', { name: /^镜头组 1 · 生成 A · 编辑版 1 镜头 1/ }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: '添加镜头组' })).toBeVisible()
  })

  it('键盘：回车选中整条素材，调整结尾后回车插入到播放头处，后面的段接着排', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 生成 A 原版')

    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('slider', { name: '选区结尾' })).toHaveAttribute('aria-valuenow', '4')
    await user.keyboard('{Enter}')
    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 2 · 生成 A · 原版 · 0–4 秒',
    ])

    // 选区结尾往前收 1 秒（Shift 一步一秒），再插一次：播放头已在第 1 段结尾，排在它后面。
    screen.getByRole('slider', { name: '选区结尾' }).focus()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
        '第 1 段 · 镜头组 2 · 生成 A · 原版 · 0–4 秒',
        '第 2 段 · 镜头组 2 · 生成 A · 原版 · 4–7 秒',
      ]),
    )
    expect(screen.getByText('7.0')).toBeVisible()
  })

  it('指针：点击关键帧镜头，拖到成片轨后插入对应区间', async () => {
    mediaFiles.set(`https://example.com/${TAKE_1}.mp4`, { keyframes: [0, 1, 3], duration: 4 })
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 生成 A 原版')
    stubLayout()
    const material = lane('镜头组 1 · 生成 A · 原版', 2)
    await user.click(material)
    expect(screen.getByRole('slider', { name: '选区开头' })).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('slider', { name: '选区结尾' })).toHaveAttribute('aria-valuenow', '3')

    // 按住选区拖到成片轨上：出现插入点与提示，松手插入。
    fireEvent.pointerDown(material, { pointerId: 2, button: 0, clientX: 100, clientY: 150 })
    fireEvent.pointerMove(material, { pointerId: 2, clientX: 20, clientY: 40 })
    expect(screen.getByText('插入到 0.00 秒')).toBeVisible()
    fireEvent.pointerUp(material, { pointerId: 2, clientX: 20, clientY: 40 })

    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 1 · 生成 A · 原版 · 0–2 秒',
    ])
  })

  it('放不下时不插入，说出还差多少', async () => {
    serve(VIDEOS, [])
    window.localStorage.setItem(
      filmDraftStorageKey(CONVERSATION),
      JSON.stringify({
        version: 1,
        segments: Array.from({ length: 30 }, (_, at) => ({
          id: `s${at}`,
          sourceJobId: TAKE_2,
          start: 0,
          end: 3.9,
          origin: [0, 3.9],
        })),
        texts: {},
        manual: [],
        lanes: [{ groupId: 'shot-2', jobId: TAKE_2 }],
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await timeline()

    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(filmSegments()).toHaveLength(30)
    expect(
      screen.getByText(/已有 117\.0 秒，放不下这 4\.0 秒；请先删减成片轨上的段$/),
    ).toBeVisible()
  })

  it('换版本只影响之后挑的段，已在成片轨上的段不变', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 生成 A 编辑版 1')
    lane('镜头组 1 · 生成 A · 编辑版 1').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(
      screen.getByRole('button', { name: '镜头组 1 生成 A 当前用 编辑版 1，换版本' }),
    )
    await user.click(await screen.findByRole('menuitemradio', { name: /原版/ }))
    lane('镜头组 1 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 1 · 生成 A · 编辑版 1 · 0–4 秒',
      '第 2 段 · 镜头组 1 · 生成 A · 原版 · 4–8 秒',
    ])
  })

  it('字幕仅来自自动识别，没有手动新增入口；可改字保存草稿并撤销', async () => {
    serve(VIDEOS, [
      subtitle(TAKE_2, {
        sentences: [{ startMs: 500, endMs: 2500, text: '今天带来一款新耳机', speaker: 0 }],
      }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    expect(screen.queryByRole('button', { name: '在播放头处添加字幕' })).toBeNull()
    await addMaterial(user, '镜头组 2 生成 A 原版')
    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(await screen.findByRole('button', { name: '第 1 条字幕：今天带来一款新耳机' }))
    expect(screen.queryByRole('button', { name: '在播放头处添加字幕' })).toBeNull()
    const card = screen.getByRole('region', { name: '选中的字幕' })
    expect(within(card).getByText('来自镜头组 2 · 生成 A · 原版 的口播')).toBeVisible()
    const box = within(card).getByRole('textbox', { name: '字幕文字' })
    await user.clear(box)
    await user.type(box, '新耳机来了')

    expect(screen.getByRole('button', { name: '第 1 条字幕：新耳机来了' })).toBeVisible()
    await waitFor(() =>
      expect(window.localStorage.getItem(filmDraftStorageKey(CONVERSATION))).toContain(
        '新耳机来了',
      ),
    )

    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByRole('button', { name: '第 1 条字幕：今天带来一款新耳机' })).toBeVisible()
  })

  it('没有字幕记录的段标「未识别 · 识别」，点了带本对话与它此刻的需求单提交识别，随后显示「识别中」', async () => {
    let body: unknown
    // 受理后列表里就有这条在识别的记录。
    const subtitles: GenerationJob[] = []
    serve(VIDEOS, subtitles)
    server.use(
      http.post('*/api/generations/subtitles', async ({ request }) => {
        body = await request.json()
        const created = subtitle(TAKE_2, { status: 'pending' })
        subtitles.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 生成 A 原版')
    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(
      await screen.findByRole('button', { name: '镜头组 2 · 生成 A · 原版 字幕未识别，识别' }),
    )

    await waitFor(() =>
      expect(body).toEqual({
        conversationId: CONVERSATION,
        sourceJobId: TAKE_2,
        taskId: CONVERSATION_TASK,
      }),
    )
    expect(await screen.findByText('识别中')).toBeVisible()
  })

  it('对话的需求单还没读到时不提交识别，说明原因', async () => {
    const submitted = vi.fn()
    serve(VIDEOS, [])
    server.use(http.post('*/api/generations/subtitles', submitted))
    const user = userEvent.setup()
    await renderEditor({ task: { kind: 'loading' } })
    await addMaterial(user, '镜头组 2 生成 A 原版')
    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(
      await screen.findByRole('button', { name: '镜头组 2 · 生成 A · 原版 字幕未识别，识别' }),
    )

    expect(screen.getByText('任务信息读取中，暂时无法提交')).toBeVisible()
    expect(submitted).not.toHaveBeenCalled()
    expect(await composeBlockedBy(user)).toBe('任务信息读取中，暂时无法合成')
  })

  it('对话的需求单读取失败：写明原因并给重试，合成说明要先重试', async () => {
    serve(VIDEOS, [])
    const retry = vi.fn()
    const user = userEvent.setup()
    await renderEditor({ task: { kind: 'failed', retry } })
    await addMaterial(user, '镜头组 2 生成 A 原版')
    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(screen.getByText('任务信息读取失败，识别字幕、生成音乐与合成暂时无法提交')).toBeVisible()
    expect(await composeBlockedBy(user)).toBe('任务信息读取失败，无法合成；请点击「重试」')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('识别失败标「识别失败 · 重试」；没有口播什么也不标', async () => {
    serve(VIDEOS, [subtitle(TAKE_1, { status: 'failed' }), subtitle(TAKE_2, { sentences: [] })])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 生成 A 原版')
    lane('镜头组 1 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')
    await addMaterialWithKeyboard(user, '镜头组 2 生成 A 原版')
    lane('镜头组 2 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(
      await screen.findByRole('button', { name: '镜头组 1 · 生成 A · 原版 字幕识别失败，重试' }),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: /镜头组 2 · 生成 A · 原版 字幕/ })).toBeNull()
    expect(screen.queryByText('识别中')).toBeNull()
  })

  it('关键帧读取失败时不伪造分段，重试后可以选镜头', async () => {
    const url = `https://example.com/${LOOSE}.mp4`
    mediaFiles.set(url, { keyframes: [0, 1, 3], duration: 4, fail: true })
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '视频 1 生成 A 原版')
    const group = screen.getByRole('group', { name: '视频 1 · 生成 A · 原版 素材' })
    expect(within(group).getByRole('alert')).toHaveTextContent('镜头分段读取失败')
    expect(within(group).queryByRole('button', { name: /镜头/ })).toBeNull()
    mediaFiles.set(url, { keyframes: [0, 1, 3], duration: 4 })
    await user.click(within(group).getByRole('button', { name: '重试' }))
    expect(await within(group).findByRole('button', { name: /镜头 2，1.0–3.0 秒/ })).toBeVisible()
  })
})

/** 素材区已有轨时仍可从末尾入口添加：方向键移到那一格，回车。 */
const addMaterialWithKeyboard = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  screen.getByRole('button', { name: '添加镜头组' }).focus()
  await user.keyboard('{Enter}')
  await user.keyboard('{Home}')
  await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })
  for (let step = 0; step < 10; step += 1) {
    if (document.activeElement?.getAttribute('aria-label')?.startsWith(name) === true) break
    await user.keyboard('{ArrowDown}')
  }
  await user.keyboard('{Enter}')
}

// ---------- 音乐 ----------

const MUSIC_JOB = '77777777-7777-4777-8777-777777777777'
const MUSIC_URL = 'https://example.com/music.m4a'

/** 成片轨三段都取自镜头组 1 的 V1：0–1、1.5–3、0.5–2，共 4 秒，切点在 1.0 与 2.5 秒。 */
const seedFilm = (music?: Record<string, unknown>) =>
  window.localStorage.setItem(
    filmDraftStorageKey(CONVERSATION),
    JSON.stringify({
      version: 1,
      segments: [
        { id: 's1', sourceJobId: TAKE_1, start: 0, end: 1, origin: [0, 1] },
        { id: 's2', sourceJobId: TAKE_1, start: 1.5, end: 3, origin: [1.5, 3] },
        { id: 's3', sourceJobId: TAKE_1, start: 0.5, end: 2, origin: [0.5, 2] },
      ],
      texts: {},
      manual: [],
      lanes: [],
      ...(music === undefined ? {} : { music }),
    }),
  )

const UPLOADED = {
  kind: 'upload',
  jobId: MUSIC_JOB,
  name: '夏日节拍.mp3',
  url: MUSIC_URL,
  userStart: null,
}

describe('素材区预览与整片播放头', () => {
  afterEach(() => vi.unstubAllGlobals())

  const media = () => screen.getByLabelText<HTMLVideoElement>('视频播放器')
  const preparePlayback = () => {
    const audio = stubWebAudio({ duration: 20 })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((frame) => frames.delete(frame))
    return {
      audio,
      tick: () =>
        act(() => {
          const pending = [...frames]
          frames.clear()
          for (const [, callback] of pending) callback(0)
        }),
    }
  }

  it('成片第一段可向前后扩展，拖动时始终预览该来源而非邻段', async () => {
    preparePlayback()
    serve(VIDEOS, [])
    window.localStorage.setItem(
      filmDraftStorageKey(CONVERSATION),
      JSON.stringify({
        version: 2,
        segments: [
          { id: 'first', sourceJobId: TAKE_1, start: 2, end: 3 },
          { id: 'next', sourceJobId: TAKE_2, start: 0, end: 1 },
        ],
        texts: {},
        manual: [],
        lanes: [],
        music: null,
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    stubLayout()
    await user.click(screen.getByRole('button', { name: /^第 1 段/ }))
    const start = screen.getByRole('slider', { name: '裁剪该段开头' })
    fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: -4 })
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_1}.mp4`)
    expect(media().currentTime).toBeCloseTo(1.6)
    fireEvent.pointerUp(start, { pointerId: 1, clientX: -4 })
    const end = screen.getByRole('slider', { name: '裁剪该段结尾' })
    fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 14 })
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 18 })
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_1}.mp4`)
    expect(media().currentTime).toBeCloseTo(3.399)
    fireEvent.pointerUp(end, { pointerId: 2, clientX: 18 })
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(filmDraftStorageKey(CONVERSATION)) ?? '{}',
    )
    expect(saved).toMatchObject({
      segments: [
        { id: 'first', sourceJobId: TAKE_1, start: 1.6, end: 3.4 },
        { id: 'next', sourceJobId: TAKE_2, start: 0, end: 1 },
      ],
    })
  })

  it('选择关键帧镜头和改边界时背景保持首帧，前景仍显示准确边界', async () => {
    preparePlayback()
    const url = 'https://fixture.oss-cn-hangzhou.aliyuncs.com/material.mp4'
    mediaFiles.set(url, { keyframes: [0, 1, 3.5], duration: 4 })
    serve(
      VIDEOS.map((item) => (item.id === TAKE_2 ? { ...item, outputUrl: url } : item)),
      [],
    )
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 生成 A 原版')
    stubLayout()
    fireEvent.loadedMetadata(media())
    const stage = screen.getByRole('region', { name: '预览舞台' })
    const image = stage.querySelector('img')
    if (image === null) throw new Error('OSS素材应提供舞台背景')
    const firstFrame = `${url}?x-oss-process=video/snapshot,t_0,f_jpg,w_320,h_0,m_fast`
    expect(image.src).toBe(firstFrame)
    fireEvent.load(image)
    await user.click(lane('镜头组 2 · 生成 A · 原版', 2))
    expect([...stage.querySelectorAll('img')].map((item) => item.src)).toEqual([firstFrame])
    expect(image).toBeVisible()
    expect(media().currentTime).toBe(1)
    screen.getByRole('slider', { name: '选区开头' }).focus()
    await user.keyboard('{ArrowRight}')
    expect([...stage.querySelectorAll('img')].map((item) => item.src)).toEqual([firstFrame])
    expect(stage.querySelector('img')).toBe(image)
    expect(media().currentTime).toBe(1.1)
  })

  it('调整镜头边界时即时预览，播放限定选区，整片字幕、混音与播放头保持独立', async () => {
    mediaFiles.set(`https://example.com/${TAKE_2}.mp4`, { keyframes: [0, 1, 2], duration: 4 })
    const { audio, tick } = preparePlayback()
    seedFilm(UPLOADED)
    vi.mocked(guess).mockResolvedValue({ bpm: 120, offset: 0 })
    server.use(http.get(MUSIC_URL, () => HttpResponse.arrayBuffer(new ArrayBuffer(8))))
    serve(VIDEOS, [
      subtitle(TAKE_1, { sentences: [{ startMs: 0, endMs: 4000, text: '整片口播', speaker: 0 }] }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    await addMaterial(user, '镜头组 2 生成 A 原版')
    stubLayout()
    const filmClock = screen.getByRole('slider', { name: '时间线播放位置' })
    fireEvent.change(filmClock, { target: { value: '1.75' } })
    fireEvent.loadedMetadata(media())
    expect(within(screen.getByLabelText('视频预览')).getByText('整片口播')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: '播放' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '播放' }))
    await waitFor(() => expect(audio.played).toHaveLength(1))
    const before = window.localStorage.getItem(filmDraftStorageKey(CONVERSATION))
    await user.click(lane('镜头组 2 · 生成 A · 原版', 2))
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_2}.mp4`)
    expect(media().currentTime).toBe(1)
    const handle = screen.getByRole('slider', { name: '选区结尾' })
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 150 })
    expect(media().currentTime).toBeCloseTo(2.999)
    expect(within(screen.getByLabelText('视频预览')).queryByText('整片口播')).toBeNull()
    expect(filmClock).toHaveValue('1.75')
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(media().currentTime).toBeCloseTo(1.999)
    expect(handle).toHaveAttribute('aria-valuenow', '2')
    expect(window.localStorage.getItem(filmDraftStorageKey(CONVERSATION))).toBe(before)
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 150 })
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 150 })
    await user.click(screen.getByRole('button', { name: '开启声音' }))
    await user.click(screen.getByRole('button', { name: '播放' }))
    expect(media().currentTime).toBe(1)
    expect(media().muted).toBe(false)
    media().currentTime = 2
    tick()
    expect(filmClock).toHaveValue('1.75')
    expect(audio.played).toHaveLength(1)
    expect(audio.played[0]?.stopped).toBe(true)
    media().currentTime = 3
    tick()
    expect(screen.getByRole('button', { name: '播放' })).toBeVisible()
    expect(media().currentTime).toBeCloseTo(2.999)
    expect(window.localStorage.getItem(filmDraftStorageKey(CONVERSATION))).toBe(before)
    await user.keyboard('{Escape}')
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_1}.mp4`)
    expect(filmClock).toHaveValue('1.75')
    expect(within(screen.getByLabelText('视频预览')).getByText('整片口播')).toBeVisible()
  })

  it('键盘选区与边界跟随素材；操作成片轨恢复原播放头，再次点素材可重新预览', async () => {
    preparePlayback()
    seedFilm()
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    await addMaterial(user, '镜头组 2 生成 A 原版')
    stubLayout()
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '0.5' },
    })
    const material = lane('镜头组 2 · 生成 A · 原版')
    material.focus()
    await user.keyboard('{Enter}')
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_2}.mp4`)
    screen.getByRole('slider', { name: '选区结尾' }).focus()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(media().currentTime).toBeCloseTo(2.999)
    const end = screen.getByRole('slider', { name: '选区结尾' })
    fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 150 })
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 125 })
    expect(media().currentTime).toBeCloseTo(2.499)
    fireEvent.pointerUp(end, { pointerId: 2, clientX: 125 })
    await user.click(screen.getByRole('button', { name: /^第 1 段/ }))
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_1}.mp4`)
    expect(screen.getByRole('slider', { name: '时间线播放位置' })).toHaveValue('0.5')
    fireEvent.pointerDown(material, { pointerId: 3, button: 0, clientX: 75, clientY: 150 })
    fireEvent.pointerUp(material, { pointerId: 3, clientX: 75, clientY: 150 })
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_2}.mp4`)
    expect(media().currentTime).toBe(1.5)
  })

  it('切素材版本立即预览新版本并清掉旧选区，切整片版本退出素材模式', async () => {
    preparePlayback()
    seedFilm()
    const finished = video('88888888-8888-4888-8888-888888888888', {
      operation: 'compose',
      outputUrl: 'https://example.com/whole-film.mp4',
      finishedAt: '2026-10-14T10:00:00Z',
    })
    serve([...VIDEOS, finished], [])
    const user = userEvent.setup()
    await renderEditor()
    await timeline()
    await addMaterial(user, '镜头组 1 生成 A 原版')
    lane('镜头组 1 · 生成 A · 原版').focus()
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('button', { name: '镜头组 1 生成 A 当前用 原版，换版本' }))
    await user.click(screen.getByRole('menuitemradio', { name: /编辑版 1/ }))
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${COMPOSITE_1}.mp4`)
    expect(screen.queryByRole('slider', { name: '选区结尾' })).toBeNull()
    // 素材区末尾的入口与轨道头换版走同一条选择逻辑，不会留下上一个版本的预览。
    await addMaterial(user, '镜头组 1 生成 A 原版')
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', `https://example.com/${TAKE_1}.mp4`)
    expect(lane('镜头组 1 · 生成 A · 原版')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '整片 V1' }))
    fireEvent.loadedMetadata(media())
    expect(media()).toHaveAttribute('src', 'https://example.com/whole-film.mp4')
    expect(screen.queryByText(/正在预览镜头组/)).toBeNull()
  })
})

/** 生成的音乐：一条音频记录。 */
const musicJob = (overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({
    id: MUSIC_JOB,
    kind: 'audio',
    outputUrl: MUSIC_URL,
    durationMs: 20_000,
    request: { prompt: '轻快的电子乐' },
    ...overrides,
  })

const musicClip = () => screen.getByRole('button', { name: /^音乐：/ })

const openGeneratePanel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: '添加音乐' }))
  await user.click(await screen.findByRole('menuitem', { name: '生成音乐' }))
  return screen.findByRole('dialog', { name: '生成音乐' })
}

describe('WholeFilmEditor 音乐', () => {
  beforeEach(() => {
    // 每分钟 120 拍（每拍 0.5 秒），第一拍在 0 秒。
    vi.mocked(guess).mockResolvedValue({ bpm: 120, offset: 0 })
    server.use(http.get(MUSIC_URL, () => HttpResponse.arrayBuffer(new ArrayBuffer(8))))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('恢复的字幕继续显示，来源口播仍在识别时先等完再合成带音乐的整片', async () => {
    stubWebAudio({ duration: 20 })
    const restored = video('88888888-8888-4888-8888-888888888888', {
      operation: 'compose',
      finishedAt: '2026-10-14T10:00:00Z',
      request: {
        segments: [{ sourceJobId: TAKE_1, startMs: 0, endMs: 4000 }],
        subtitles: [{ startMs: 0, endMs: 2000, text: '原版字幕' }],
        music: {
          audioJobId: MUSIC_JOB,
          url: MUSIC_URL,
          offsetMs: 0,
          gain: [{ atMs: 0, gain: 0.126 }],
        },
      },
    })
    serve([...VIDEOS, restored], [subtitle(TAKE_1, { status: 'submitted' })], [musicJob()])
    const user = userEvent.setup()
    await renderEditor()
    await screen.findByRole('button', { name: /^音乐：/ })
    expect(screen.getByRole('button', { name: '第 1 条字幕：原版字幕' })).toBeVisible()
    expect(await composeBlockedBy(user)).toBe(
      '有 1 段的字幕正在识别，暂时无法合成；识别完成后即可合成',
    )
  })

  it.each(['failed', 'missing'] as const)(
    '恢复字幕和音乐后，口播%s仍可识别且字幕可以编辑',
    async (status) => {
      stubWebAudio({ duration: 20 })
      const restored = video('88888888-8888-4888-8888-888888888888', {
        operation: 'compose',
        finishedAt: '2026-10-14T10:00:00Z',
        request: {
          segments: [{ sourceJobId: TAKE_1, startMs: 0, endMs: 4000 }],
          subtitles: [{ startMs: 0, endMs: 2000, text: '原版字幕' }],
          music: {
            audioJobId: MUSIC_JOB,
            url: MUSIC_URL,
            offsetMs: 0,
            gain: [{ atMs: 0, gain: 0.126 }],
          },
        },
      })
      serve(
        [...VIDEOS, restored],
        status === 'failed' ? [subtitle(TAKE_1, { status: 'failed' })] : [],
        [musicJob()],
      )
      const user = userEvent.setup()
      await renderEditor()
      await screen.findByRole('button', { name: /^音乐：/ })
      expect(
        screen.getByRole('button', {
          name:
            status === 'failed'
              ? '镜头组 1 · 生成 A · 原版 字幕识别失败，重试'
              : '镜头组 1 · 生成 A · 原版 字幕未识别，识别',
        }),
      ).toBeVisible()
      await user.click(screen.getByRole('button', { name: '第 1 条字幕：原版字幕' }))
      const input = screen.getByRole('textbox', { name: '字幕文字' })
      await user.clear(input)
      await user.type(input, '修改后的字幕')
      expect(screen.getByRole('button', { name: '第 1 条字幕：修改后的字幕' })).toBeVisible()
      expect(screen.getByRole('button', { name: '合成成片' })).not.toHaveAttribute('aria-disabled')
    },
  )

  it('生成：引用工程文件里的配乐原文原样提交，带本对话与它此刻的需求单；生成中，完成后自动对齐', async () => {
    stubWebAudio({ duration: 20 })
    seedFilm()
    seedMockFilm(CONVERSATION, { musicDescription: '轻快的电子乐，鼓点渐入' })
    const music: GenerationJob[] = []
    serve(VIDEOS, [], music)
    let body: unknown
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        body = await request.json()
        const created = musicJob({ status: 'pending', outputUrl: null, durationMs: null })
        music.push(created)
        return HttpResponse.json({ generation: created }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const { queryClient } = await renderEditor()
    await timeline()

    const panel = await openGeneratePanel(user)
    expect(await within(panel).findByText('轻快的电子乐，鼓点渐入')).toBeVisible()
    expect(within(panel).getByText('使用工程文件里的配乐：')).toBeVisible()
    expect(within(panel).queryByRole('textbox')).toBeNull()
    await user.click(within(panel).getByRole('button', { name: '生成' }))

    await waitFor(() =>
      expect(body).toEqual({
        conversationId: CONVERSATION,
        prompt: '轻快的电子乐，鼓点渐入',
        taskId: CONVERSATION_TASK,
      }),
    )
    expect(await screen.findByText('音乐生成中，完成后自动对齐')).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '生成音乐' })).toBeNull()

    // 状态跳转帧到了：记录完成，重拉后放上并对齐。
    Object.assign(music[0] ?? {}, { status: 'completed', outputUrl: MUSIC_URL, durationMs: 20_000 })
    await act(() =>
      queryClient.invalidateQueries({ queryKey: storyboardQueryKeys.conversation(CONVERSATION) }),
    )
    // 起点 1.0：切点 1.0 落在小节第一拍（2.0）、2.5 落在拍上（3.5），3 分；同分里最早。
    expect(
      await screen.findByRole('button', { name: '音乐：生成的音乐，使用 1.0–5.0 秒' }),
    ).toBeVisible()

    await user.click(musicClip())
    const card = screen.getByRole('region', { name: '选中的音乐' })
    expect(within(card).getByText('生成的音乐')).toBeVisible()
    expect(within(card).getByText('使用 1.0–5.0 秒 · 整首 20.0 秒')).toBeVisible()
    expect(within(card).getByText('每分钟 120 拍 · 2 个切点中 2 个落在拍上')).toBeVisible()
    expect(within(card).getByRole('button', { name: '重新生成' })).toBeVisible()
    expect(screen.getByText('音乐已自动对齐；拖动音乐可换用别的范围')).toBeVisible()
  })

  it('没有工程文件：让人写一句，写什么发什么，不加前后缀', async () => {
    seedFilm()
    serve(VIDEOS, [])
    let body: { prompt?: string } | undefined
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        body = (await request.json()) as { prompt: string }
        return HttpResponse.json(
          { generation: musicJob({ status: 'pending', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    await timeline()

    const panel = await openGeneratePanel(user)
    const text = await within(panel).findByRole('textbox', { name: '音乐描述' })
    expect(within(panel).getByRole('button', { name: '生成' })).toBeDisabled()
    await user.type(text, ' 夏天海边的轻快吉他 ')
    await user.click(within(panel).getByRole('button', { name: '生成' }))

    await waitFor(() => expect(body?.prompt).toBe(' 夏天海边的轻快吉他 '))
  })

  it('生成失败：音乐轨写明失败，重试按原来的提示词再发一次', async () => {
    seedFilm({ kind: 'generate', jobId: MUSIC_JOB, userStart: null })
    serve(VIDEOS, [], [musicJob({ status: 'failed', outputUrl: null })])
    const prompts: string[] = []
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        prompts.push(((await request.json()) as { prompt: string }).prompt)
        return HttpResponse.json(
          { generation: musicJob({ id: crypto.randomUUID(), status: 'pending', outputUrl: null }) },
          { status: 202 },
        )
      }),
    )
    const user = userEvent.setup()
    await renderEditor()

    expect(await screen.findByText('音乐生成失败')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(prompts).toEqual(['轻快的电子乐']))
  })

  it('上传：浏览器报 audio/x-m4a 的 m4a 按 audio/mp4 签名，放上音乐轨，卡片标题是文件名', async () => {
    stubWebAudio({ duration: 20 })
    seedFilm()
    serve(VIDEOS, [])
    let signed: unknown
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/uploads/sign'))
        void request
          .clone()
          .json()
          .then((value: unknown) => (signed = value))
    })
    const user = userEvent.setup()
    await renderEditor()
    await timeline()

    await user.upload(
      screen.getByLabelText('选择音乐文件'),
      new File(['music'], '夏日节拍.m4a', { type: 'audio/x-m4a' }),
    )

    expect(await screen.findByRole('button', { name: /^音乐：夏日节拍\.m4a，使用/ })).toBeVisible()
    expect(signed).toEqual({ contentType: 'audio/mp4', height: null, width: null })
    await user.click(musicClip())
    expect(
      within(screen.getByRole('region', { name: '选中的音乐' })).getByText('夏日节拍.m4a'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
  })

  it('上传认不出的类型：写明原因，不上传', async () => {
    seedFilm()
    serve(VIDEOS, [])
    const requests: string[] = []
    server.events.on('request:start', ({ request }) => requests.push(new URL(request.url).pathname))
    const user = userEvent.setup({ applyAccept: false })
    await renderEditor()
    await timeline()

    await user.upload(
      screen.getByLabelText('选择音乐文件'),
      new File(['music'], '夏日节拍.ogg', { type: 'audio/ogg' }),
    )

    expect(
      await screen.findByText('文件格式不受支持，无法上传；请选择 MP3、WAV 或 M4A 音乐'),
    ).toBeVisible()
    expect(requests).not.toContain('/api/uploads/sign')
    expect(screen.queryByRole('button', { name: /^音乐：/ })).toBeNull()
  })

  it('拖动音乐保留自由起点，气泡显示命中数；方向键微调，自动对齐恢复推荐起点', async () => {
    stubWebAudio({ duration: 20 })
    seedFilm(UPLOADED)
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await screen.findByRole('button', { name: '音乐：夏日节拍.mp3，使用 1.0–5.0 秒' })
    stubLayout()

    // 比例按 20 秒排，200px 宽：每秒 10px。往左拖 1.4 秒，整首往左滑，换用更靠后的一截，保留 2.4 秒，不强制吸附。
    fireEvent.pointerDown(musicClip(), { pointerId: 1, button: 0, clientX: 20 })
    fireEvent.pointerMove(musicClip(), { pointerId: 1, clientX: 6 })
    expect(screen.getByText('使用 2.4–6.4 秒 · 落在拍上的切点 0/2')).toBeVisible()
    fireEvent.pointerUp(musicClip(), { pointerId: 1, clientX: 6 })
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 2.4–6.4 秒')

    musicClip().focus()
    await user.keyboard('{ArrowRight}')
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 2.5–6.5 秒')
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 1.5–5.5 秒')

    // 拖动是一步，能撤回。
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 2.5–6.5 秒')
    await user.click(screen.getByRole('button', { name: '自动对齐' }))
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 1.0–5.0 秒')
  })

  it('音乐比视频段短：后面接空位写明短多少，「合成成片」说明原因，不循环补', async () => {
    stubWebAudio({ duration: 2 })
    seedFilm(UPLOADED)
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()

    expect(await screen.findByText('音乐比成片短 2.0 秒')).toBeVisible()
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 0.0–2.0 秒')
    expect(await composeBlockedBy(user)).toBe('音乐比成片短 2.0 秒，无法合成；请重新生成或换一首')
    expect(
      screen.getByText('上传的音乐只有 2.0 秒，铺不满第一段开头到最后一段结尾，不循环补齐'),
    ).toBeVisible()
  })

  it('没检测到拍子：明确说出来，从 0 秒起用', async () => {
    stubWebAudio({ duration: 20 })
    vi.mocked(guess).mockRejectedValue(
      new Error('The given channelData does not contain any detectable beats.'),
    )
    seedFilm(UPLOADED)
    serve(VIDEOS, [])
    await renderEditor()

    expect(
      await screen.findByText('这首音乐没有检测到拍子，从 0 秒起使用，未按切点对齐'),
    ).toBeVisible()
    expect(musicClip()).toHaveAccessibleName('音乐：夏日节拍.mp3，使用 0.0–4.0 秒')
  })

  it('卡片上删除音乐，撤销放回来', async () => {
    stubWebAudio({ duration: 20 })
    seedFilm(UPLOADED)
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await user.click(await screen.findByRole('button', { name: /^音乐：/ }))

    await user.click(
      within(screen.getByRole('region', { name: '选中的音乐' })).getByRole('button', {
        name: '删除',
      }),
    )
    expect(screen.queryByRole('button', { name: /^音乐：/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByRole('button', { name: /^音乐：/ })).toBeVisible()
  })

  it('已自动对齐时重复点击保留音量调整的重做，并提示缺少口播避让', async () => {
    stubWebAudio({ duration: 20 })
    seedFilm(UPLOADED)
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await screen.findByRole('button', { name: /^音乐：/ })
    expect(
      screen.getByText('有 3 段缺少口播识别，配乐未自动避让；请在字幕轨重新识别'),
    ).toBeVisible()
    fireEvent.change(screen.getByRole('slider', { name: '配乐音量' }), { target: { value: '35' } })
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByRole('slider', { name: '配乐音量' })).toHaveValue('100')
    await user.click(screen.getByRole('button', { name: '自动对齐' }))
    await user.click(screen.getByRole('button', { name: '重做' }))
    expect(screen.getByRole('slider', { name: '配乐音量' })).toHaveValue('35')
  })

  it('预览播放完整混音，从播放头处起播，静音和暂停同步，关闭后释放音频资源', async () => {
    const audio = stubWebAudio({ duration: 20 })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    // 三段同一个来源：播放器跳到哪，读回来就是哪（jsdom 不加载媒体）。
    const times = new WeakMap<HTMLMediaElement, number>()
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'get').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      return times.get(this) ?? 0
    })
    vi.spyOn(HTMLMediaElement.prototype, 'currentTime', 'set').mockImplementation(function (
      this: HTMLMediaElement,
      value: number,
    ) {
      times.set(this, value)
    })
    seedFilm(UPLOADED)
    // 第 1 段（素材 0–1 秒）里有一句口播：素材 0.2–0.8 秒，即整片 0.2–0.8 秒。
    serve(VIDEOS, [
      subtitle(TAKE_1, { sentences: [{ startMs: 200, endMs: 800, text: '你好', speaker: 0 }] }),
    ])
    const user = userEvent.setup()
    const { unmount, queryClient } = await renderEditor()
    await screen.findByRole('button', { name: '音乐：夏日节拍.mp3，使用 1.0–5.0 秒' })
    await screen.findByRole('button', { name: '第 1 条字幕：你好' })

    // 混音已经包含音乐起点与口播压低；播放器只按整片的 2 秒处起播，剩 2 秒。
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '2' },
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '播放' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '播放' }))
    await waitFor(() => expect(audio.played).toHaveLength(1))
    expect(audio.played[0]).toMatchObject({ when: 0, offset: 2, duration: 2 })
    // 播放器默认静音，音乐跟着静音；开声音后一起出声。
    expect(audio.master.at(-1)?.value).toBe(0)
    await user.click(screen.getByRole('button', { name: '开启声音' }))
    expect(audio.master.at(-1)?.value).toBe(1)
    // 原视频始终静音，防止原声和预混音重复播放。
    expect(screen.getByLabelText('视频播放器')).toHaveProperty('muted', true)

    // 调音后仍在播放，新混音从当前播放头换入，无需再按播放。
    fireEvent.change(screen.getByRole('slider', { name: '配乐音量' }), { target: { value: '35' } })
    expect(screen.getByRole('button', { name: '暂停' })).toBeEnabled()
    await waitFor(() => expect(audio.played).toHaveLength(2))
    expect(audio.played[1]).toMatchObject({ offset: 2, duration: 2 })

    await user.click(screen.getByRole('button', { name: '暂停' }))
    expect(audio.played[1]?.stopped).toBe(true)
    expect(audio.played).toHaveLength(2)
    unmount()
    expect(audio.closed).toBe(1)
    expect(audio.workers.every((worker) => worker.terminated)).toBe(true)
    await waitFor(() => {
      for (const key of ['music-analysis', 'preview-source', 'preview-mix'])
        expect(queryClient.getQueriesData({ queryKey: ['whole-film', key] })).toEqual([])
    })
  })
})

describe('整片字幕字体', () => {
  const font = {
    id: 'ab000001-0000-4000-8000-000000000001',
    kind: 'font',
    brand: '品牌',
    name: '品牌黑体',
    url: 'https://example.com/brand.ttf',
    width: null,
    height: null,
    durationMs: null,
    hasAudio: null,
    createdAt: '2026-10-14T00:00:00Z',
    disabledAt: null,
  }
  const serveFont = (end = 0x10ffff) => {
    seedFilm()
    serve(VIDEOS, [
      subtitle(TAKE_1, { sentences: [{ startMs: 0, endMs: 1000, text: '你好', speaker: 0 }] }),
    ])
    server.use(
      http.get('*/api/brand-templates', () => HttpResponse.json({ items: [font] })),
      http.get('*/api/brand-templates/:id/font-info', () =>
        HttpResponse.json({
          family: 'Brand',
          weight: 500,
          style: 'normal',
          unicodeRanges: [{ start: 0, end }],
        }),
      ),
    )
  }
  const stubFont = (deferred = false) => {
    const restoreMedia = stubMediaDurations({ [`https://example.com/${TAKE_1}.mp4`]: 4 })
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(720)
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1280)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: (text: string) => ({
        width: text.length * 20,
        fontBoundingBoxAscent: 48,
        fontBoundingBoxDescent: 12,
      }),
    } as unknown as CanvasRenderingContext2D)
    let finish = () => {}
    const loaded = vi.fn()
    const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: new Set<FontFace>() })
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(family: string, source: string) {
          loaded(family, source)
        }
        load() {
          return deferred
            ? new Promise((resolve) => {
                finish = () => resolve(this)
              })
            : Promise.resolve(this)
        }
      },
    )
    return {
      loaded,
      finish: () => finish(),
      restore: () => {
        cleanup()
        restoreMedia()
        vi.unstubAllGlobals()
        if (descriptor === undefined) Reflect.deleteProperty(document, 'fonts')
        else Object.defineProperty(document, 'fonts', descriptor)
      },
    }
  }

  it('轨道字体选择等待实际文件，撤销重做和合成都使用所选字体', async () => {
    serveFont()
    const fontFile = stubFont(true)
    let body: unknown
    server.use(
      http.post('*/api/generations/whole-films', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(
          {
            generation: video('ab000002-0000-4000-8000-000000000001', {
              operation: 'compose',
              status: 'submitted',
              outputUrl: null,
            }),
          },
          { status: 202 },
        )
      }),
    )
    try {
      const user = userEvent.setup()
      await renderEditor()
      await timeline()
      await user.click(screen.getByRole('button', { name: '字幕字体：系统默认' }))
      await user.click(await screen.findByRole('menuitemradio', { name: '品牌黑体 · 品牌' }))
      await waitFor(() =>
        expect(fontFile.loaded).toHaveBeenCalledWith(
          `iclip-brand-font-${font.id}`,
          `url("${font.url}")`,
        ),
      )
      expect(screen.getByRole('button', { name: '合成成片' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      expect(within(screen.getByLabelText('视频预览')).queryByText('你好')).toBeNull()
      await act(async () => fontFile.finish())
      expect(await within(screen.getByLabelText('视频预览')).findByText('你好')).toBeVisible()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '合成成片' })).not.toHaveAttribute(
          'aria-disabled',
        ),
      )
      await waitFor(() =>
        expect(window.localStorage.getItem(filmDraftStorageKey(CONVERSATION))).toContain(font.id),
      )
      await user.click(screen.getByRole('button', { name: '撤销' }))
      expect(screen.getByRole('button', { name: '字幕字体：系统默认' })).toBeVisible()
      await user.click(screen.getByRole('button', { name: '重做' }))
      expect(screen.getByRole('button', { name: '字幕字体：品牌黑体' })).toBeVisible()
      await user.click(screen.getByRole('button', { name: '合成成片' }))
      await waitFor(() => expect(body).toMatchObject({ fontId: font.id }))
    } finally {
      fontFile.restore()
    }
  })

  it('草稿中的停用字体仍可按原文件预览，新合成需要更换字体', async () => {
    serveFont()
    const saved = JSON.parse(
      window.localStorage.getItem(filmDraftStorageKey(CONVERSATION)) ?? '{}',
    ) as Record<string, unknown>
    window.localStorage.setItem(
      filmDraftStorageKey(CONVERSATION),
      JSON.stringify({ ...saved, font: { fontId: font.id, name: font.name, url: font.url } }),
    )
    server.use(http.get('*/api/brand-templates', () => HttpResponse.json({ items: [] })))
    const fontFile = stubFont()
    try {
      const user = userEvent.setup()
      await renderEditor()
      await timeline()
      expect(screen.getByRole('button', { name: '字幕字体：品牌黑体' })).toBeVisible()
      expect(await within(screen.getByLabelText('视频预览')).findByText('你好')).toBeVisible()
      expect(await composeBlockedBy(user)).toContain('所选字体已停用或不可用')
    } finally {
      fontFile.restore()
    }
  })

  it('字体缺字时不显示替代字幕并阻止合成，切回系统默认即可继续', async () => {
    serveFont(127)
    const fontFile = stubFont()
    try {
      const user = userEvent.setup()
      await renderEditor()
      await timeline()
      await user.click(screen.getByRole('button', { name: '字幕字体：系统默认' }))
      await user.click(await screen.findByRole('menuitemradio', { name: '品牌黑体 · 品牌' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(
        '所选字体不包含部分文字，请选择其他字体',
      )
      expect(screen.getByRole('button', { name: '合成成片' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      expect(within(screen.getByLabelText('视频预览')).queryByText('你好')).toBeNull()
      await user.click(screen.getByRole('button', { name: '字幕字体：品牌黑体' }))
      await user.click(await screen.findByRole('menuitemradio', { name: '系统默认' }))
      expect(await within(screen.getByLabelText('视频预览')).findByText('你好')).toBeVisible()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '合成成片' })).not.toHaveAttribute(
          'aria-disabled',
        ),
      )
    } finally {
      fontFile.restore()
    }
  })
})

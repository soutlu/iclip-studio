import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { stubMediaDurations } from '@/testing/media'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import { filmDraftStorageKey } from './use-film-draft'
import { WholeFilmEditor } from './whole-film-editor'

/** mediabunny 的替身：都没有音轨，波形写「无声」。jsdom 读不了真文件。 */
vi.mock('mediabunny', () => {
  class UrlSource {
    readonly url: string
    constructor(url: string) {
      this.url = url
    }
  }
  class Input {
    getPrimaryAudioTrack = () => Promise.resolve(null)
    dispose = () => {}
  }
  return {
    AudioSampleSink: class {},
    BufferTarget: class {},
    Conversion: {},
    EncodedPacketSink: class {},
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

/** 本对话的记录：视频与字幕记录按 `kind` 分开答。 */
const serve = (videos: GenerationJob[], subtitles: GenerationJob[]) =>
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({ items: kind === 'subtitle' ? subtitles : videos })
    }),
  )

const renderEditor = () =>
  renderWithProviders(<WholeFilmEditor conversationId={CONVERSATION} onClose={() => {}} />)

const timeline = () => screen.findByRole('region', { name: '整片时间线' })
const filmSegments = () => screen.queryAllByRole('button', { name: /^第 \d+ 段/ })

/** 从「添加视频」选一版放进素材区。 */
const addMaterial = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await screen.findByRole('button', { name: '添加视频' }))
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) }))
}

const lane = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} 素材`) })

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
  vi.spyOn(screen.getByTestId('film-lanes'), 'getBoundingClientRect').mockReturnValue(
    rect(0, 0, 200, 300),
  )
  vi.spyOn(screen.getByTestId('film-lane'), 'getBoundingClientRect').mockReturnValue(
    rect(0, 22, 200, 48),
  )
}

beforeEach(() => {
  window.localStorage.clear()
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
  it('开局为空：成片轨是占位，素材区只有一行「添加视频」；选成片面板按版本组列出各版', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()

    const track = await timeline()
    expect(within(track).getByText('从下方素材轨拖选片段放到这里')).toBeVisible()
    expect(screen.getByText('成片轨还是空的')).toBeVisible()
    expect(screen.getByRole('button', { name: '合成成片' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '添加视频' }))
    const tiles = (await screen.findAllByRole('menuitem')).map((item) =>
      item.getAttribute('aria-label'),
    )
    expect(tiles).toEqual([
      '镜头组 1 V2，4.0 秒',
      '镜头组 1 V1，4.0 秒',
      '镜头组 2 V1，4.0 秒',
      '视频 1 V1，4.0 秒',
    ])

    await user.click(screen.getByRole('menuitem', { name: /^镜头组 1 V2/ }))
    expect(lane('镜头组 1 · V2')).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加视频' })).toBeNull()
  })

  it('键盘：回车选中整条素材，调整结尾后回车插入到播放头处，后面的段接着排', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 V1')

    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('素材 0.00–4.00 秒 · 4.0 秒')).toBeVisible()
    await user.keyboard('{Enter}')
    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 2 · V1 · 0–4 秒',
    ])

    // 选区结尾往前收 1 秒（Shift 一步一秒），再插一次：播放头已在第 1 段结尾，排在它后面。
    screen.getByRole('slider', { name: '选区结尾' }).focus()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
        '第 1 段 · 镜头组 2 · V1 · 0–4 秒',
        '第 2 段 · 镜头组 2 · V1 · 4–7 秒',
      ]),
    )
    expect(screen.getByText('7.0')).toBeVisible()
  })

  it('指针：在素材轨上拖选一截，按住选区拖到成片轨，松手处插入', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 V1')
    stubLayout()
    const material = lane('镜头组 1 · V1')

    // 比例按 20 秒排，200px 宽：每秒 10px。拖选 1–3 秒。
    fireEvent.pointerDown(material, { pointerId: 1, button: 0, clientX: 10, clientY: 150 })
    fireEvent.pointerMove(material, { pointerId: 1, clientX: 30, clientY: 150 })
    fireEvent.pointerUp(material, { pointerId: 1, clientX: 30, clientY: 150 })
    expect(screen.getByText('素材 1.00–3.00 秒 · 2.0 秒')).toBeVisible()

    // 按住选区拖到成片轨上：出现插入点与提示，松手插入。
    fireEvent.pointerDown(material, { pointerId: 2, button: 0, clientX: 20, clientY: 150 })
    fireEvent.pointerMove(material, { pointerId: 2, clientX: 20, clientY: 40 })
    expect(screen.getByText('插入到 0.00 秒')).toBeVisible()
    fireEvent.pointerUp(material, { pointerId: 2, clientX: 20, clientY: 40 })

    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 1 · V1 · 0–2 秒',
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

    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(filmSegments()).toHaveLength(30)
    expect(
      screen.getByText('整片已有 117.0 秒，放不下这 4.0 秒；请先删减成片轨上的段'),
    ).toBeVisible()
  })

  it('换版本只影响之后挑的段，已在成片轨上的段不变', async () => {
    serve(VIDEOS, [])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 V2')
    lane('镜头组 1 · V2').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(screen.getByRole('button', { name: '镜头组 1 当前用 V2，换版本' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /V1/ }))
    lane('镜头组 1 · V1').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(filmSegments().map((item) => item.getAttribute('aria-label'))).toEqual([
      '第 1 段 · 镜头组 1 · V2 · 0–4 秒',
      '第 2 段 · 镜头组 1 · V1 · 4–8 秒',
    ])
  })

  it('字幕跟着段走，改字存在草稿里；撤销退回改字之前', async () => {
    serve(VIDEOS, [
      subtitle(TAKE_2, {
        sentences: [{ startMs: 500, endMs: 2500, text: '今天带来一款新耳机', speaker: 0 }],
      }),
    ])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 V1')
    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(await screen.findByRole('button', { name: '第 1 条字幕：今天带来一款新耳机' }))
    const card = screen.getByRole('region', { name: '选中的字幕' })
    expect(within(card).getByText('来自镜头组 2 · V1 的口播')).toBeVisible()
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

  it('没有字幕记录的段标「未识别 · 识别」，点了带本对话与需求单提交识别，随后显示「识别中」', async () => {
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
    await addMaterial(user, '镜头组 2 V1')
    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}{Enter}')

    await user.click(await screen.findByRole('button', { name: '镜头组 2 · V1 字幕未识别，识别' }))

    await waitFor(() =>
      expect(body).toEqual({ conversationId: CONVERSATION, sourceJobId: TAKE_2, taskId: TASK }),
    )
    expect(await screen.findByText('识别中')).toBeVisible()
  })

  it('识别失败标「识别失败 · 重试」；没有口播什么也不标', async () => {
    serve(VIDEOS, [subtitle(TAKE_1, { status: 'failed' }), subtitle(TAKE_2, { sentences: [] })])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 1 V1')
    lane('镜头组 1 · V1').focus()
    await user.keyboard('{Enter}{Enter}')
    await addMaterialFromToolbar(user, '镜头组 2 V1')
    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}{Enter}')

    expect(
      await screen.findByRole('button', { name: '镜头组 1 · V1 字幕识别失败，重试' }),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: /镜头组 2 · V1 字幕/ })).toBeNull()
    expect(screen.queryByText('识别中')).toBeNull()
  })

  it('素材时长读不出来时轨上写明原因，不能挑段', async () => {
    const restore = stubMediaDurations({ [`https://example.com/${LOOSE}.mp4`]: null })
    try {
      serve(
        VIDEOS.map((item) => (item.id === LOOSE ? { ...item, durationMs: null } : item)),
        [],
      )
      const user = userEvent.setup()
      await renderEditor()
      await addMaterial(user, '视频 1 V1')

      expect(
        await screen.findByText('视频时长读取失败，无法从这条素材挑段；请换一个版本'),
      ).toBeVisible()
      lane('视频 1 · V1').focus()
      await user.keyboard('{Enter}')
      expect(screen.queryByText(/^素材 \d/)).toBeNull()
    } finally {
      restore()
    }
  })

  it('字幕轨的「+」在播放头处加一条手动字幕，只能改字和删除', async () => {
    serve(VIDEOS, [subtitle(TAKE_2, { sentences: [] })])
    const user = userEvent.setup()
    await renderEditor()
    await addMaterial(user, '镜头组 2 V1')
    lane('镜头组 2 · V1').focus()
    await user.keyboard('{Enter}{Enter}')
    // 插入后播放头先到新段的结尾，那里没有画面、加不了；拖回 1 秒处。
    const seek = screen.getByRole('slider', { name: '时间线播放位置' })
    await waitFor(() => expect(seek).toHaveAttribute('aria-valuetext', '00:04.00'))
    expect(screen.getByRole('button', { name: '在播放头处添加字幕' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    fireEvent.change(seek, { target: { value: '1' } })

    await user.click(screen.getByRole('button', { name: '在播放头处添加字幕' }))
    const card = screen.getByRole('region', { name: '选中的字幕' })
    expect(within(card).getByText('手动添加')).toBeVisible()
    await user.type(within(card).getByRole('textbox', { name: '字幕文字' }), '限时优惠')
    expect(screen.getByRole('button', { name: '第 1 条字幕：限时优惠' })).toBeVisible()

    await user.click(within(card).getByRole('button', { name: '删除' }))
    expect(screen.queryByRole('button', { name: /^第 1 条字幕/ })).toBeNull()
  })
})

/** 素材区已有轨时用键盘从控制条的「添加」→「视频」选一版：方向键移到那一格，回车。 */
const addMaterialFromToolbar = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  screen.getByRole('button', { name: '添加' }).focus()
  await user.keyboard('{Enter}')
  await screen.findByRole('menuitem', { name: '视频' })
  await user.keyboard('{ArrowDown}{ArrowRight}')
  await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })
  for (let step = 0; step < 10; step += 1) {
    if (document.activeElement?.getAttribute('aria-label')?.startsWith(name) === true) break
    await user.keyboard('{ArrowDown}')
  }
  await user.keyboard('{Enter}')
}

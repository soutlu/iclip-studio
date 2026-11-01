import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { SubtitleIn, WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockConversation } from '@/testing/mocks/conversations'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { renderWithProviders } from '@/testing/render'
import {
  card,
  draftOf,
  fixtureCatalog,
  fixtureItem,
  overlay as overlayAt,
  video,
} from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import type { ComponentCatalog } from './component-catalog'
import { REFUSAL_TEXT } from './refusal-text'
import { WholeFilmEditor } from './whole-film-editor'
import { wholeFilmQueryKeys } from './whole-film.api'

// jsdom 读不了真文件：mediabunny 换成按地址给关键帧表、时长与画面尺寸的替身；没有原声轨。
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())

vi.mock('mediabunny', async () => {
  const { createMediaReaderMock } = await import('@/testing/media-reader')
  class AudioSampleSink {}
  return { ...createMediaReaderMock(files), AudioSampleSink }
})

const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const URL_A = 'https://example.com/take-a.mp4'
const URL_B = 'https://example.com/take-b.mp4'
const TAKE_A = '11111111-2222-4333-8444-555555555555'
const TAKE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const MUSIC_URL = 'https://example.com/song.wav'

files.set(URL_A, { keyframes: [0, 2, 4.5], duration: 6 })
files.set(URL_B, { keyframes: [0, 1.5], duration: 3 })

const takes = [
  makeGenerationJob({
    id: TAKE_A,
    createdAt: '2026-09-01T10:00:00Z',
    outputUrl: URL_A,
    shotIndex: 1,
    durationMs: 6000,
  }),
  makeGenerationJob({
    id: TAKE_B,
    createdAt: '2026-09-01T10:05:00Z',
    outputUrl: URL_B,
    shotIndex: 1,
    durationMs: 3000,
  }),
]

/** 这段对话的生成记录；按 kind 筛，与后端同一口径 */
const serveGenerations = (records: GenerationJob[]) => {
  const conversation = addMockConversation('成片编辑', undefined, undefined, CONVERSATION)
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({
        items: records.filter((job) => kind === null || job.kind === kind),
      })
    }),
    http.get('*/api/conversations/:conversationId', () => HttpResponse.json({ conversation })),
  )
}

const openEditor = async (records: GenerationJob[] = takes) => {
  serveGenerations(records)
  const onClose = vi.fn()
  const rendered = await renderWithProviders(
    <>
      <WholeFilmEditor
        conversationTitle="夜景延时素材生成"
        conversationId={CONVERSATION}
        onClose={onClose}
      />
      <Toaster />
    </>,
  )
  await screen.findByRole('group', { name: '成片编辑器' })
  /** 关掉编辑器：页面上不再渲染它 */
  const close = () => rendered.rerender(<Toaster />)
  return { onClose, close, queryClient: rendered.queryClient }
}

const filmLane = () => screen.getByRole('group', { name: '画面轨' })

// jsdom 没有指针捕获，按下轨道上的块时组件会捕获指针，这里补上。
const capturable = (element: HTMLElement) =>
  Object.assign(element, {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })

/** 画面轨上的一块（选中按钮）；名字以选中：开头 */
const blockButton = async (name: RegExp) =>
  capturable(await within(filmLane()).findByRole('button', { name }))

const savedDraft = () => mockWholeFilmDraft(CONVERSATION)?.document

/** 保存是停下 0.8 秒后才发 */
const waitSaved = (check: (document: WholeFilmDocument | undefined) => void) =>
  waitFor(() => check(savedDraft()), { timeout: 4000 })

const twoClips = () => draftOf([video('v1', TAKE_A, 0, 2_000), video('v2', TAKE_B, 0, 1_500)])

/** 两段视频中间夹一段组件（测试可填项），文字填的是「通用」：v1 0–2、c1 2–4、v2 4–5.5 秒 */
const clipsAroundComponent = () =>
  draftOf([
    video('v1', TAKE_A, 0, 2_000),
    card('c1', 2_000, { component: 'fixture-fields', variables: { text: '通用' } }),
    video('v2', TAKE_B, 0, 1_500),
  ])

/** 组件库目录换成给定的一份（默认是测试组件库的目录） */
const serveCatalog = (catalog: ComponentCatalog) =>
  server.use(http.get('/hyperframes/catalog.json', () => HttpResponse.json(catalog)))

describe('成片编辑器', () => {
  it('别处存过更新的一版：换成那一版并说明', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    putMockWholeFilmDraft(CONVERSATION, draftOf([video('v1', TAKE_B, 0, 3_000)]))

    await user.click(await blockButton(/选中：第 2 段/))
    await user.click(screen.getByRole('button', { name: '删除' }))

    expect(
      await screen.findByText(
        '成片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃',
        undefined,
        { timeout: 4000 },
      ),
    ).toBeInTheDocument()
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(1)
    expect(
      within(filmLane()).getByRole('group', { name: /^第 1 段 · B .*，3\.0 秒$/ }),
    ).toBeInTheDocument()
  })

  it('上传音乐时挂到这段对话，传完出现在列表里', async () => {
    const user = userEvent.setup()
    const records = [...takes]
    const confirms: unknown[] = []
    server.use(
      http.post('*/api/uploads/:uploadId/confirm', async ({ params, request }) => {
        confirms.push(await request.clone().json())
        records.push(
          makeGenerationJob({
            id: String(params['uploadId']),
            kind: 'audio',
            operation: 'upload',
            createdAt: '2026-09-02T09:30:00Z',
            outputUrl: MUSIC_URL,
          }),
        )
        return undefined
      }),
      // 上传的音乐没记时长，编辑器会下载它量时长与波形；对象存储返回刚传上去的内容。
      http.get(MUSIC_URL, () => HttpResponse.arrayBuffer(new TextEncoder().encode('wav').buffer)),
    )
    await openEditor(records)
    await screen.findByText('暂无音乐')

    await user.upload(
      screen.getByLabelText('选择音乐文件'),
      new File(['wav'], 'bgm.wav', { type: 'audio/wav' }),
    )
    const list = await screen.findByRole('list', { name: '这段对话的音乐' })
    expect(within(list).getByText(/^音乐 1 · 上传的音乐 · /)).toBeInTheDocument()
    expect(confirms).toEqual([{ conversationId: CONVERSATION }])
  })

  it('成片里还没有画面：播放、导出置灰并说明原因；没选音乐时自动卡点置灰', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('成片里还没有画面；加入视频或组件后可以在这里预览')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '播放' })).toHaveAttribute('aria-disabled', 'true')
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.hover(exportButton)
    expect(
      (await screen.findAllByText('成片里还没有画面，无法导出；请先加入视频或组件')).length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '自动卡点' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })
})

describe('成片编辑器 · 时间线', () => {
  it('焦点在挂进弹窗的生成音乐浮层上时，Delete 不删选中的段', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const first = await blockButton(/^选中：第 1 段/)
    await user.click(first)
    await user.click(screen.getByRole('button', { name: '生成音乐' }))
    const music = await screen.findByRole('dialog', { name: '生成音乐' })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    music.focus()
    expect(music).toHaveFocus()
    await user.keyboard('{Delete}')
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)
  })

  it('选中特效块时 ←/→ 把它挪 0.1 秒、⇧ 1 秒；没选中特效块时播放头走', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, {
      ...twoClips(),
      overlays: [{ ...overlayAt('o1', 1_000, 1_000), component: 'fixture-overlay' }],
    })
    await openEditor()
    const overlays = screen.getByRole('group', { name: '特效轨' })
    await user.click(
      capturable(within(overlays).getByRole('button', { name: /^选中：特效 · 测试叠加/ })),
    )
    await user.keyboard('{ArrowRight}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 测试叠加，第 1 行，1.1–2.1 秒' }),
    ).toBeInTheDocument()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 测试叠加，第 1 行，0.1–1.1 秒' }),
    ).toBeInTheDocument()

    await user.click(await blockButton(/^选中：第 1 段/))
    const playhead = screen.getByRole('slider', { name: '时间线播放位置' })
    expect(playhead).toHaveValue('0')
    await user.keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(playhead).toHaveValue('1.1')
  })

  it('播放头按帧走：停在报回毫秒偏小的那一帧上，⇧→ 仍正好走 1 秒', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    // 预览播放器换上来之后，跳转才经过它按帧取整
    await waitFor(() =>
      expect(document.querySelector('hyperframes-player:not(.is-pending)')).not.toBeNull(),
    )
    await user.click(await blockButton(/^选中：第 1 段/))
    const playhead = screen.getByRole('slider', { name: '时间线播放位置' })
    // 1.34 秒落在第 40 帧，播放器报回 1.3333… 秒，取整成 1333 毫秒
    fireEvent.change(playhead, { target: { value: '1.34' } })
    expect(playhead).toHaveValue('1.333')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(playhead).toHaveValue('2.333')
  })

  it('音量推子按 dB：0 dB 在正中，←/→ 0.5 dB、⇧ 3 dB，双击回 0 dB，草稿里存倍数', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    // 两个推子在剪辑工具条里，没有单独的声音行
    const sound = within(screen.getByRole('toolbar', { name: '剪辑工具' })).getByRole('group', {
      name: '声音',
    })
    expect(within(sound).getByRole('slider', { name: '配乐' })).toBeDisabled()
    expect(screen.queryByText('选择片段可调原声')).not.toBeInTheDocument()
    const fader = within(sound).getByRole('slider', { name: '原声' })
    expect(fader).toBeDisabled()
    await user.click(await blockButton(/^选中：第 1 段/))
    expect(fader).toHaveValue('0')
    expect(fader).toHaveAttribute('aria-valuetext', '0 dB')
    fader.focus()
    await user.keyboard('{ArrowRight}')
    expect(fader).toHaveAttribute('aria-valuetext', '+0.5 dB')
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(fader).toHaveAttribute('aria-valuetext', '−2.5 dB')
    await waitSaved((document) =>
      expect(document?.layer0[0]).toMatchObject({ volume: Number((10 ** (-2.5 / 20)).toFixed(6)) }),
    )
    await user.dblClick(fader)
    expect(fader).toHaveAttribute('aria-valuetext', '0 dB')
    await user.click(screen.getByRole('button', { name: '静音原声' }))
    expect(fader).toHaveAttribute('aria-valuetext', '静音')
    await user.click(screen.getByRole('button', { name: '取消静音原声' }))
    expect(fader).toHaveAttribute('aria-valuetext', '0 dB')
  })
})

describe('成片编辑器 · 画面轨多选', () => {
  type User = ReturnType<typeof userEvent.setup>

  const shiftClick = async (user: User, segment: number) => {
    await user.keyboard('{Shift>}')
    await user.click(await blockButton(new RegExp(`^选中：第 ${segment} 段`)))
    await user.keyboard('{/Shift}')
  }

  /** 画面轨上按下（选中）的是第几段 */
  const selected = () =>
    within(filmLane())
      .queryAllByRole('button', { name: /^选中：第/, pressed: true })
      .map((button) => Number(/第 (\d+) 段/.exec(button.getAttribute('aria-label') ?? '')?.[1]))

  const playheadSlider = () => screen.getByRole('slider', { name: '时间线播放位置' })

  /** 第 first 到第 last 段都选上：点第一段，再 Shift 逐段扩选 */
  const selectRun = async (user: User, first: number, last: number) => {
    await user.click(await blockButton(new RegExp(`^选中：第 ${first} 段`)))
    for (let segment = first + 1; segment <= last; segment += 1) await shiftClick(user, segment)
  }

  it('Shift 扩选、去掉两端、塌回单选；播放头停在选区开头且暂停；修剪手柄只在选区两端', async () => {
    const user = userEvent.setup()
    // v1 0–2、c1 2–4、v2 4–5.5 秒
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await waitFor(() =>
      expect(document.querySelector('hyperframes-player:not(.is-pending)')).not.toBeNull(),
    )
    const toolbar = screen.getByRole('toolbar', { name: '剪辑工具' })
    await user.click(await blockButton(/^选中：第 3 段/))
    expect(selected()).toEqual([3])
    expect(playheadSlider()).toHaveValue('4')

    // 播放中 Shift 扩选：停下，播放头到选区开头
    await user.click(within(toolbar).getByRole('button', { name: '播放' }))
    expect(within(toolbar).getByRole('button', { name: '暂停' })).toBeVisible()
    await shiftClick(user, 2)
    expect(selected()).toEqual([2, 3])
    expect(within(toolbar).getByRole('button', { name: '播放' })).toBeVisible()
    expect(playheadSlider()).toHaveValue('2')
    expect(within(filmLane()).getAllByRole('slider', { name: '裁剪开头' })).toHaveLength(1)
    expect(within(filmLane()).getAllByRole('slider', { name: '裁剪结尾' })).toHaveLength(1)

    await shiftClick(user, 1)
    expect(selected()).toEqual([1, 2, 3])
    expect(playheadSlider()).toHaveValue('0')

    // 去掉最左、最右；只剩一段时再点它，全部取消
    await shiftClick(user, 1)
    expect(selected()).toEqual([2, 3])
    expect(playheadSlider()).toHaveValue('2')
    await shiftClick(user, 3)
    expect(selected()).toEqual([2])
    expect(within(filmLane()).getAllByRole('slider')).toHaveLength(2)
    // 全部取消时播放头不动
    fireEvent.change(playheadSlider(), { target: { value: '3' } })
    await shiftClick(user, 2)
    expect(selected()).toEqual([])
    expect(within(filmLane()).queryAllByRole('slider')).toHaveLength(0)
    expect(playheadSlider()).toHaveValue('3')

    // Shift 点选区中间的段、不相邻的段：只选那一段
    await selectRun(user, 1, 3)
    await shiftClick(user, 2)
    expect(selected()).toEqual([2])
    await user.click(await blockButton(/^选中：第 1 段/))
    await shiftClick(user, 3)
    expect(selected()).toEqual([3])
  })

  it('组件浮层只在单选时出现：Shift 扩选后收起', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await user.click(await blockButton(/^选中：第 2 段 · 组件/))
    expect(await screen.findByRole('dialog', { name: '组件 · 测试可填项' })).toBeInTheDocument()
    await shiftClick(user, 3)
    expect(selected()).toEqual([2, 3])
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '组件 · 测试可填项' })).not.toBeInTheDocument(),
    )
    // 选了几段时 Shift 点到组件段也不弹
    await shiftClick(user, 1)
    expect(selected()).toEqual([1, 2, 3])
    expect(screen.queryByRole('dialog', { name: '组件 · 测试可填项' })).not.toBeInTheDocument()
  })

  it('Delete 一起删掉选中的几段，撤销一次全部恢复', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await selectRun(user, 1, 2)
    await user.keyboard('{Delete}')
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(1)
    await waitSaved((document) => expect(document?.layer0.map((clip) => clip.id)).toEqual(['v2']))
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '撤销' })).toHaveAttribute('aria-disabled', 'true')
    await waitSaved((document) => expect(document).toEqual(clipsAroundComponent()))
  })

  it('选中的段已不在成片里（撤销掉了）：删除时说明原因，什么也不删', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    await user.click(await within(materials).findByRole('button', { name: /^生成 A 镜头 1，/ }))
    await user.keyboard('{Enter}')
    await within(filmLane()).findByRole('group', { name: /^第 4 段/ })
    await selectRun(user, 1, 2)
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByText(REFUSAL_TEXT['unknown-clip'])).toBeInTheDocument()
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(3)
  })

  it('选中的几段中间插进了新段：⌥→ 说明不相连、挪不动', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await selectRun(user, 1, 2)
    // 播放头放到第 1、2 段之间，素材插进去
    fireEvent.change(playheadSlider(), { target: { value: '2' } })
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    await user.click(await within(materials).findByRole('button', { name: /^生成 A 镜头 1，/ }))
    await user.keyboard('{Enter}')
    await within(filmLane()).findByRole('group', { name: /^第 4 段/ })
    expect(selected()).toEqual([1, 3])
    screen.getByRole('dialog').focus()
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    expect(await screen.findByText(REFUSAL_TEXT['not-contiguous'])).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => clip.id)).toEqual(['v1', 'v3', 'c1', 'v2']),
    )
  })

  it('⌥←/→ 把选中的几段当成一整块前后挪一位，仍然选着这几段', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await selectRun(user, 1, 2)
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => clip.id)).toEqual(['v2', 'v1', 'c1']),
    )
    expect(selected()).toEqual([2, 3])
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => clip.id)).toEqual(['v1', 'c1', 'v2']),
    )
    expect(selected()).toEqual([1, 2])
  })

  it('两端抓手：开头裁第一段、结尾裁最后一段，裁完仍是多选', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await selectRun(user, 1, 2)
    within(filmLane()).getByRole('slider', { name: '裁剪结尾' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(
      within(filmLane()).getByRole('group', { name: '第 2 段 · 组件 · 测试可填项，1.9 秒' }),
    ).toBeInTheDocument()
    within(filmLane()).getByRole('slider', { name: '裁剪开头' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(
      within(filmLane()).getByRole('group', { name: /^第 1 段 .*，1\.9 秒$/ }),
    ).toBeInTheDocument()
    expect(selected()).toEqual([1, 2])
    await waitSaved((document) =>
      expect(document?.layer0.slice(0, 2)).toEqual([
        expect.objectContaining({ id: 'v1', playbackStart: 100, duration: 1_900 }),
        expect.objectContaining({ id: 'c1', start: 1_900, duration: 1_900 }),
      ]),
    )
  })

  it('原声推子显示第一段视频的音量，调了就把选中的视频都设成同一个值，组件段跳过', async () => {
    const user = userEvent.setup()
    const film = draftOf([
      { ...video('v1', TAKE_A, 0, 2_000), volume: 0.5 },
      card('c1', 2_000, { component: 'fixture-fields', variables: { text: '通用' } }),
      { ...video('v2', TAKE_B, 0, 1_500), volume: 2 },
    ])
    putMockWholeFilmDraft(CONVERSATION, film)
    await openEditor()
    const fader = within(screen.getByRole('toolbar', { name: '剪辑工具' })).getByRole('slider', {
      name: '原声',
    })
    await selectRun(user, 1, 3)
    expect(fader).toHaveAttribute('aria-valuetext', '−6 dB')
    fader.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved((document) => {
      const [first, middle, last] = document?.layer0 ?? []
      expect(first).toMatchObject({ volume: Number((10 ** (-5.5 / 20)).toFixed(6)) })
      expect(last).toMatchObject({ volume: first?.type === 'video' ? first.volume : undefined })
      expect(middle).not.toHaveProperty('volume')
    })

    // 只选了组件段：推子置灰
    await user.click(await blockButton(/^选中：第 2 段/))
    expect(fader).toBeDisabled()
  })
})

/** 切到「通用」栏的某个分类，返回卡片网格 */
const generalTab = async (user: ReturnType<typeof userEvent.setup>, category: string) => {
  await user.click(screen.getByRole('tab', { name: '通用' }))
  const chips = await screen.findByRole('radiogroup', { name: '分类' })
  await user.click(within(chips).getByRole('radio', { name: new RegExp(`^${category}\\s*\\d+$`) }))
  return screen.getByRole('list', { name: '组件' })
}

describe('成片编辑器 · 组件', () => {
  it('特效块与组件段的结尾拉不过组件自己的时长，往短里拖照常', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, {
      ...draftOf([
        video('v1', TAKE_A, 0, 2_000),
        card('c1', 2_000, { component: 'fixture-fields' }),
      ]),
      overlays: [{ ...overlayAt('o1', 0, 4_000), component: 'fixture-overlay' }],
    })
    await openEditor()

    // 测试叠加 4 秒：已是组件时长，往长拉不动，往短拖照常
    const overlays = screen.getByRole('group', { name: '特效轨' })
    await user.click(
      capturable(within(overlays).getByRole('button', { name: /^选中：特效 · 测试叠加/ })),
    )
    const overlayEnd = await within(overlays).findByRole('slider', { name: '裁剪结尾' })
    overlayEnd.focus()
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 测试叠加，第 1 行，0.0–4.0 秒' }),
    ).toBeInTheDocument()
    await user.keyboard('{ArrowLeft}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 测试叠加，第 1 行，0.0–3.9 秒' }),
    ).toBeInTheDocument()

    // 测试可填项 5 秒：组件段从 2 秒拉到 5 秒为止
    await user.click(await blockButton(/^选中：第 2 段 · 组件 · 测试可填项/))
    const clipEnd = await within(filmLane()).findByRole('slider', { name: '裁剪结尾' })
    clipEnd.focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')
    expect(
      within(filmLane()).getByRole('group', { name: /^第 2 段 · 组件 · 测试可填项，5\.0 秒$/ }),
    ).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ duration: 5_000, playbackStart: 0 }),
    )
  })

  it('组件库里没有的组件：组件段和特效块都没有修剪手柄', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, {
      ...draftOf([
        video('v1', TAKE_A, 0, 2_000),
        card('c1', 2_000, { component: 'removed-component' }),
      ]),
      overlays: [{ ...overlayAt('o1', 0, 1_000), component: 'removed-component' }],
    })
    await openEditor()
    const overlays = screen.getByRole('group', { name: '特效轨' })
    await user.click(capturable(within(overlays).getByRole('button', { name: /^选中：特效 · / })))
    expect(within(overlays).queryByRole('slider', { name: /^裁剪/ })).not.toBeInTheDocument()
    await user.click(await blockButton(/^选中：第 2 段 · 组件/))
    expect(within(filmLane()).getAllByRole('button', { pressed: true })).toHaveLength(1)
    expect(within(filmLane()).queryByRole('slider', { name: /^裁剪/ })).not.toBeInTheDocument()
  })

  it('放进成片后选中新片段；有可填项的组件随即打开浮层，没有的不弹', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const fields = await generalTab(user, '文字效果')
    await user.click(within(fields).getByRole('button', { name: /^测试可填项，/ }))
    const popover = await screen.findByRole('dialog', { name: '特效 · 测试可填项' })
    // 时长是组件自己的 5 秒，与成片多长无关
    expect(
      screen.getByRole('group', { name: '特效 · 测试可填项，第 1 行，0.0–5.0 秒' }),
    ).toBeInTheDocument()
    expect(within(popover).getByLabelText('文字')).toHaveAttribute('placeholder', '示例文字')
    expect(screen.getByRole('button', { name: /^选中：特效 · 测试可填项/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    const scenes = await generalTab(user, '场景')
    await user.click(within(scenes).getByRole('button', { name: /^测试画面，画面轨/ }))
    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(
      within(filmLane()).getByRole('button', { name: /^选中：第 \d 段 · 组件 · 测试画面/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('dialog', { name: /测试画面/ })).not.toBeInTheDocument()
  })

  it('字幕轨标题显示当前样式名；下拉菜单每项带预览图，选了就换样式并存进草稿', async () => {
    const user = userEvent.setup()
    // 测试组件库只有一种字幕样式，再补一种
    serveCatalog({
      ...fixtureCatalog,
      items: [
        ...fixtureCatalog.items,
        {
          ...fixtureItem('default-caption'),
          name: 'other-caption',
          title: '另一种字幕',
          thumbnail: 'other-caption.svg',
        },
      ],
    })
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const trigger = screen.getByRole('button', { name: /^字幕样式：测试字幕/ })
    expect(trigger).toHaveTextContent('测试字幕')
    await user.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: '测试字幕' })).toBeChecked()
    const other = screen.getByRole('menuitemradio', { name: '另一种字幕' })
    // 预览图是装饰性的（alt 为空），取这一版组件库里的封面
    expect(other.querySelector('img')).toHaveAttribute(
      'src',
      `/hyperframes/${fixtureCatalog.version}/thumbnails/other-caption.svg`,
    )
    await user.click(other)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const changed = screen.getByRole('button', { name: /^字幕样式：另一种字幕/ })
    expect(changed).toHaveFocus()
    expect(changed).toHaveTextContent('另一种字幕')
    await waitSaved((document) => expect(document?.captions.component).toBe('other-caption'))
  })

  it('字幕样式有字体项时菜单里另有一组「字体」：选了存进字幕的可填项，换到没有字体项的样式也留着', async () => {
    const user = userEvent.setup()
    // 组装工具给读字体变量的测试字幕加上字体项；源目录的组件目录里没有，这里补上
    serveCatalog({
      ...fixtureCatalog,
      items: [
        ...fixtureCatalog.items.map((item) =>
          item.name === 'default-caption'
            ? {
                ...item,
                variables: [{ id: 'font', type: 'font' as const, label: '字体', default: '' }],
              }
            : item,
        ),
        { ...fixtureItem('default-caption'), name: 'other-caption', title: '另一种字幕' },
      ],
    })
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: /^字幕样式：测试字幕/ }))
    const fonts = screen.getByRole('group', { name: '字体' })
    expect(
      within(fonts)
        .getAllByRole('menuitemradio')
        .map((option) => option.textContent),
    ).toEqual(['默认', '示例品牌'])
    expect(within(fonts).getByRole('menuitemradio', { name: '默认' })).toBeChecked()
    await user.click(within(fonts).getByRole('menuitemradio', { name: '示例品牌' }))
    await waitSaved((document) =>
      expect(document?.captions.variables).toEqual({ font: 'Playfair Display' }),
    )

    await user.click(screen.getByRole('button', { name: /^字幕样式：测试字幕/ }))
    expect(
      within(screen.getByRole('group', { name: '字体' })).getByRole('menuitemradio', {
        name: '示例品牌',
      }),
    ).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: '另一种字幕' }))
    await waitSaved((document) =>
      expect(document?.captions).toMatchObject({
        component: 'other-caption',
        variables: { font: 'Playfair Display' },
      }),
    )
    await user.click(screen.getByRole('button', { name: /^字幕样式：另一种字幕/ }))
    expect(screen.queryByRole('group', { name: '字体' })).not.toBeInTheDocument()
  })

  /** 点开草稿里两段视频中间的那段组件（测试可填项）的浮层 */
  const openSegment = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await blockButton(/选中：第 2 段 · 组件 · 测试可填项/))
    return screen.findByRole('dialog', { name: '组件 · 测试可填项' })
  }

  it('清空填过的文字：回到组件的默认字，草稿里不再存这一项', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    const name = within(await openSegment(user)).getByLabelText('文字')
    await user.clear(name)
    await user.type(name, '{Enter}')
    await waitSaved((document) =>
      expect(document?.layer0[1]).toEqual(expect.objectContaining({ variables: {} })),
    )
  })

  it('撤销改字：回到改之前的那一版，并存回服务端', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    const { close } = await openEditor()
    const name = within(await openSegment(user)).getByLabelText('文字')
    await user.clear(name)
    await user.type(name, '城市{Enter}')
    // 改过的那一版先存上，撤销才会再产生一次保存
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ variables: { text: '城市' } }),
    )
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(await openSegment(user)).getByLabelText('文字')).toHaveValue('通用')
    // 关掉编辑器时立即保存，不必再等 0.8 秒
    close()
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ variables: { text: '通用' } }),
    )
  })

  it('浮层里移除组件段，后面的段跟着前移', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    await user.click(within(await openSegment(user)).getByRole('button', { name: '移除' }))
    expect(within(filmLane()).queryByRole('group', { name: /组件/ })).not.toBeInTheDocument()
    expect(
      within(filmLane()).getByRole('group', { name: /^第 2 段 · B .*，1\.5 秒$/ }),
    ).toBeInTheDocument()
  })

  describe('字幕轨', () => {
    const older = makeGenerationJob({
      kind: 'subtitle',
      createdAt: '2026-09-01T10:10:00Z',
      sourceJobId: TAKE_A,
      sentences: [{ startMs: 200, endMs: 1_200, speaker: null, text: '旧的识别', words: [] }],
    })
    const latest = makeGenerationJob({
      id: 'dddddddd-eeee-4fff-8000-111111111111',
      kind: 'subtitle',
      createdAt: '2026-09-01T10:20:00Z',
      sourceJobId: TAKE_A,
      sentences: [{ startMs: 200, endMs: 1_200, speaker: null, text: '你好世界', words: [] }],
    })

    it('按来源提交一次，处理中不能重复提交；重新识别完成前保留已有字幕', async () => {
      const user = userEvent.setup()
      const records = [...takes]
      const submitted: SubtitleIn[] = []
      putMockWholeFilmDraft(
        CONVERSATION,
        draftOf([
          video('v1', TAKE_A, 0, 2_000),
          video('v2', TAKE_A, 2_000, 1_000),
          video('v3', TAKE_B, 0, 1_500),
        ]),
      )
      server.use(
        http.post('*/api/generations/subtitles', async ({ request }) => {
          const body = (await request.json()) as SubtitleIn
          submitted.push(body)
          const generation = makeGenerationJob({
            kind: 'subtitle',
            sourceJobId: body.sourceJobId,
            status: 'pending',
            createdAt: new Date(Date.now() + submitted.length).toISOString(),
          })
          records.push(generation)
          return HttpResponse.json({ generation }, { status: 202 })
        }),
      )
      const { queryClient } = await openEditor(records)
      const action = screen.getByRole('button', { name: '识别字幕' })
      await waitFor(() => expect(action).toBeEnabled())
      await user.dblClick(action)
      await waitFor(() => expect(submitted).toHaveLength(2))
      expect(submitted).toEqual([
        { conversationId: CONVERSATION, sourceJobId: TAKE_A, taskId: null },
        { conversationId: CONVERSATION, sourceJobId: TAKE_B, taskId: null },
      ])
      expect(action).toBeDisabled()
      expect(action).toHaveAttribute('aria-busy', 'true')

      for (const job of records.filter((job) => job.kind === 'subtitle')) {
        job.status = 'completed'
        job.sentences = job.sourceJobId === TAKE_A ? latest.sentences : []
      }
      await queryClient.invalidateQueries({ queryKey: wholeFilmQueryKeys.subtitles(CONVERSATION) })
      const lane = screen.getByRole('group', { name: '字幕轨' })
      expect(
        await within(lane).findByRole('button', { name: '字幕：你好世界，点此改字' }),
      ).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '重新识别字幕' }))
      await waitFor(() => expect(submitted).toHaveLength(4))
      expect(
        within(lane).getByRole('button', { name: '字幕：你好世界，点此改字' }),
      ).toBeInTheDocument()
      expect(action).toBeDisabled()
    })

    it('提交中断时显示具体原因，保留已成功的字幕，再次点击补齐未识别的视频', async () => {
      const user = userEvent.setup()
      const records = [...takes]
      const sources: string[] = []
      putMockWholeFilmDraft(CONVERSATION, twoClips())
      server.use(
        http.post('*/api/generations/subtitles', async ({ request }) => {
          const body = (await request.json()) as SubtitleIn
          sources.push(body.sourceJobId)
          if (body.sourceJobId === TAKE_B && sources.filter((id) => id === TAKE_B).length === 1)
            return HttpResponse.json({ detail: '识别服务暂不可用' }, { status: 503 })
          const generation = makeGenerationJob({
            kind: 'subtitle',
            sourceJobId: body.sourceJobId,
            sentences: body.sourceJobId === TAKE_A ? latest.sentences : [],
          })
          records.push(generation)
          return HttpResponse.json({ generation }, { status: 202 })
        }),
      )
      await openEditor(records)
      const action = screen.getByRole('button', { name: '识别字幕' })
      await waitFor(() => expect(action).toBeEnabled())
      await user.click(action)
      expect(await screen.findByText(/识别服务暂不可用.*提交已中断/)).toBeInTheDocument()
      await waitFor(() => expect(action).toBeEnabled())
      const lane = screen.getByRole('group', { name: '字幕轨' })
      expect(
        within(lane).getByRole('button', { name: '字幕：你好世界，点此改字' }),
      ).toBeInTheDocument()
      await user.click(action)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '重新识别字幕' })).toBeEnabled(),
      )
      expect(sources).toEqual([TAKE_A, TAKE_B, TAKE_B])
    })

    it('提交报错后重读真实失败记录，用户点击重试才再次提交', async () => {
      const user = userEvent.setup()
      const records = [...takes, latest]
      let submissions = 0
      putMockWholeFilmDraft(CONVERSATION, draftOf([video('v1', TAKE_A, 0, 2_000)]))
      server.use(
        http.post('*/api/generations/subtitles', () => {
          const failed = ++submissions === 1
          const generation = makeGenerationJob({
            ...latest,
            id: crypto.randomUUID(),
            createdAt: new Date(Date.now() + submissions).toISOString(),
            status: failed ? 'failed' : 'completed',
            errorMessage: failed ? '识别任务未能排队' : null,
          })
          records.push(generation)
          return failed
            ? HttpResponse.json({ detail: '识别任务未能排队' }, { status: 503 })
            : HttpResponse.json({ generation }, { status: 202 })
        }),
      )
      await openEditor(records)
      await user.click(await screen.findByRole('button', { name: '重新识别字幕' }))
      const retry = await screen.findByRole('button', { name: '重试字幕识别' })
      expect(submissions).toBe(1)
      expect(
        within(screen.getByRole('group', { name: '字幕轨' })).getByRole('status'),
      ).toHaveTextContent('识别任务未能排队')
      await waitFor(() => expect(retry).toBeEnabled())
      await user.click(retry)
      await screen.findByRole('button', { name: '重新识别字幕' })
      expect(submissions).toBe(2)
    })

    it.each(['pending', 'submitting', 'submitted'] as const)(
      '只要当前视频还有 %s 记录就禁用识别，其他视频不影响',
      async (status) => {
        const records = [
          ...takes,
          latest,
          makeGenerationJob({ kind: 'subtitle', sourceJobId: TAKE_B, status }),
        ]
        putMockWholeFilmDraft(CONVERSATION, draftOf([video('v1', TAKE_A, 0, 2_000)]))
        const { queryClient } = await openEditor(records)
        expect(await screen.findByRole('button', { name: '重新识别字幕' })).toBeEnabled()
        records.push({ ...older, status })
        await queryClient.invalidateQueries({
          queryKey: wholeFilmQueryKeys.subtitles(CONVERSATION),
        })
        expect(await screen.findByRole('button', { name: '识别字幕' })).toBeDisabled()
        expect(screen.getByRole('button', { name: '字幕：你好世界，点此改字' })).toBeInTheDocument()
      },
    )

    it.each(['字幕记录', '对话信息'] as const)(
      '%s 读取失败时重试只重读，不提交识别',
      async (resource) => {
        const user = userEvent.setup()
        putMockWholeFilmDraft(CONVERSATION, twoClips())
        const { queryClient } = await openEditor([...takes, { ...latest, status: 'submitted' }])
        let failed = true
        const submissions: unknown[] = []
        server.use(
          http.get('*/api/generations', ({ request }) =>
            resource === '字幕记录' &&
            new URL(request.url).searchParams.get('kind') === 'subtitle' &&
            failed
              ? HttpResponse.json({ detail: '字幕记录读取失败' }, { status: 503 })
              : undefined,
          ),
          http.get('*/api/conversations/:conversationId', () =>
            resource === '对话信息' && failed
              ? HttpResponse.json({ detail: '对话信息读取失败' }, { status: 503 })
              : undefined,
          ),
          http.post('*/api/generations/subtitles', async ({ request }) => {
            submissions.push(await request.json())
            return HttpResponse.json({ detail: '不应提交识别' }, { status: 500 })
          }),
        )
        await queryClient.invalidateQueries({
          queryKey:
            resource === '字幕记录'
              ? wholeFilmQueryKeys.subtitles(CONVERSATION)
              : wholeFilmQueryKeys.task(CONVERSATION),
        })
        const retry = await screen.findByRole('button', { name: `重新读取${resource}` })
        expect(retry).toBeEnabled()
        failed = false
        await user.click(retry)
        expect(await screen.findByRole('button', { name: '识别字幕' })).toBeDisabled()
        expect(submissions).toEqual([])
      },
    )

    it('无口播属于已完成结果，保留重新识别入口', async () => {
      putMockWholeFilmDraft(CONVERSATION, draftOf([video('v1', TAKE_A, 0, 2_000)]))
      await openEditor([...takes, { ...older, status: 'failed' }, { ...latest, sentences: [] }])
      expect(await screen.findByRole('button', { name: '重新识别字幕' })).toBeEnabled()
      expect(
        within(screen.getByRole('group', { name: '字幕轨' })).getByRole('status'),
      ).toHaveTextContent('未识别到口播')
    })

    it('按最新的字幕记录放字幕；点一块改整句，回车后自动保存', async () => {
      const user = userEvent.setup()
      putMockWholeFilmDraft(CONVERSATION, twoClips())
      await openEditor([...takes, latest, older])
      const lane = screen.getByRole('group', { name: '字幕轨' })
      await user.click(
        await within(lane).findByRole('button', { name: '字幕：你好世界，点此改字' }),
      )
      const input = within(lane).getByRole('textbox')
      expect(input).toHaveValue('你好世界')
      await user.clear(input)
      await user.type(input, '你好，成片{Enter}')
      expect(
        await within(lane).findByRole('button', { name: '字幕：你好，成片，点此改字' }),
      ).toBeInTheDocument()
      await waitSaved((document) =>
        expect(document?.captions.edits).toEqual([
          { subtitleJobId: latest.id, sentenceIndex: 0, text: '你好，成片' },
        ]),
      )
    })

    it('把改过的字清空：回到识别结果，并存回服务端', async () => {
      const user = userEvent.setup()
      putMockWholeFilmDraft(CONVERSATION, {
        ...twoClips(),
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: latest.id, sentenceIndex: 0, text: '你好，成片' }],
        },
      })
      await openEditor([...takes, latest, older])
      const lane = screen.getByRole('group', { name: '字幕轨' })
      await user.click(
        await within(lane).findByRole('button', { name: '字幕：你好，成片，点此改字' }),
      )
      await user.clear(within(lane).getByRole('textbox'))
      await user.keyboard('{Enter}')
      expect(
        await within(lane).findByRole('button', { name: '字幕：你好世界，点此改字' }),
      ).toBeInTheDocument()
      await waitSaved((document) => expect(document?.captions.edits).toEqual([]))
    })
  })
})

describe('成片编辑器 · 导出', () => {
  const EXPORT_ID = '22222222-3333-4444-8555-666666666666'
  const EXPORTS_URL = '*/api/conversations/:conversationId/whole-film/exports'
  const EXPORT_URL = '*/api/conversations/:conversationId/whole-film/exports/:exportId'
  const LATEST_URL = '*/api/conversations/:conversationId/whole-film/exports/latest'
  const DOWNLOAD_URL = 'https://oss.example.com/whole-film/export.mp4'

  /** 一次导出现在的样子；没给的字段同还没交给渲染服务的排队 */
  const exportOf = (state: object) => ({
    id: EXPORT_ID,
    status: 'queued',
    progress: null,
    queuePosition: null,
    error: null,
    downloadUrl: null,
    sourceJobIds: [TAKE_A, TAKE_B],
    ...state,
  })

  /** 最近一次导出：第一个是打开编辑器时读到的，之后每次读给下一个，读完停在最后一个；null 是没导出过 */
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

  /** 记下发出的取消 */
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

  it('打开编辑器时最近一次导出还没结束：接着显示进度，关掉编辑器不取消它', async () => {
    const cancelled = trackCancels()
    serveLatest({ status: 'rendering', progress: null }, RENDERING)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    const { close } = await openEditor()
    expect(await screen.findByText('正在渲染…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
    expect(
      await screen.findByText('正在渲染 40%', undefined, { timeout: 3_000 }),
    ).toBeInTheDocument()
    close()
    // 取消若在卸载时发出，这段时间足够它到达 mock
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(cancelled).toEqual([])
  })

  it('打开编辑器时最近一次导出已完成：直接可以下载', async () => {
    serveLatest(DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
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
    putMockWholeFilmDraft(CONVERSATION, twoClips())
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
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '取消导出' }))
    expect(await screen.findByText(/正在交给渲染服务，稍后再取消/)).toBeInTheDocument()
    expect(screen.getByText('正在渲染 40%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
  })

  it('提交时草稿已有更新的一版：存好手上的再提交一次', async () => {
    const user = userEvent.setup()
    const revisions: unknown[] = []
    server.use(
      http.post(EXPORTS_URL, async ({ request }) => {
        const body = (await request.json()) as { revision: number }
        revisions.push(body.revision)
        return revisions.length === 1
          ? HttpResponse.json(
              { detail: '成片草稿已经有更新的一版，重新读取后再导出' },
              { status: 409 },
            )
          : HttpResponse.json({ exportId: EXPORT_ID, sourceJobIds: [TAKE_A] }, { status: 202 })
      }),
    )
    serveLatest(null, DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('button', { name: '下载成片' })).toBeInTheDocument()
    const stored = mockWholeFilmDraft(CONVERSATION)?.revision
    expect(revisions).toEqual([stored, stored])
  })

  it('没开通（422）：显示原因，可以重新导出', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(EXPORTS_URL, () =>
        HttpResponse.json({ detail: '成片导出没有开通' }, { status: 422 }),
      ),
    )
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText(/：成片导出没有开通$/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it.each([
    ['渲染服务报的原因', 'media-unreachable', 'ECONNRESET', '有素材读不到，请稍后重新导出'],
    ['渲染服务重启过', 'RENDER_LOST', 'render service restarted', '渲染服务重启过，请重新导出'],
    ['交出去太久没结束', 'PROVIDER_TIMEOUT', 'no end after 6 h', '排队太久，请重新导出'],
    ['渲染服务连不上', 'RENDER_UNAVAILABLE', 'connect refused', '渲染服务连不上，请稍后重新导出'],
    ['没见过的错误码', 'SUBMIT_INTERRUPTED', 'worker restarted', '成片导出失败，请重新导出'],
  ])('导出失败（%s）：按原因说一句话，不露给开发看的原文', async (_, code, message, text) => {
    serveLatest({ status: 'failed', error: { code, message } })
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status')
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('渲染服务不收这份草稿：显示它给的原因', async () => {
    serveLatest({
      status: 'failed',
      error: { code: 'RENDER_REJECTED', message: '组件 logo-x 不在组件库里' },
    })
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    expect(await screen.findByText(/组件 logo-x 不在组件库里$/)).toHaveAttribute('role', 'status')
  })
})

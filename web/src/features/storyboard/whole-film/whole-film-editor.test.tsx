import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { playerCalls } from '@/testing/hyperframes-player'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { renderWithProviders } from '@/testing/render'
import { card, draftOf, video } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { WholeFilmEditor } from './whole-film-editor'

// jsdom 读不了真文件：mediabunny 换成按地址给关键帧表、时长与画面尺寸的替身；没有原声轨。
const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())

// 拍点分析换成给定的结果；解码由各用例按需替换 OfflineAudioContext
const beats = vi.hoisted(() => ({ analyze: vi.fn() }))
vi.mock('@hyperframes/core/beats', () => ({ analyzeMusicFromBuffer: beats.analyze }))

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
    getPrimaryVideoTrack = () =>
      Promise.resolve({
        url: this.url,
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
  class AudioSampleSink {}
  return { AudioSampleSink, EncodedPacketSink, Input, MP4: {}, QTFF: {}, UrlSource }
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

const song = makeGenerationJob({
  id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  kind: 'audio',
  createdAt: '2026-09-01T11:00:00Z',
  outputUrl: MUSIC_URL,
  durationMs: 30_000,
  request: { prompt: '轻快原声吉他' },
})

/** 这段对话的生成记录；按 kind 筛，与后端同一口径 */
const serveGenerations = (records: GenerationJob[]) =>
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({
        items: records.filter((job) => kind === null || job.kind === kind),
      })
    }),
    http.get('*/api/conversations/:conversationId', () =>
      HttpResponse.json({ detail: '不需要读对话' }, { status: 404 }),
    ),
  )

const openEditor = async (records: GenerationJob[] = takes) => {
  serveGenerations(records)
  const onClose = vi.fn()
  const rendered = await renderWithProviders(
    <>
      <WholeFilmEditor conversationId={CONVERSATION} onClose={onClose} />
      <Toaster />
    </>,
  )
  await screen.findByRole('group', { name: '整片编辑器' })
  /** 关掉编辑器：页面上不再渲染它 */
  const close = () => rendered.rerender(<Toaster />)
  return { onClose, close }
}

const filmLane = () => screen.getByRole('group', { name: '成片画面轨' })

// jsdom 没有指针捕获，按下轨道上的块时组件会捕获指针，这里补上。
const capturable = (element: HTMLElement) =>
  Object.assign(element, {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })

/** 成片区里的一块（选中按钮）；名字以选中：开头 */
const blockButton = async (name: RegExp) =>
  capturable(await within(filmLane()).findByRole('button', { name }))

const savedDraft = () => mockWholeFilmDraft(CONVERSATION)?.document

/** 保存是停下 0.8 秒后才发 */
const waitSaved = (check: (document: WholeFilmDocument | undefined) => void) =>
  waitFor(() => check(savedDraft()), { timeout: 4000 })

const twoClips = () => draftOf([video('v1', TAKE_A, 0, 2_000), video('v2', TAKE_B, 0, 1_500)])

/** 组件目录里的片头片尾：card() 的组件名不在目录里，换成目录里的 */
const catalogCard = (...args: Parameters<typeof card>) => {
  const clip = card(...args)
  return { ...clip, component: clip.role === 'intro' ? 'logo-sting' : 'logo-brand-close' }
}

/** 片头 0–2 秒，后面两段 */
const introAndTwoClips = () =>
  draftOf([
    catalogCard('c1', 'intro', 2_000, { wordmark: '示例品牌' }),
    video('v1', TAKE_A, 0, 2_000),
    video('v2', TAKE_B, 0, 1_500),
  ])

/** 两段之后接片尾，品牌名填的是「通用」 */
const twoClipsAndOutro = () =>
  draftOf([
    video('v1', TAKE_A, 0, 2_000),
    video('v2', TAKE_B, 0, 1_500),
    catalogCard('c1', 'outro', 2_000, { wordmark: '通用' }),
  ])

describe('整片编辑器', () => {
  it('素材区按镜头组、原作分轨', async () => {
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    expect(within(materials).getByText('镜头组 1')).toBeInTheDocument()
    expect(within(materials).getByText('生成 A')).toBeInTheDocument()
    expect(within(materials).getByText('生成 B')).toBeInTheDocument()
  })

  it('点一个镜头再「加入成片」，成片轨多一段并自动保存', async () => {
    const user = userEvent.setup()
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    await user.click(
      await within(materials).findByRole('button', { name: /生成 A 镜头 2，2\.0–4\.5 秒/ }),
    )
    expect(within(materials).getByText('拖动两端调整范围 2.0–4.5 秒')).toBeInTheDocument()
    await user.click(within(materials).getByRole('button', { name: '加入成片' }))

    expect(
      await within(filmLane()).findByRole('group', { name: '第 1 段 · A · 镜头 2，2.5 秒' }),
    ).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.layer0).toEqual([
        expect.objectContaining({
          type: 'video',
          start: 0,
          duration: 2_500,
          playbackStart: 2_000,
          sourceJobId: TAKE_A,
        }),
      ]),
    )
    expect(savedDraft()?.canvas).toEqual({ width: 720, height: 1280 })
  })

  it('没选范围时「加入成片」说明原因', async () => {
    await openEditor()
    const add = await screen.findByRole('button', { name: '加入成片' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
  })

  it('修剪、拆分、删除各记一步，可以逐步撤销', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()

    await user.click(await blockButton(/选中：第 1 段 · A · 镜头 1，2\.0 秒/))
    const end = await within(filmLane()).findByRole('slider', { name: '裁剪该段结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    expect(
      within(filmLane()).getByRole('group', { name: /^第 1 段 .*，1\.9 秒$/ }),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: '拆分' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(3)

    await user.click(await blockButton(/选中：第 3 段/))
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(
      within(filmLane()).getByRole('group', { name: /^第 1 段 .*，2\.0 秒$/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toHaveAttribute('aria-disabled', 'true')
    await waitSaved((document) => expect(document).toEqual(twoClips()))
  })

  it('别处存过更新的一版：换成那一版并说明', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    putMockWholeFilmDraft(CONVERSATION, draftOf([video('v1', TAKE_B, 0, 3_000)]))

    await user.click(await blockButton(/选中：第 2 段/))
    await user.click(screen.getByRole('button', { name: '删除' }))

    expect(
      await screen.findByText(
        '整片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃',
        undefined,
        { timeout: 4000 },
      ),
    ).toBeInTheDocument()
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(1)
    expect(
      within(filmLane()).getByRole('group', { name: /^第 1 段 · B .*，3\.0 秒$/ }),
    ).toBeInTheDocument()
  })

  it('素材栏列出这段对话的音乐，「用这首」放到音乐轨上', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor([...takes, song])
    const list = await screen.findByRole('list', { name: '这段对话的音乐' })
    expect(within(list).getByText('轻快原声吉他')).toBeInTheDocument()
    expect(within(list).getByText('生成 · 30 秒')).toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: '用这首：轻快原声吉他' }))
    expect(within(list).getByText('在用')).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: '音乐 · 轻快原声吉他，从歌里 0.0 秒起' }),
    ).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.music).toEqual({ jobId: song.id, offset: 0, volume: 1 }),
    )
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
    )
    await openEditor(records)
    await screen.findByText('这段对话还没有音乐，可以点「生成」或「上传」')

    await user.upload(
      screen.getByLabelText('选择音乐文件'),
      new File(['wav'], 'bgm.wav', { type: 'audio/wav' }),
    )
    const list = await screen.findByRole('list', { name: '这段对话的音乐' })
    expect(within(list).getByText(/^上传的音乐 · /)).toBeInTheDocument()
    expect(confirms).toEqual([{ conversationId: CONVERSATION }])
  })

  it('成片里还没有画面：播放、导出置灰并说明原因；没选音乐时自动卡点置灰', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('成片里还没有画面；加入视频后可以在这里预览')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '播放' })).toHaveAttribute('aria-disabled', 'true')
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.hover(exportButton)
    expect(
      (await screen.findAllByText('成片里还没有画面，无法导出；请先加入视频')).length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '自动卡点' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.queryByText(/组件库还没接入/)).not.toBeInTheDocument()
  })

  it('预览：播放器拿到这份草稿的合成页；工具条播放、暂停，点时间线跳到那里', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const player = await waitFor(() => {
      // 新页在底下加载好才换上来：等到显示中的那个播放器
      const element = document.querySelector('hyperframes-player:not(.is-pending)')
      expect(element?.getAttribute('srcdoc')).toContain('data-composition-id="main"')
      return element
    })
    expect(player?.getAttribute('srcdoc')).toContain(`src="${URL_A}"`)
    expect(player?.getAttribute('srcdoc')).toContain(
      '<base href="http://localhost:3000/hyperframes/',
    )

    playerCalls.length = 0
    await user.click(screen.getByRole('button', { name: '播放' }))
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '1.5' },
    })
    expect(playerCalls).toEqual(['play', 'seek 1.5', 'play'])
    await user.click(screen.getByRole('button', { name: '暂停' }))
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument()
  })
})

const componentsTab = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('tab', { name: '组件' }))
  return screen.findByRole('list', { name: '组件' })
}

describe('整片编辑器 · 组件', () => {
  it('组件栏按分类筛选：选「字幕」只列字幕组件，选「全部」列回全部', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const list = await componentsTab(user)
    const all = within(list).getAllByRole('button').length
    const chips = screen.getByRole('radiogroup', { name: '组件分类' })
    await user.click(within(chips).getByRole('radio', { name: /^字幕\s*3$/ }))
    expect(within(list).getAllByRole('button')).toHaveLength(3)
    await user.click(within(chips).getByRole('radio', { name: /^全部/ }))
    expect(within(list).getAllByRole('button')).toHaveLength(all)
  })

  it('点片头卡片：放在最前、2 秒，可填项取组件默认值；卡片标出「片头在用」', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const list = await componentsTab(user)
    await user.click(within(list).getByRole('button', { name: /^字标定格，片头/ }))
    expect(
      await within(filmLane()).findByRole('group', { name: '片头 · 字标定格，2.0 秒' }),
    ).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /^字标定格，片头/ })).toHaveTextContent(
      '片头在用',
    )
    await waitSaved((document) => {
      expect(document?.layer0[0]).toMatchObject({
        type: 'component',
        role: 'intro',
        component: 'logo-sting',
        duration: 2_000,
      })
      expect(document?.layer0[0]).toHaveProperty('variables', {})
    })
  })

  it('点转场卡片、什么都没选：放到离播放头最近的切点', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, introAndTwoClips())
    await openEditor()
    const list = await componentsTab(user)
    // 播放头在 0 秒，离它最近的切点是片头结束处
    await user.click(within(list).getByRole('button', { name: /^淡入淡出，两段之间/ }))
    expect(
      await within(filmLane()).findByRole('button', { name: '选中：转场 · 淡入淡出' }),
    ).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.transitions).toEqual([
        { id: 't1', afterClipId: 'c1', component: 'fade-through', duration: 900, variables: {} },
      ]),
    )
  })

  it('点转场卡片、选中了一段：放到这一段后面的切点', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, introAndTwoClips())
    await openEditor()
    const list = await componentsTab(user)
    await user.click(await blockButton(/选中：第 1 段/))
    await user.click(within(list).getByRole('button', { name: /^淡入淡出，两段之间/ }))
    expect(
      await within(filmLane()).findByRole('button', { name: '选中：转场 · 淡入淡出' }),
    ).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.transitions).toEqual([
        { id: 't1', afterClipId: 'v1', component: 'fade-through', duration: 900, variables: {} },
      ]),
    )
  })

  it('点包装卡片：从播放头处开始，取组件自带的时长', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, introAndTwoClips())
    await openEditor()
    const list = await componentsTab(user)
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '0.5' },
    })
    await user.click(within(list).getByRole('button', { name: /^手绘箭头，包装轨/ }))
    expect(screen.getByRole('group', { name: '包装 · 手绘箭头，0.5–4.5 秒' })).toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.overlays).toEqual([
        { id: 'o1', component: 'hw-arrow', start: 500, duration: 4_000, variables: {} },
      ]),
    )
  })

  it('字幕样式按钮：到组件栏的「字幕」分类，点字幕卡片换样式', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: /^字幕样式：白字黑边/ }))
    const list = await screen.findByRole('list', { name: '组件' })
    const chips = screen.getByRole('radiogroup', { name: '组件分类' })
    expect(within(chips).getByRole('radio', { name: /^字幕/ })).toBeChecked()
    await user.click(within(list).getByRole('button', { name: /^高亮字幕，字幕样式/ }))
    expect(screen.getByRole('button', { name: /^字幕样式：高亮字幕/ })).toBeInTheDocument()
    await waitSaved((document) => expect(document?.captions.component).toBe('caption-highlight'))
  })

  it('画面轨两端的「+ 片头」「+ 片尾」：到组件栏只看那一端的组件；那一端有了就不再显示', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(within(filmLane()).getByRole('button', { name: '+ 片尾' }))
    const list = await screen.findByRole('list', { name: '组件' })
    const cards = within(list).getAllByRole('button')
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) expect(card).toHaveAccessibleName(/，片尾：/)
    expect(screen.getByText(/^只看片尾组件 · \d+ 个$/)).toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: /^字标逐字，片尾/ }))
    expect(within(filmLane()).queryByRole('button', { name: '+ 片尾' })).not.toBeInTheDocument()
    await user.click(within(filmLane()).getByRole('button', { name: '+ 片头' }))
    for (const card of within(list).getAllByRole('button'))
      expect(card).toHaveAccessibleName(/，片头：/)
    await user.click(screen.getByRole('button', { name: '看全部' }))
    expect(
      within(screen.getByRole('radiogroup', { name: '组件分类' })).getByRole('radio', {
        name: /^全部/,
      }),
    ).toBeChecked()
  })

  /** 组件栏里点「字标逐字」加片尾，再点开它的浮层 */
  const addOutroAndOpen = async (user: ReturnType<typeof userEvent.setup>) => {
    const list = await componentsTab(user)
    await user.click(within(list).getByRole('button', { name: /^字标逐字，片尾/ }))
    await user.click(await blockButton(/选中：片尾 · 字标逐字/))
    return screen.findByRole('dialog', { name: '片尾 · 字标逐字' })
  }

  /** 草稿里已有的片尾，点开它的浮层 */
  const openOutro = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await blockButton(/选中：片尾 · 字标逐字/))
    return screen.findByRole('dialog', { name: '片尾 · 字标逐字' })
  }

  it('点开片尾：列出全部可填项，没填过的显示组件默认值', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const popover = await addOutroAndOpen(user)
    expect(within(popover).getByLabelText('品牌名')).toHaveValue('品牌名')
    expect(within(popover).getByLabelText('标语')).toHaveValue('品牌标语')
    expect(within(popover).getByLabelText('网址')).toHaveValue('网址')
    expect(within(popover).getByText('只影响这条整片')).toBeInTheDocument()
  })

  it('改可填项回车即是一步编辑，自动保存', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClipsAndOutro())
    await openEditor()
    const name = within(await openOutro(user)).getByLabelText('品牌名')
    await user.clear(name)
    await user.type(name, '拾步{Enter}')
    await waitSaved((document) =>
      expect(document?.layer0.at(-1)).toMatchObject({ variables: { wordmark: '拾步' } }),
    )
  })

  it('撤销改字：回到改之前的那一版，并存回服务端', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClipsAndOutro())
    const { close } = await openEditor()
    const name = within(await openOutro(user)).getByLabelText('品牌名')
    await user.clear(name)
    await user.type(name, '拾步{Enter}')
    // 改过的那一版先存上，撤销才会再产生一次保存
    await waitSaved((document) =>
      expect(document?.layer0.at(-1)).toMatchObject({ variables: { wordmark: '拾步' } }),
    )
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(await openOutro(user)).getByLabelText('品牌名')).toHaveValue('通用')
    // 关掉编辑器时立即保存，不必再等 0.8 秒
    close()
    await waitSaved((document) =>
      expect(document?.layer0.at(-1)).toMatchObject({ variables: { wordmark: '通用' } }),
    )
  })

  it('浮层里移除片尾', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClipsAndOutro())
    await openEditor()
    await user.click(within(await openOutro(user)).getByRole('button', { name: '移除片尾' }))
    expect(within(filmLane()).queryByRole('group', { name: /^片尾/ })).not.toBeInTheDocument()
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
      await user.type(input, '你好，整片{Enter}')
      expect(
        await within(lane).findByRole('button', { name: '字幕：你好，整片，点此改字' }),
      ).toBeInTheDocument()
      await waitSaved((document) =>
        expect(document?.captions.edits).toEqual([
          { subtitleJobId: latest.id, sentenceIndex: 0, text: '你好，整片' },
        ]),
      )
    })

    it('把改过的字清空：回到识别结果，并存回服务端', async () => {
      const user = userEvent.setup()
      putMockWholeFilmDraft(CONVERSATION, {
        ...twoClips(),
        captions: {
          component: 'default-caption',
          edits: [{ subtitleJobId: latest.id, sentenceIndex: 0, text: '你好，整片' }],
        },
      })
      await openEditor([...takes, latest, older])
      const lane = screen.getByRole('group', { name: '字幕轨' })
      await user.click(
        await within(lane).findByRole('button', { name: '字幕：你好，整片，点此改字' }),
      )
      await user.clear(within(lane).getByRole('textbox'))
      await user.keyboard('{Enter}')
      expect(
        await within(lane).findByRole('button', { name: '字幕：你好世界，点此改字' }),
      ).toBeInTheDocument()
      await waitSaved((document) => expect(document?.captions.edits).toEqual([]))
    })
  })

  it('自动卡点：拍点分析好了才能点，挪完说明卡上与保留的切点数', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = () =>
          Promise.resolve({
            duration: 30,
            numberOfChannels: 1,
            sampleRate: 100,
            getChannelData: () => new Float32Array(3_000),
          })
      },
    )
    // 每 0.6 秒一拍、没有强拍：2.0 秒的切点最近的拍在 1.8 秒
    beats.analyze.mockResolvedValue({
      beatTimes: Array.from({ length: 50 }, (_, index) => index * 0.6),
      beatStrengths: Array.from({ length: 50 }, () => 0.5),
      bpm: 100,
    })
    server.use(http.get(MUSIC_URL, () => HttpResponse.arrayBuffer(new ArrayBuffer(8))))
    putMockWholeFilmDraft(CONVERSATION, {
      ...twoClips(),
      music: { jobId: song.id, offset: 0, volume: 1 },
    })
    try {
      await openEditor([...takes, song])
      const button = screen.getByRole('button', { name: '自动卡点' })
      await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'))
      await user.click(button)
      expect(await screen.findByText('已卡点 1 处，保留 0 处')).toBeInTheDocument()
      expect(
        within(filmLane()).getByRole('group', { name: /^第 1 段 .*，1\.8 秒$/ }),
      ).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('整片编辑器 · 导出', () => {
  /** 记下发出的下载埋点 */
  const trackDownloads = () => {
    const events: unknown[] = []
    server.use(
      http.post('*/api/tracking/events', async ({ request }) => {
        events.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    return events
  }

  /** 导出进度：每次读给 states 里的下一个，读完停在最后一个 */
  const serveProgress = (...states: object[]) => {
    let reads = 0
    server.use(
      http.get('*/api/conversations/:conversationId/whole-film/exports/:exportId', () => {
        const state = states[Math.min(reads, states.length - 1)]
        reads += 1
        return HttpResponse.json({
          status: 'queued',
          progress: 0,
          queuePosition: null,
          error: null,
          downloadUrl: null,
          expiresAt: null,
          ...state,
        })
      }),
    )
  }

  const DONE = {
    status: 'done',
    progress: 1,
    downloadUrl: 'https://oss.example.com/whole-film.mp4',
    expiresAt: '2026-10-17T12:00:00Z',
  }

  it('导出：按存好的这一版提交，完成后下载；下载时对用到的每条成片各记一次', async () => {
    const user = userEvent.setup()
    const events = trackDownloads()
    serveProgress(DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    // jsdom 不做页面跳转：下载链接只看地址与埋点
    const stopNavigation = (event: Event) => event.preventDefault()
    document.addEventListener('click', stopNavigation)
    try {
      await user.click(screen.getByRole('button', { name: '导出' }))
      const link = await screen.findByRole('link', { name: '下载整片' })
      expect(link).toHaveAttribute('href', DONE.downloadUrl)
      await user.click(link)
      await user.click(link)
      await waitFor(() =>
        expect(events).toEqual([
          { jobId: TAKE_A, name: 'video.downloaded' },
          { jobId: TAKE_B, name: 'video.downloaded' },
        ]),
      )
    } finally {
      document.removeEventListener('click', stopNavigation)
    }
  })

  it('排队、渲染中显示进度，可以取消', async () => {
    const user = userEvent.setup()
    let cancelled = false
    server.use(
      http.get('*/api/conversations/:conversationId/whole-film/exports/:exportId', () =>
        HttpResponse.json({
          status: cancelled ? 'cancelled' : 'rendering',
          progress: 0.4,
          queuePosition: null,
          error: null,
          downloadUrl: null,
          expiresAt: null,
        }),
      ),
      http.delete('*/api/conversations/:conversationId/whole-film/exports/:exportId', () => {
        cancelled = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText('正在渲染 40%')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消导出' }))
    expect(await screen.findByText('已取消导出')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('导出中关掉编辑器：取消这次导出', async () => {
    const user = userEvent.setup()
    const cancelled: string[] = []
    serveProgress({ status: 'rendering', progress: 0.4 })
    server.use(
      http.delete(
        '*/api/conversations/:conversationId/whole-film/exports/:exportId',
        ({ params }) => {
          cancelled.push(String(params['exportId']))
          return new HttpResponse(null, { status: 204 })
        },
      ),
    )
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    const { close } = await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText('正在渲染 40%')).toBeInTheDocument()
    close()
    expect(screen.queryByText('正在渲染 40%')).not.toBeInTheDocument()
    await waitFor(() => expect(cancelled).toHaveLength(1))
  })

  it('提交时草稿已有更新的一版：存好手上的再提交一次', async () => {
    const user = userEvent.setup()
    const revisions: unknown[] = []
    server.use(
      http.post('*/api/conversations/:conversationId/whole-film/exports', async ({ request }) => {
        const body = (await request.json()) as { revision: number }
        revisions.push(body.revision)
        return revisions.length === 1
          ? HttpResponse.json(
              { detail: '整片草稿已经有更新的一版，重新读取后再导出' },
              { status: 409 },
            )
          : HttpResponse.json(
              { exportId: '22222222-3333-4444-8555-666666666666', sourceJobIds: [TAKE_A] },
              { status: 202 },
            )
      }),
    )
    serveProgress(DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('link', { name: '下载整片' })).toBeInTheDocument()
    expect(revisions).toEqual([1, 1])
  })

  it.each([
    ['没开通（422）', 'post', 422, '整片导出没有开通'],
    ['渲染服务不可用（502）', 'post', 502, '渲染服务暂时不可用'],
    ['导出查不到了（404）', 'get', 404, '导出已中断，请重新导出'],
  ] as const)('%s：显示原因，可以重新导出', async (_, method, status, detail) => {
    const user = userEvent.setup()
    server.use(
      http[method](
        method === 'post'
          ? '*/api/conversations/:conversationId/whole-film/exports'
          : '*/api/conversations/:conversationId/whole-film/exports/:exportId',
        () => HttpResponse.json({ detail }, { status }),
      ),
    )
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText(new RegExp(`：${detail}$`))).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('渲染失败：按失败原因说一句话', async () => {
    const user = userEvent.setup()
    serveProgress({ status: 'failed', error: { code: 'media-unreachable', message: 'ECONNRESET' } })
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText('有素材读不到，请稍后重新导出')).toBeInTheDocument()
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument()
  })
})

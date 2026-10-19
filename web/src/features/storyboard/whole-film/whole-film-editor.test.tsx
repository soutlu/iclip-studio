import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubtitleIn, WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockConversation } from '@/testing/mocks/conversations'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { renderWithProviders } from '@/testing/render'
import { card, draftOf, overlay as overlayAt, video } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { WholeFilmEditor } from './whole-film-editor'
import { wholeFilmQueryKeys } from './whole-film.api'

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
const serveGenerations = (records: GenerationJob[]) => {
  const conversation = addMockConversation('整片编辑', undefined, undefined, CONVERSATION)
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
  await screen.findByRole('group', { name: '整片编辑器' })
  /** 关掉编辑器：页面上不再渲染它 */
  const close = () => rendered.rerender(<Toaster />)
  return { onClose, close, queryClient: rendered.queryClient }
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

/** 两段视频中间夹一段组件（字标逐字，有可填项），品牌名填的是「通用」：v1 0–2、c1 2–4、v2 4–5.5 秒 */
const clipsAroundComponent = () =>
  draftOf([
    video('v1', TAKE_A, 0, 2_000),
    card('c1', 2_000, { component: 'logo-brand-close', variables: { wordmark: '通用' } }),
    video('v2', TAKE_B, 0, 1_500),
  ])

describe('整片编辑器', () => {
  it('素材区按镜头组、原作分轨', async () => {
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    expect(within(materials).getByText('镜头组 1')).toBeInTheDocument()
    expect(within(materials).getByText('生成 A')).toBeInTheDocument()
    expect(within(materials).getByText('生成 B')).toBeInTheDocument()
  })

  it('选中镜头按 Enter 插到播放头处，保存选区及首段画布尺寸', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    await user.click(
      await within(materials).findByRole('button', { name: /生成 A 镜头 2，2\.0–4\.5 秒/ }),
    )
    await user.keyboard('{Enter}')

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

  it('没选范围时按 Enter 说明原因', async () => {
    const user = userEvent.setup()
    await openEditor()
    const materials = await screen.findByRole('region', { name: '视频素材区' })
    ;(await within(materials).findByRole('button', { name: /^生成 A 镜头 1，/ })).focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('先在下方点一个镜头选中范围')).toBeInTheDocument()
    expect(within(filmLane()).queryByRole('group', { name: /^第 1 段/ })).toBeNull()
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

  it('素材栏列出这段对话的音乐，选用条目放到音乐轨上', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    const otherSong = makeGenerationJob({
      kind: 'audio',
      outputUrl: MUSIC_URL,
      durationMs: 30_000,
      request: { prompt: '安静钢琴' },
    })
    await openEditor([...takes, otherSong, song])
    const list = await screen.findByRole('list', { name: '这段对话的音乐' })
    expect(within(list).getByText('音乐 1 · 安静钢琴')).toBeInTheDocument()
    expect(within(list).getByText('音乐 2 · 轻快原声吉他')).toBeInTheDocument()
    expect(within(list).getAllByText('00:30')).toHaveLength(2)

    await user.click(within(list).getByRole('button', { name: '选用：轻快原声吉他' }))
    expect(within(list).getByRole('img', { name: '在用' })).toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: '音乐 · 音乐 2，从歌里 0.0 秒起' }),
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

describe('整片编辑器 · 时间线', () => {
  const editorDialog = () => screen.getByRole('dialog')

  it('Delete 删除选中的段，⌘Z 撤销；没选中时什么也不删', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    editorDialog().focus()
    await user.keyboard('{Delete}')
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)
    await user.click(await blockButton(/^选中：第 1 段/))
    await user.keyboard('{Backspace}')
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(1)
    await user.keyboard('{Meta>}z{/Meta}')
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)
  })

  it('⌥←/→ 把选中的段前后挪一位，焦点留在这一段上', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    // v1 出自原作 A、v2 出自原作 B
    await user.click(await blockButton(/^选中：第 1 段 · A/))
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}')
    await waitFor(() =>
      expect(within(filmLane()).getByRole('button', { name: /^选中：第 2 段 · A/ })).toHaveFocus(),
    )
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => clip.id)).toEqual(['v2', 'v1']),
    )
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => clip.id)).toEqual(['v1', 'v2']),
    )
  })

  it('选中特效块时 ←/→ 把它挪 0.1 秒、⇧ 1 秒；没选中特效块时播放头走', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, {
      ...twoClips(),
      overlays: [{ ...overlayAt('o1', 1_000, 1_000), component: 'hw-arrow' }],
    })
    await openEditor()
    const overlays = screen.getByRole('group', { name: '特效轨' })
    await user.click(
      capturable(within(overlays).getByRole('button', { name: /^选中：特效 · 手绘箭头/ })),
    )
    await user.keyboard('{ArrowRight}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 手绘箭头，第 1 行，1.1–2.1 秒' }),
    ).toBeInTheDocument()
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(
      within(overlays).getByRole('group', { name: '特效 · 手绘箭头，第 1 行，0.1–1.1 秒' }),
    ).toBeInTheDocument()

    await user.click(await blockButton(/^选中：第 1 段/))
    const playhead = screen.getByRole('slider', { name: '时间线播放位置' })
    expect(playhead).toHaveValue('0')
    await user.keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(playhead).toHaveValue('1.1')
  })

  it('音量推子按 dB：0 dB 在正中，←/→ 0.5 dB、⇧ 3 dB，双击回 0 dB，草稿里存倍数', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const fader = screen.getByRole('slider', { name: '原声音量' })
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

/** 切到「通用」栏的某个分类，返回卡片网格 */
const generalTab = async (user: ReturnType<typeof userEvent.setup>, category: string) => {
  await user.click(screen.getByRole('tab', { name: '通用' }))
  const chips = await screen.findByRole('radiogroup', { name: '分类' })
  await user.click(within(chips).getByRole('radio', { name: new RegExp(`^${category}\\s*\\d+$`) }))
  return screen.getByRole('list', { name: '组件' })
}

describe('整片编辑器 · 组件', () => {
  it('通用栏默认第一个分类、没有「全部」；品牌栏在真实目录里是空的；切栏后各记自己的分类', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('tab', { name: '通用' }))
    const chips = await screen.findByRole('radiogroup', { name: '分类' })
    const radios = within(chips).getAllByRole('radio')
    expect(radios[0]).toHaveAccessibleName(/^字幕\s*3$/)
    expect(radios[0]).toBeChecked()
    expect(within(chips).queryByRole('radio', { name: /全部/ })).not.toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: '组件' })).getAllByRole('button')).toHaveLength(
      3,
    )
    await user.click(within(chips).getByRole('radio', { name: /^转场\s*4$/ }))
    expect(within(screen.getByRole('list', { name: '组件' })).getAllByRole('button')).toHaveLength(
      4,
    )

    await user.click(screen.getByRole('tab', { name: '品牌' }))
    expect(screen.getByText('暂无品牌组件')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '组件' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '通用' }))
    expect(
      within(screen.getByRole('radiogroup', { name: '分类' })).getByRole('radio', {
        name: /^转场/,
      }),
    ).toBeChecked()
  })

  it('点 block 卡片：作为一段插到离播放头最近的切点，时长取组件自己的', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const list = await generalTab(user, '场景')
    // 播放头 1.5 秒在 v1（0–2 秒）后半，插在 v1 与 v2 之间
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '1.5' },
    })
    await user.click(within(list).getByRole('button', { name: /^标志片尾，成片轨/ }))
    expect(
      await within(filmLane()).findByRole('group', { name: '第 2 段 · 组件 · 标志片尾，6.0 秒' }),
    ).toBeInTheDocument()
    expect(within(filmLane()).queryByRole('button', { name: /^\+ 片/ })).not.toBeInTheDocument()
    await waitSaved((document) =>
      expect(document?.layer0.map((clip) => [clip.type, clip.start, clip.duration])).toEqual([
        ['video', 0, 2_000],
        ['component', 2_000, 6_000],
        ['video', 8_000, 1_500],
      ]),
    )
    expect(savedDraft()?.layer0[1]).toEqual({
      id: 'c1',
      type: 'component',
      start: 2_000,
      duration: 6_000,
      playbackStart: 0,
      component: 'logo-outro',
      variables: {},
    })
  })

  it('点 component 卡片：在特效轨最上面开一行，从播放头处开始，取组件自带的时长', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const list = await generalTab(user, '社交')
    fireEvent.change(screen.getByRole('slider', { name: '时间线播放位置' }), {
      target: { value: '0.5' },
    })
    await user.click(within(list).getByRole('button', { name: /^手绘箭头，特效轨/ }))
    expect(
      screen.getByRole('group', { name: '特效 · 手绘箭头，第 1 行，0.5–4.5 秒' }),
    ).toBeInTheDocument()
    expect(within(filmLane()).getAllByRole('group')).toHaveLength(2)
    await waitSaved((document) =>
      expect(document?.overlays).toEqual([
        {
          id: 'o1',
          component: 'hw-arrow',
          start: 500,
          duration: 4_000,
          playbackStart: 0,
          track: 0,
          zIndex: 1,
          variables: {},
          // 服务端的形状：没挪过的位置也写着
          x: 0,
          y: 0,
        },
      ]),
    )
  })

  it('放进成片后选中新片段；有可填项的组件随即打开浮层，没有的不弹', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    const list = await generalTab(user, '场景')
    await user.click(within(list).getByRole('button', { name: /^字标定格，/ }))
    const popover = await screen.findByRole('dialog', { name: '特效 · 字标定格' })
    expect(within(popover).getByLabelText('品牌名')).toHaveAttribute('placeholder', '品牌名')
    expect(screen.getByRole('button', { name: /^选中：特效 · 字标定格/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(within(list).getByRole('button', { name: /^标志片尾，成片轨/ }))
    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(
      within(filmLane()).getByRole('button', { name: /^选中：第 \d 段 · 组件 · 标志片尾/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('dialog', { name: /标志片尾/ })).not.toBeInTheDocument()
  })

  it('字幕标题下拉选择样式，保存后组件栏同步显示当前样式', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: /^字幕样式：白字黑边/ }))
    expect(screen.getByRole('menuitemradio', { name: '白字黑边' })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: '高亮字幕' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^字幕样式：高亮字幕/ })).toHaveFocus()
    await generalTab(user, '字幕')
    const list = await screen.findByRole('list', { name: '组件' })
    expect(screen.getByRole('button', { name: /^字幕样式：高亮字幕/ })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /^高亮字幕，/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(list).getByRole('button', { name: /^白字黑边，/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await waitSaved((document) => expect(document?.captions.component).toBe('caption-highlight'))
  })

  /** 点开草稿里两段视频中间的那段组件（字标逐字）的浮层 */
  const openSegment = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await blockButton(/选中：第 2 段 · 组件 · 字标逐字/))
    return screen.findByRole('dialog', { name: '组件 · 字标逐字' })
  }

  it('点开组件段：列出全部可填项，填过的显示填的，没填过的空着、默认字作提示', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    const popover = await openSegment(user)
    expect(within(popover).getByLabelText('品牌名')).toHaveValue('通用')
    expect(within(popover).getByLabelText('标语')).toHaveValue('')
    expect(within(popover).getByLabelText('标语')).toHaveAttribute('placeholder', '品牌标语')
    expect(within(popover).getByLabelText('网址')).toHaveAttribute('placeholder', '网址')
    expect(within(popover).getByRole('group', { name: '强调色' })).toBeInTheDocument()
  })

  it('清空填过的文字：回到组件的默认字，草稿里不再存这一项', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    const name = within(await openSegment(user)).getByLabelText('品牌名')
    await user.clear(name)
    await user.type(name, '{Enter}')
    await waitSaved((document) =>
      expect(document?.layer0[1]).toEqual(expect.objectContaining({ variables: {} })),
    )
  })

  it('组件没有可填项：点选它只选中，不弹浮层', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(
      CONVERSATION,
      draftOf([video('v1', TAKE_A, 0, 2_000), card('c1', 2_000, { component: 'logo-outro' })]),
    )
    await openEditor()
    const button = await blockButton(/选中：第 2 段 · 组件 · 标志片尾/)
    await user.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('dialog', { name: '组件 · 标志片尾' })).not.toBeInTheDocument()
  })

  it('改可填项回车即是一步编辑，自动保存', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    await openEditor()
    const name = within(await openSegment(user)).getByLabelText('品牌名')
    await user.clear(name)
    await user.type(name, '拾步{Enter}')
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ variables: { wordmark: '拾步' } }),
    )
  })

  it('撤销改字：回到改之前的那一版，并存回服务端', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, clipsAroundComponent())
    const { close } = await openEditor()
    const name = within(await openSegment(user)).getByLabelText('品牌名')
    await user.clear(name)
    await user.type(name, '拾步{Enter}')
    // 改过的那一版先存上，撤销才会再产生一次保存
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ variables: { wordmark: '拾步' } }),
    )
    await user.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(await openSegment(user)).getByLabelText('品牌名')).toHaveValue('通用')
    // 关掉编辑器时立即保存，不必再等 0.8 秒
    close()
    await waitSaved((document) =>
      expect(document?.layer0[1]).toMatchObject({ variables: { wordmark: '通用' } }),
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

    it('没有视频时识别入口不可用', async () => {
      await openEditor()
      expect(screen.getByRole('button', { name: '识别字幕' })).toBeDisabled()
    })

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

  /** 下载边界：成片地址照常回字节，Blob URL 与锚点点击换成桩，点击即视为交给浏览器保存 */
  const stubSaving = () => {
    server.use(
      http.get(
        DOWNLOAD_URL,
        () =>
          new HttpResponse(new Uint8Array([0, 0, 0, 24]), {
            headers: { 'Content-Type': 'video/mp4' },
          }),
      ),
    )
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = () => 'blob:http://localhost/whole-film'
        static override revokeObjectURL() {}
      },
    )
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const DONE = { status: 'done', progress: 1, downloadUrl: DOWNLOAD_URL }
  const RENDERING = { status: 'rendering', progress: 0.4 }

  it('导出：按存好的这一版提交，完成后下载；每下载一次，对用到的每条成片各记一次', async () => {
    const user = userEvent.setup()
    const events = trackDownloads()
    const saved = stubSaving()
    const revisions: unknown[] = []
    server.use(
      http.post(EXPORTS_URL, async ({ request }) => {
        revisions.push(((await request.json()) as { revision: number }).revision)
        return HttpResponse.json(
          { exportId: EXPORT_ID, sourceJobIds: [TAKE_A, TAKE_B] },
          { status: 202 },
        )
      }),
    )
    serveLatest(null, DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    const download = await screen.findByRole('button', { name: '下载整片' })
    // 打开时可能先把草稿规整存过一版：提交的是提交那一刻存着的那一版
    expect(revisions).toEqual([mockWholeFilmDraft(CONVERSATION)?.revision])
    await user.click(download)
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(download).toBeEnabled())
    await user.click(download)
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(events).toEqual([
        { jobId: TAKE_A, name: 'video.downloaded' },
        { jobId: TAKE_B, name: 'video.downloaded' },
        { jobId: TAKE_A, name: 'video.downloaded' },
        { jobId: TAKE_B, name: 'video.downloaded' },
      ]),
    )
  })

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
    expect(await screen.findByRole('button', { name: '下载整片' })).toBeEnabled()
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
              { detail: '整片草稿已经有更新的一版，重新读取后再导出' },
              { status: 409 },
            )
          : HttpResponse.json({ exportId: EXPORT_ID, sourceJobIds: [TAKE_A] }, { status: 202 })
      }),
    )
    serveLatest(null, DONE)
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByRole('button', { name: '下载整片' })).toBeInTheDocument()
    const stored = mockWholeFilmDraft(CONVERSATION)?.revision
    expect(revisions).toEqual([stored, stored])
  })

  it('没开通（422）：显示原因，可以重新导出', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(EXPORTS_URL, () =>
        HttpResponse.json({ detail: '整片导出没有开通' }, { status: 422 }),
      ),
    )
    putMockWholeFilmDraft(CONVERSATION, twoClips())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText(/：整片导出没有开通$/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it.each([
    ['渲染服务报的原因', 'media-unreachable', 'ECONNRESET', '有素材读不到，请稍后重新导出'],
    ['渲染服务重启过', 'RENDER_LOST', 'render service restarted', '渲染服务重启过，请重新导出'],
    ['交出去太久没结束', 'PROVIDER_TIMEOUT', 'no end after 6 h', '排队太久，请重新导出'],
    ['渲染服务连不上', 'RENDER_UNAVAILABLE', 'connect refused', '渲染服务连不上，请稍后重新导出'],
    ['没见过的错误码', 'SUBMIT_INTERRUPTED', 'worker restarted', '整片导出失败，请重新导出'],
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

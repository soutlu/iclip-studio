import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { starvedVideos } from '@/testing/hyperframes-player'
import { servePreviewPages } from '@/testing/preview-page'
import { addMockConversation } from '@/testing/mocks/conversations'
import { itemFileContent, server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { audio, fixtureCatalog, host, mainFile, video } from '@/testing/final-cut'
import type { GenerationJob } from '../storyboard.api'
import { FinalCutEditor } from './final-cut-editor'

const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())
// 素材有没有音轨：在 `sounds` 里的有，在 `unreadable` 里的读音轨时出错，别的没有
const sounds = vi.hoisted(() => new Set<string>())
const unreadable = vi.hoisted(() => new Set<string>())

vi.mock('mediabunny', async () => {
  const { createMediaReaderMock } = await import('@/testing/media-reader')
  class AudioSampleSink {
    async *samples() {}
  }
  return {
    ...createMediaReaderMock(files, (url) =>
      unreadable.has(url)
        ? Promise.reject(new Error('读不出音轨'))
        : Promise.resolve(
            sounds.has(url)
              ? { canDecode: () => Promise.resolve(true), getNumberOfChannels: () => 1 }
              : null,
          ),
    ),
    AudioSampleSink,
  }
})

const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const URL_A = 'https://media.test/take-a.mp4'
const URL_B = 'https://media.test/take-b.mp4'
const URL_SILENT = 'https://media.test/take-silent.mp4'
const URL_UNREADABLE = 'https://media.test/take-unreadable.mp4'
const TAKE_A = '11111111-2222-4333-8444-555555555555'
const TAKE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const TAKE_SILENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const TAKE_UNREADABLE = 'cccccccc-dddd-4eee-8fff-000000000000'

files.set(URL_A, { keyframes: [0, 2, 4.5], duration: 6 })
files.set(URL_B, { keyframes: [0, 1.5], duration: 3 })
files.set(URL_SILENT, { keyframes: [0, 1], duration: 2 })
files.set(URL_UNREADABLE, { keyframes: [0, 1], duration: 2 })
sounds.add(URL_A)
sounds.add(URL_B)
unreadable.add(URL_UNREADABLE)

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

/** 同一组的另外两条素材片：一条没有音轨，一条读不出有没有音轨。 */
const quietTakes = [
  makeGenerationJob({
    id: TAKE_SILENT,
    createdAt: '2026-09-01T10:10:00Z',
    outputUrl: URL_SILENT,
    shotIndex: 1,
    durationMs: 2000,
  }),
  makeGenerationJob({
    id: TAKE_UNREADABLE,
    createdAt: '2026-09-01T10:15:00Z',
    outputUrl: URL_UNREADABLE,
    shotIndex: 1,
    durationMs: 2000,
  }),
]

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
  const editor = (
    <>
      <FinalCutEditor conversationId={CONVERSATION} />
      <Toaster />
    </>
  )
  const rendered = await renderWithProviders(editor)
  await screen.findByRole('toolbar', { name: '剪辑工具' })
  return {
    close: () => rendered.rerender(<Toaster />),
    reopen: () => rendered.rerender(editor),
    queryClient: rendered.queryClient,
    socket: rendered.socket,
  }
}

/** 编辑器的根节点：点在编辑器的空白处时焦点落在它上面。 */
const editorRoot = () => screen.getByRole('group', { name: 'final-cut 编辑器' })

// 预览页换成跑着真逻辑的替身（播放器是测试替身），编辑器经消息和它来往
let previewPages: ReturnType<typeof servePreviewPages>

beforeEach(() => {
  previewPages = servePreviewPages({ run: true })
})

afterEach(() => previewPages.stop())

type PreviewPlayerElement = HTMLElement & { playbackRate: number; muted: boolean; loop: boolean }

/** 预览页里换上来的那个播放器；新的还在底下加载时也只认已经换上来的。 */
const previewPlayer = () => {
  const found = previewPages
    .latest()
    .mount?.querySelector<PreviewPlayerElement>('hyperframes-player:not(.is-pending)')
  if (found === null || found === undefined) throw new Error('预览页里还没有换上来的播放器')
  return found
}

/** 等预览页换上一份 final-cut、新加载的都换了上来。 */
const previewSettled = () =>
  waitFor(() => {
    expect(previewPages.latest().mount?.querySelectorAll('hyperframes-player')).toHaveLength(1)
    expect(previewPlayer()).toBeDefined()
  })

const toolbar = () => screen.getByRole('toolbar', { name: '剪辑工具' })
const transport = () => screen.getByRole('group', { name: '播放控制' })
const progress = () => within(transport()).getByRole('slider', { name: '播放进度' })
const materials = () => screen.getByRole('region', { name: '视频素材区' })
const shot = (name: RegExp) => within(materials()).findByRole('button', { name })

const savedFilm = () => mockProjectMain(CONVERSATION)?.content ?? ''
const savedVersion = () => mockProjectMain(CONVERSATION)?.version
const WRITE_URL = '*/api/conversations/:conversationId/workspace/file'
const CREATE_URL = '*/api/conversations/:conversationId/final-cut/files'
const savedClips = () => savedFilm().match(/<video [^>]*>/g) ?? []
// 保存是真实的 800 毫秒延迟；一条用例里存四五次就接近默认的 5 秒上限，CI 上会超时
vi.setConfig({ testTimeout: 15_000 })

const waitSaved = (check: () => void) => waitFor(check, { timeout: 4000 })

const twoVideos = () =>
  mainFile(
    [
      video({ src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', src: URL_B, start: 2_000, duration: 1_500 }),
    ],
    { width: 720, height: 1280 },
  )

describe('final-cut 编辑器 · 加入素材', () => {
  it('还没有工程：播放、进度条、导出置灰并说明原因，没选镜头时按 Enter 提示先选，打开不保存', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('final-cut 暂无内容，加入内容后可在此预览')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(progress()).toHaveAttribute('data-disabled')
    expect(within(toolbar()).queryByRole('button', { name: '加入 final-cut' })).toBeNull()
    editorRoot().focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByText('尚未选中镜头，无法加入 final-cut；请先在「镜头」页签中选中镜头范围'),
    ).toBeVisible()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.click(exportButton)
    expect(
      (await screen.findAllByText('final-cut 暂无内容，无法导出；请先加入内容')).length,
    ).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockProjectMain(CONVERSATION)).toBeUndefined()
  })

  it('选一个镜头按 Enter：按素材的画幅新建工程主文件，片段的 src 直接写素材片的地址', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="720" data-height="1280"')
    const [clip] = savedClips()
    expect(clip).toContain(`src="${URL_A}"`)
    expect(clip).not.toContain('data-var-src')
    expect(clip).toMatch(/data-start="0" data-duration="2.5"[^>]* data-media-start="2"/)
    expect(savedVersion()).toBe(1)
    expect(clip).toContain('data-label="A · 镜头 2"')
    expect(within(transport()).getByText('/ 00:02.50')).toBeVisible()
  })

  it('再选别的镜头按 Enter：接在末尾；选几个镜头一次加入时一个镜头一个片段', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{/Shift}{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(4))
    // 新加的片段写在根下第一个：后加的在前面
    const [fourth, third] = savedClips()
    expect(third).toMatch(/data-start="3.5" data-duration="2"[^>]* data-media-start="0"/)
    expect(fourth).toMatch(/data-start="5.5" data-duration="2.5"[^>]* data-media-start="2"/)
  })

  it('素材确认有声音才写成有声音：没有音轨、读不出有没有音轨时都写成静音', async () => {
    const user = userEvent.setup()
    await openEditor([...takes, ...quietTakes])
    for (const [count, take] of [
      [1, 'A'],
      [2, 'C'],
      [3, 'D'],
    ] as const) {
      await user.click(await shot(new RegExp(`^生成 ${take} 镜头 1，`)))
      await user.keyboard('{Enter}')
      await waitSaved(() => expect(savedClips()).toHaveLength(count))
    }
    const clipOf = (url: string) => savedClips().find((clip) => clip.includes(`src="${url}"`))
    expect(clipOf(URL_A)).toContain(' data-has-audio="true"')
    expect(clipOf(URL_A)).not.toContain('muted')
    for (const url of [URL_SILENT, URL_UNREADABLE]) {
      expect(clipOf(url)).toContain(' muted="true"')
      expect(clipOf(url)).not.toContain('data-has-audio')
    }
  })

  it('撤销退回加之前，重做再加回来；⌘Z 也可以', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    await user.click(within(toolbar()).getByRole('button', { name: '重做' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
  })

  it('保存被拒：说明原因，可以重新保存', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(
        CREATE_URL,
        () => HttpResponse.json({ detail: '工作区暂时写不进去' }, { status: 503 }),
        { once: true },
      ),
    )
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/工作区暂时写不进去$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重新保存' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
  })

  it('工程主文件读取失败：说明原因，重试后打开', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(WRITE_URL, () => HttpResponse.json({ detail: '服务暂时不可用' }, { status: 503 }), {
        once: true,
      }),
    )
    serveGenerations(takes)
    await renderWithProviders(<FinalCutEditor conversationId={CONVERSATION} />)
    expect(await screen.findByText(/服务暂时不可用$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
  })
})

describe('final-cut 编辑器 · 时间线', () => {
  const timeline = () => screen.getByRole('group', { name: '画面 1' })

  it('工程里只有组件或块的片段、没有视频片段：照样能播放', async () => {
    putMockProjectMain(CONVERSATION, mainFile([host()], { width: 720, height: 1280 }))
    await openEditor()
    expect(screen.queryByText('final-cut 暂无内容，加入内容后可在此预览')).toBeNull()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('还没有 final-cut：留一行空的，提示把镜头拖进来', async () => {
    await openEditor()
    expect(
      within(timeline()).getByText('将「镜头」页签里的镜头拖到此处可加入 final-cut'),
    ).toBeVisible()
    expect(screen.queryByRole('group', { name: '画面 2' })).toBeNull()
  })

  it('final-cut 里的片段排在一行里，行头只写行名和开关，不写片段的名字和片段数', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: 'A · 镜头 2', src: URL_A, duration: 2_000 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            src: URL_B,
            start: 2_000,
            duration: 1_500,
          }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    const clips = within(timeline()).getAllByRole('group')
    expect(clips.map((clip) => clip.getAttribute('aria-label'))).toEqual([
      'A · 镜头 2，2.0 秒',
      'B · 镜头 1，1.5 秒',
    ])
    const head = screen.getByRole('button', { name: '隐藏画面 1' }).parentElement
    expect(head).toHaveTextContent(/^画面 1$/)
    expect(screen.getByRole('slider', { name: '时间线播放位置' })).toBeEnabled()
  })

  it('两行的 final-cut：行号小的在上面，画面区的行从上往下叫「画面 1」「画面 2」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: 'A · 镜头 2', src: URL_A, duration: 2_000, track: 1 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            src: URL_B,
            duration: 1_500,
          }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    expect(within(timeline()).getByRole('group')).toHaveAccessibleName('B · 镜头 1，1.5 秒')
    expect(
      within(screen.getByRole('group', { name: '画面 2' })).getByRole('group'),
    ).toHaveAccessibleName('A · 镜头 2，2.0 秒')
    expect(screen.getByRole('button', { name: '隐藏画面 2' })).toBeVisible()
  })

  it('声音区只有一行：行叫「配乐」，开关是「静音配乐」，点了换成「取消静音配乐」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000 }), audio({ duration: 2_000 })], {
        width: 720,
        height: 1280,
      }),
    )
    const user = userEvent.setup()
    await openEditor()
    expect(
      within(screen.getByRole('group', { name: '配乐' })).getByRole('group'),
    ).toHaveAccessibleName('配乐，2.0 秒')
    await user.click(screen.getByRole('button', { name: '静音配乐' }))
    expect(screen.getByRole('button', { name: '取消静音配乐' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await waitSaved(() => expect(savedFilm()).toContain('data-hidden'))
  })

  it('声音区不止一行：从上往下叫「配乐 1」「配乐 2」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          audio({ duration: 2_000 }),
          audio({ id: 'audio-2', label: '音效', duration: 1_000, track: 1 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    expect(
      within(screen.getByRole('group', { name: '配乐 1' })).getByRole('group'),
    ).toHaveAccessibleName('配乐，2.0 秒')
    expect(
      within(screen.getByRole('group', { name: '配乐 2' })).getByRole('group'),
    ).toHaveAccessibleName('音效，1.0 秒')
    expect(screen.getByRole('button', { name: '静音配乐 2' })).toBeVisible()
  })

  it('点行头的眼睛：这一行的片段一起隐藏，存出的文件带着隐藏标记；再点显示回来', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: '隐藏画面 1' }))
    expect(
      within(timeline())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['A · 镜头 1，2.0 秒，已隐藏', 'A · 镜头 1，1.5 秒，已隐藏'])
    await waitSaved(() => expect(savedFilm().match(/data-hidden=""/g)).toHaveLength(2))

    const eye = screen.getByRole('button', { name: '显示画面 1' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    await user.click(eye)
    await waitSaved(() => expect(savedFilm()).not.toContain('data-hidden'))
    expect(screen.getByRole('button', { name: '隐藏画面 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  const clip = (name: RegExp) => within(timeline()).getByRole('button', { name })

  it('点一个片段选中它，按 Delete 删掉：开着波纹编辑，后面的片段往前补上，final-cut 变短', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(timeline()).getAllByRole('slider')).toHaveLength(2)

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(transport()).getByText('/ 00:01.50')).toBeVisible()
    expect(within(timeline()).queryAllByRole('slider')).toHaveLength(0)
  })

  it('关掉波纹编辑再删：后面的片段留在原处', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(toolbar()).getByRole('button', { name: '波纹编辑' }))
    expect(within(toolbar()).getByRole('button', { name: '波纹编辑' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await user.click(clip(/2\.0 秒$/))
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-start="2" data-duration="1.5"')
  })

  it('选中一个片段按 Esc：只取消选中', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('选中以后在把手上按方向键裁剪：裁结尾只改长度，裁开头起点和入点一起动；不超出素材', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/1\.5 秒$/))
    const end = within(timeline()).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    /** 片段上的起点、时长、入点。 */
    const timed = (start: string, duration: string, mediaStart: string) =>
      new RegExp(
        `data-start="${start}" data-duration="${duration}"[^>]* data-media-start="${mediaStart}"`,
      )
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '1.4', '0')))
    // 素材 B 一共 3 秒：再怎么往外拉也只到 3 秒
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '3', '0')))

    const start = within(timeline()).getByRole('slider', { name: '裁剪开头' })
    start.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2.1', '2.9', '0.1')))
    // 往前裁不能压到前一个片段
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '3', '0')))
    expect(within(transport()).getByText('/ 00:05.00')).toBeVisible()
  })
})

describe('final-cut 编辑器 · 多选', () => {
  // 一行三个片段：A 镜头 1 在 0–2 秒，B 镜头 1 在 2–3.5 秒，A 镜头 2 在 3.5–5 秒
  const threeVideos = () =>
    mainFile(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 }),
        video({
          id: 'clip-2',
          label: 'B · 镜头 1',
          src: URL_B,
          start: 2_000,
          duration: 1_500,
        }),
        video({
          id: 'clip-3',
          label: 'A · 镜头 2',
          src: URL_A,
          start: 3_500,
          duration: 1_500,
          mediaStart: 2_000,
        }),
      ],
      { width: 720, height: 1280 },
    )
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const NAMES = ['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'] as const
  const clip = (label: (typeof NAMES)[number]) =>
    within(row()).getByRole('button', { name: new RegExp(`^选中：${label}，`) })
  /** 选中着的片段，按时间线上的先后。 */
  const pressed = () => NAMES.filter((label) => clip(label).getAttribute('aria-pressed') === 'true')

  const openThree = async () => {
    putMockProjectMain(CONVERSATION, threeVideos())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('Shift、⌘ 点片段逐个加减选中，每个选中的片段都有两端的把手；直接点收成只选这一个', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    expect(pressed()).toEqual(['A · 镜头 1', 'A · 镜头 2'])
    expect(within(row()).getAllByRole('slider', { name: /^裁剪/ })).toHaveLength(4)

    await user.keyboard('{Meta>}')
    await user.click(clip('A · 镜头 1'))
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Meta}')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])

    await user.click(clip('A · 镜头 1'))
    expect(pressed()).toEqual(['A · 镜头 1'])
  })

  it('点行里的空白处取消全部选中；按 Esc 也全部取消', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Shift}')
    await user.click(row())
    expect(pressed()).toEqual([])

    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}{Escape}')
    expect(pressed()).toEqual([])
  })

  it('[ 选中播放头左边的片段、] 选中右边的片段，替换原有选中；正好从播放头开始或结束的只算一边', async () => {
    const user = await openThree()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await user.click(clip('A · 镜头 2'))
    // 播放头挪到 2 秒：A 镜头 1 正好在这里结束，B 镜头 1 正好从这里开始
    editorRoot().focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:02.00')).toBeVisible()

    await user.keyboard('[[')
    expect(pressed()).toEqual(['A · 镜头 1'])
    await user.keyboard(']')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])
  })

  it('选两个片段按 Delete 一起删掉，开着波纹编辑剩下的往前补；撤销一步两个都回来', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-label="B · 镜头 1"')
    expect(savedClips()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(row()).queryAllByRole('slider', { name: /^裁剪/ })).toHaveLength(0)

    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedClips().map((saved) => /data-start="([\d.]+)"/.exec(saved)?.[1])).toEqual([
      '0',
      '2',
      '3.5',
    ])
    // 删掉的片段撤销回来以后不再是选中的
    expect(pressed()).toEqual([])
  })

  it('选中相邻的两个片段，在一个的结尾把手上按方向键：两个一起裁，往外拉按被挡住的那个收住', async () => {
    const user = await openThree()
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    const end = within(row()).getAllByRole('slider', { name: '裁剪结尾' }).at(-1)
    if (end === undefined) throw new Error('没有结尾把手')
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() => {
      expect(savedClips()[1]).toContain('data-start="2" data-duration="1.4"')
      expect(savedClips()[2]).toContain('data-start="3.5" data-duration="1.4"')
    })
    // B · 镜头 1 再拉长 0.1 秒就碰到 A · 镜头 2：一起裁时把手最多到 5 秒（A · 镜头 2 自己能到 7.5 秒）
    await waitFor(() => expect(end).toHaveAttribute('aria-valuemax', '5'))
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    await waitSaved(() => {
      expect(savedClips()[1]).toContain('data-start="2" data-duration="1.5"')
      expect(savedClips()[2]).toContain('data-start="3.5" data-duration="1.5"')
    })
  })

  it('工具条：选择工具的菜单有三项，点「选中播放头右边的片段」选中；没选中时「缩放到选中的片段」置灰并说明原因', async () => {
    const user = await openThree()
    const zoomTo = within(toolbar()).getByRole('button', { name: '缩放到选中的片段' })
    expect(zoomTo).toHaveAttribute('aria-disabled', 'true')
    await user.click(zoomTo)
    expect(
      (await screen.findAllByText('尚未选中片段，无法缩放；请先选中一个片段')).length,
    ).toBeGreaterThan(0)

    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    const menu = await screen.findByRole('menu', { name: '选择工具：选择' })
    expect(menu).toHaveAttribute('data-side', 'top')
    expect(within(menu).getByRole('menuitemradio', { name: '选择' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByRole('menuitem', { name: /^选中播放头左边的片段/ })).toHaveTextContent(
      '[',
    )
    const right = within(menu).getByRole('menuitem', { name: /^选中播放头右边的片段/ })
    expect(right).toHaveTextContent(']')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1)
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)

    await user.click(right)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pressed()).toEqual(['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'])
    expect(zoomTo).not.toHaveAttribute('aria-disabled')
  })

  it('工具条的「删除」：没选中时置灰并说明原因，点了什么都不删；选中几个片段后点它一起删掉，和按 Delete 一样', async () => {
    const user = await openThree()
    const remove = within(toolbar()).getByRole('button', { name: '删除' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).toHaveAttribute('aria-keyshortcuts', 'Delete')
    await user.click(remove)
    expect(
      (await screen.findAllByText('尚未选中片段，无法删除；请先选中片段')).length,
    ).toBeGreaterThan(0)
    expect(within(row()).getAllByRole('button', { name: /^选中：/ })).toHaveLength(3)

    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Shift}')
    expect(remove).not.toHaveAttribute('aria-disabled')
    await user.click(remove)
    // 开着波纹编辑：剩下的片段往前补到开头
    await waitSaved(() => expect(savedClips()).toEqual([expect.stringContaining('data-start="0"')]))
    expect(within(row()).getAllByRole('button', { name: /^选中：/ })).toHaveLength(1)
    expect(remove).toHaveAttribute('aria-disabled', 'true')
  })

  it('工具条上没有缩略图开关', async () => {
    await openThree()
    expect(within(toolbar()).queryByRole('button', { name: /缩略图/ })).toBeNull()
  })

  it('开着菜单又有选中的片段：第一下 Esc 只关菜单、选中不变，第二下才取消选中，编辑器一直开着', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    await screen.findByRole('menu', { name: '选择工具：选择' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(pressed()).toEqual(['A · 镜头 1'])

    await user.keyboard('{Escape}')
    expect(pressed()).toEqual([])
  })
})

describe('final-cut 编辑器 · 播放', () => {
  afterEach(() => {
    starvedVideos.clear()
  })

  it('打开存着的 final-cut：显示总时长，可以播放', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(savedVersion()).toBe(1)
  })

  it('在进度条上按方向键跳到别的位置；加素材、撤销之后停在原处', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    progress().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.20 / 00:03.50')

    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
  })

  it('预览素材时播放条显示素材的时间和原作总长，在进度条上跳转夹在选区里、不离开素材；取消选中后回到 final-cut 的时间', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    progress().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')

    // 素材 A 一共 6 秒，镜头 2 是 2–4.5 秒
    await user.click(await shot(/^生成 A 镜头 2，/))
    const material = screen.getByRole('region', { name: '素材 · 镜头组 1 · 生成 A · 镜头 2' })
    expect(material.textContent).toBe('')
    expect(within(transport()).getByText('00:02.00')).toBeVisible()
    expect(within(transport()).getByText('/ 00:06.00')).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:06.00')

    progress().focus()
    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.10 / 00:06.00')
    await user.keyboard('{End}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:04.50 / 00:06.00')
    await user.keyboard('{Home}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:06.00')
    expect(material).toBeInTheDocument()
    expect(material.querySelector('video')?.currentTime).toBeCloseTo(2.001, 6)

    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{/Shift}')
    expect(material).not.toBeInTheDocument()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')
  })

  it('还没有工程时预览素材：进度条按素材可以拖，取消选中后又置灰', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(progress()).toHaveAttribute('data-disabled')

    await user.click(await shot(/^生成 B 镜头 2，/))
    expect(progress()).not.toHaveAttribute('data-disabled')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.50 / 00:03.00')
    progress().focus()
    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.60 / 00:03.00')

    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 B 镜头 2，/))
    await user.keyboard('{/Shift}')
    expect(progress()).toHaveAttribute('data-disabled')
  })

  it('当前片段数据不够时舞台转圈，播放按钮是「暂停」', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    starvedVideos.add(URL_A)
    await openEditor()
    await previewSettled()

    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    expect(await screen.findByRole('status', { name: '正在缓冲' })).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '暂停' })).toBeVisible()
    expect(previewPlayer()).toHaveProperty('paused', true)
  })

  /** 最后一次发给预览页的 final-cut。 */
  const lastLoad = () => {
    const loads = previewPages.latest().commands.filter((command) => command.type === 'load')
    const load = loads.at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    return { html: load.html, count: loads.length }
  }

  it('预览页拿到的是当前的主文件（没存的改动也在里面），<base> 指向凭令牌取工程文件的地址', async () => {
    const stored = putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000 })], { width: 720, height: 1280 }),
    )
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    const { origin, token } = previewPages.latest()
    expect(lastLoad().html).toContain(
      `<base href="${origin}/api/final-cut/preview/${encodeURIComponent(token)}/files/">`,
    )
    expect(lastLoad().html).not.toContain('/hyperframes/test-fixtures/"')

    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(lastLoad().html).toContain(`src="${URL_B}"`))
    // 这时还没存：工作区里还是打开时的那一份
    expect(mockProjectMain(CONVERSATION)?.version).toBe(stored.version)
  })

  it('预览令牌换了一张：预览页不重新加载，只有取工程文件的 <base> 换成新令牌', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const { queryClient } = await openEditor()
    await previewSettled()
    const page = previewPages.latest()
    const frame = page.frame
    const src = frame.getAttribute('src')
    server.use(
      http.post('*/api/conversations/:conversationId/final-cut/preview', () =>
        HttpResponse.json({
          origin: page.origin,
          token: `${page.token}-renewed`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ),
    )
    await act(() =>
      queryClient.refetchQueries({ queryKey: ['whole-film', 'preview', CONVERSATION] }),
    )
    await waitFor(() =>
      expect(lastLoad().html).toContain(
        `/api/final-cut/preview/${encodeURIComponent(`${page.token}-renewed`)}/files/`,
      ),
    )
    expect(previewPages.pages).toHaveLength(1)
    expect(screen.getByTitle('final-cut 预览')).toBe(frame)
    expect(frame.getAttribute('src')).toBe(src)
  })

  it('工程里别的文件变了：重新发一次 final-cut 给预览页', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const { socket } = await openEditor()
    await previewSettled()
    const before = lastLoad().count
    act(() =>
      socket.deliver({
        payload: {
          changes: [
            { change: 'modified', path: 'final-cut/compositions/fixtures/fixture-fields.html' },
          ],
        },
        session_id: CONVERSATION,
        timestamp: '2026-11-15T08:00:00+00:00',
        type: 'event.fs.changed',
      }),
    )
    await waitFor(() => expect(lastLoad().count).toBe(before + 1))
  })

  it('取不到预览令牌：预览区说明原因，点「重试」重新取到后加载预览', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    let refused = true
    server.use(
      http.post('*/api/conversations/:conversationId/final-cut/preview', () =>
        refused ? HttpResponse.json({ detail: '没有配置预览域名' }, { status: 422 }) : undefined,
      ),
    )
    const user = userEvent.setup()
    await openEditor()
    const preview = screen.getByRole('region', { name: '预览' })
    expect(await within(preview).findByRole('alert')).toHaveTextContent(
      '预览加载失败：没有配置预览域名',
    )
    expect(within(preview).queryByTitle('final-cut 预览')).not.toBeInTheDocument()

    refused = false
    await user.click(within(preview).getByRole('button', { name: '重试' }))
    expect(await within(preview).findByTitle('final-cut 预览')).toBeInTheDocument()
    expect(within(preview).queryByRole('alert')).not.toBeInTheDocument()
    await previewSettled()
  })
})

describe('final-cut 编辑器 · 播放条设置', () => {
  const player = previewPlayer
  const playerUp = previewSettled

  it('M 静音、再按恢复，⇧L 开关循环：交给播放器，final-cut 不保存、不进撤销', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()
    editorRoot().focus()

    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '开启声音' })).toBeVisible()
    await waitFor(() => expect(player().muted).toBe(true))
    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await waitFor(() => expect(player().muted).toBe(false))

    await user.keyboard('{Shift>}L{/Shift}')
    expect(within(transport()).getByRole('button', { name: '循环播放' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await waitFor(() => expect(player().loop).toBe(true))
    // 不按 Shift 的 L 不是快捷键
    await user.keyboard('l')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(player().loop).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(savedVersion()).toBe(1)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('选 2×：素材预览和 final-cut 预览都是 2×，改动 final-cut 换了播放器还是 2×', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()

    await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '2×' }))
    expect(within(transport()).getByRole('button', { name: '播放速度 2×' })).toBeVisible()
    await waitFor(() => expect(player().playbackRate).toBe(2))

    // 播放器的片段都在 iframe 里，页面上的 video 只有素材预览这一个
    await user.click(await shot(/^生成 B 镜头 1，/))
    expect(document.querySelector('video')?.playbackRate).toBe(2)
    const old = player()
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    await waitFor(() => expect(player()).not.toBe(old))
    expect(player().playbackRate).toBe(2)
  })

  describe('全屏', () => {
    const fullscreen: { element: Element | null } = { element: null }
    const announce = (element: Element | null) => {
      fullscreen.element = element
      document.dispatchEvent(new Event('fullscreenchange'))
      return Promise.resolve()
    }
    const requestFullscreen = vi.fn(function (this: Element) {
      return announce(this)
    })
    const exitFullscreen = vi.fn(() => announce(null))

    beforeEach(() => {
      fullscreen.element = null
      Object.defineProperties(document, {
        fullscreenEnabled: { configurable: true, value: true },
        fullscreenElement: { configurable: true, get: () => fullscreen.element },
        exitFullscreen: { configurable: true, value: exitFullscreen },
      })
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: requestFullscreen,
      })
    })

    afterEach(() => {
      for (const name of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen'])
        Reflect.deleteProperty(document, name)
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
      requestFullscreen.mockClear()
      exitFullscreen.mockClear()
    })

    it('F 把预览连同播放条一起全屏，菜单挂在全屏的元素里；Esc 退出全屏', async () => {
      putMockProjectMain(CONVERSATION, twoVideos())
      const user = userEvent.setup()
      await openEditor()
      await playerUp()
      editorRoot().focus()

      await user.keyboard('f')
      const stage = fullscreen.element
      expect(stage).toContainElement(screen.getByRole('region', { name: '预览' }))
      expect(stage).toContainElement(transport())
      expect(within(transport()).getByRole('button', { name: '退出全屏' })).toBeVisible()

      await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
      const menu = await screen.findByRole('menu')
      expect(stage).toContainElement(menu)
      // 菜单里按的键不是编辑器的快捷键：不静音、不挪播放头
      await user.keyboard('m{ArrowRight}')
      expect(screen.getByRole('menu')).toBeVisible()
      await user.click(within(menu).getByRole('menuitemradio', { name: '1×' }))
      expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
      expect(within(transport()).getByText('00:00.00')).toBeVisible()

      editorRoot().focus()
      await user.keyboard('{Escape}')
      expect(exitFullscreen).toHaveBeenCalledTimes(1)
      expect(within(transport()).getByRole('button', { name: '全屏' })).toBeVisible()
    })
  })
})

describe('final-cut 编辑器 · 导出', () => {
  const EXPORT_ID = '22222222-3333-4444-8555-666666666666'
  const EXPORTS_URL = '*/api/conversations/:conversationId/whole-film/exports'
  const EXPORT_URL = '*/api/conversations/:conversationId/whole-film/exports/:exportId'
  const LATEST_URL = '*/api/conversations/:conversationId/whole-film/exports/latest'
  const DOWNLOAD_URL = 'https://oss.example.com/whole-film/export.mp4'

  const exportOf = (state: object) => ({
    id: EXPORT_ID,
    status: 'queued',
    progress: null,
    queuePosition: null,
    error: null,
    downloadUrl: null,
    ...state,
  })

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

  it('「导出」在剪辑工具条里；编辑器没有标题栏，也没有关闭按钮', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(within(toolbar()).getByRole('button', { name: '导出' })).toBeVisible()
    expect(within(editorRoot()).queryByRole('banner')).toBeNull()
    expect(within(editorRoot()).queryByRole('button', { name: /关闭/ })).toBeNull()
  })

  it('打开编辑器时最近一次导出还没结束：接着显示进度，关掉编辑器不取消它', async () => {
    const cancelled = trackCancels()
    serveLatest({ status: 'rendering', progress: null }, RENDERING)
    putMockProjectMain(CONVERSATION, twoVideos())
    const { close } = await openEditor()
    expect(await screen.findByText('正在渲染…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
    expect(
      await screen.findByText('正在渲染 40%', undefined, { timeout: 3_000 }),
    ).toBeInTheDocument()
    close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(cancelled).toEqual([])
  })

  it('打开编辑器时最近一次导出已完成：直接可以下载', async () => {
    serveLatest(DONE)
    putMockProjectMain(CONVERSATION, twoVideos())
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
    putMockProjectMain(CONVERSATION, twoVideos())
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
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '取消导出' }))
    expect(await screen.findByText(/正在交给渲染服务，稍后再取消/)).toBeInTheDocument()
    expect(screen.getByText('正在渲染 40%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
  })

  /** 发起导出时工作区里的主文件，一次发起记一份。 */
  const trackStarts = () => {
    const mainAtStart: string[] = []
    server.use(
      http.post(EXPORTS_URL, () => {
        mainAtStart.push(savedFilm())
        return HttpResponse.json({ exportId: EXPORT_ID }, { status: 202 })
      }),
    )
    return mainAtStart
  }

  it('加了素材马上导出：先把 final-cut 存好，再发起导出', async () => {
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    serveLatest(null, DONE)
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await user.click(await within(toolbar()).findByRole('button', { name: '导出' }))
    expect(await screen.findByRole('button', { name: '下载成片' })).toBeInTheDocument()
    expect(mainAtStart).toHaveLength(1)
    expect(mainAtStart[0]?.match(/<video [^>]*>/g)).toHaveLength(1)
  })

  it('上次导出好了，点「重新导出」再发起一次', async () => {
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    serveLatest(DONE)
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await within(toolbar()).findByRole('button', { name: '重新导出' }))
    await waitFor(() => expect(mainAtStart).toEqual([twoVideos()]))
  })

  it('改动没存进去：不发起导出，说明保存失败的原因', async () => {
    const user = userEvent.setup()
    const mainAtStart = trackStarts()
    let attempts = 0
    server.use(
      http.post(CREATE_URL, () => {
        attempts += 1
        return HttpResponse.json({ detail: '工作区暂时写不进去' }, { status: 503 })
      }),
    )
    const { close } = await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await user.click(await within(toolbar()).findByRole('button', { name: '导出' }))
    expect(await screen.findByText(/工作区暂时写不进去$/)).toBeVisible()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mainAtStart).toEqual([])
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')

    // 关掉编辑器时还会补存一次：让它在这个用例里失败掉，不带到后面的用例里去写别人的主文件
    const before = attempts
    close()
    await waitFor(() => expect(attempts).toBeGreaterThan(before))
  })

  it('没开通（422）：显示原因，可以重新导出', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(EXPORTS_URL, () =>
        HttpResponse.json({ detail: '成片导出没有开通' }, { status: 422 }),
      ),
    )
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(screen.getByRole('button', { name: '导出' }))
    expect(await screen.findByText(/成片导出没有开通$/)).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it.each([
    ['渲染服务报的原因', 'media-unreachable', 'ECONNRESET', '部分素材读取失败，请稍后重新导出'],
    ['渲染服务重启过', 'RENDER_LOST', 'render service restarted', '渲染服务已重启，请重新导出'],
    ['交出去太久没结束', 'PROVIDER_TIMEOUT', 'no end after 6 h', '导出等待超时，请重新导出'],
    ['渲染服务连不上', 'RENDER_UNAVAILABLE', 'connect refused', '渲染服务无法连接，请稍后重新导出'],
    [
      '没通过导出前检查',
      'lint-failed',
      'root missing data-composition-id',
      'final-cut 未通过导出前检查，无法导出',
    ],
    ['没见过的错误码', 'SUBMIT_INTERRUPTED', 'worker restarted', '成片导出失败，请重新导出'],
  ])('导出失败（%s）：按原因说一句话，不露给开发看的原文', async (_, code, message, text) => {
    serveLatest({ status: 'failed', error: { code, message } })
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status')
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('渲染服务不收这份 final-cut：显示它给的原因', async () => {
    serveLatest({
      status: 'failed',
      error: { code: 'RENDER_REJECTED', message: '素材地址的主机不在允许范围' },
    })
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(/素材地址的主机不在允许范围$/)).toHaveAttribute('role', 'status')
  })
})

describe('final-cut 编辑器 · 组件、块页签', () => {
  const side = () => screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐和属性' })
  const openTab = (user: ReturnType<typeof userEvent.setup>, name: string) =>
    user.click(within(side()).getByRole('tab', { name }))
  const itemCard = (name: RegExp) =>
    within(within(side()).getByRole('list')).getByRole('group', { name })
  const cardNames = () =>
    within(within(side()).getByRole('list'))
      .getAllByRole('group')
      .map((element) => element.getAttribute('aria-label'))
  const addAtPlayhead = (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
    user.click(within(itemCard(name)).getByRole('button', { name: '加到播放头' }))
  const savedItems = () => savedFilm().match(/<div [^>]*class="clip component"[^>]*>/g) ?? []
  const previewHtml = () => previewPlayer().getAttribute('srcdoc') ?? ''
  const playerUp = previewSettled

  it('侧栏五个页签：镜头、贴片、场景、配乐、属性；贴片、场景各记着自己的搜索词和分类，切走再回来还在', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(
      within(side())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['镜头', '贴片', '场景', '配乐', '属性'])
    await openTab(user, '贴片')
    expect(within(side()).getByRole('list', { name: '贴片' })).toBeVisible()
    await user.type(within(side()).getByRole('searchbox', { name: '搜索贴片' }), '圆环')
    expect(cardNames()).toEqual(['测试叠加，4 秒'])

    await openTab(user, '场景')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toHaveValue('')
    const blockChips = () => within(side()).getByRole('radiogroup', { name: '场景分类' })
    await user.click(within(blockChips()).getByRole('radio', { name: '品牌' }))
    expect(cardNames()).toEqual(['示例品牌 片尾，3 秒'])

    await openTab(user, '配乐')
    await openTab(user, '贴片')
    expect(within(side()).getByRole('searchbox', { name: '搜索贴片' })).toHaveValue('圆环')
    expect(cardNames()).toEqual(['测试叠加，4 秒'])
    await openTab(user, '场景')
    expect(within(blockChips()).getByRole('radio', { name: '品牌' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(cardNames()).toEqual(['示例品牌 片尾，3 秒'])
  })

  it('块页签里加到播放头：条目文件先拷进工程；第一行那段时间有片段，就在它下面新开一行；固定尺寸的块缩进画面', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await openTab(user, '场景')
    await addAtPlayhead(user, /^测试画面/)

    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    expect(
      mockWorkspaceFile(CONVERSATION, 'final-cut/compositions/fixtures/fixture-scene.html')
        ?.content,
    ).toBe(itemFileContent('compositions/fixtures/fixture-scene.html'))
    const [clip] = savedItems()
    expect(clip).toContain('data-label="测试画面"')
    expect(clip).toContain('data-composition-id="fixture-scene"')
    expect(clip).toContain('data-start="0" data-duration="6" data-track-index="1"')
    expect(clip).toContain('data-variable-values="{}"')
    expect(clip).toContain(
      'left: 50%; top: 50%; width: 1920px; height: 1080px; translate: -50% -50%; scale: 0.375',
    )
    expect(
      within(screen.getByRole('group', { name: '画面 2' })).getByRole('group'),
    ).toHaveAccessibleName('测试画面，6.0 秒')

    await playerUp()
    expect(previewHtml()).toContain(
      'data-composition-src="compositions/fixtures/fixture-scene.html"',
    )
    expect(previewHtml()).toContain('scale: 0.375')
  })

  it('组件页签里加到播放头：第一行空着也放在画面区最下面新开的一行，从播放头开始；撤销回去', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    progress().focus()
    await user.keyboard('{End}')
    expect(within(transport()).getByText('00:03.50')).toBeVisible()
    await openTab(user, '贴片')
    await addAtPlayhead(user, /^测试叠加/)

    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    expect(savedItems()[0]).toContain('data-start="3.5" data-duration="4" data-track-index="1"')
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedItems()).toHaveLength(0))
    expect(savedClips()).toHaveLength(2)
  })

  it('还没有 final-cut 时加组件：按竖版 1080×1920 建一份', async () => {
    const user = userEvent.setup()
    await openEditor()
    await openTab(user, '贴片')
    await addAtPlayhead(user, /^测试叠加/)
    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="1080" data-height="1920"')
    expect(savedItems()[0]).toContain('data-start="0" data-duration="4" data-track-index="0"')
  })

  it('上一个还没加完又点「加到播放头」：只加一个，提示稍后再加', async () => {
    await openEditor()
    await openTab(userEvent.setup(), '贴片')
    const add = within(itemCard(/^测试叠加/)).getByRole('button', { name: '加到播放头' })
    fireEvent.click(add)
    fireEvent.click(add)
    await waitSaved(() => expect(savedItems()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(savedItems()).toHaveLength(1)
    expect(screen.getByText('上一个贴片或场景正在加入 final-cut，请稍后再试')).toBeVisible()
  })
})

describe('final-cut 编辑器 · 属性', () => {
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const sideTab = (name: string) =>
    within(screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐和属性' })).getByRole(
      'tab',
      { name },
    )
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const pick = (user: ReturnType<typeof userEvent.setup>, label: string) =>
    user.click(screen.getByRole('button', { name: new RegExp(`^选中：${label}，`) }))
  /** 「属性」里平铺的几段的标题。 */
  const sections = () =>
    within(inspector())
      .queryAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent)
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  const savedTag = (id: string) =>
    new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(savedFilm())?.[0] ?? ''
  /** 存下来的片段上的可填项取值。 */
  const savedValues = (id: string) =>
    JSON.parse(
      (/data-variable-values="([^"]*)"/.exec(savedTag(id))?.[1] ?? '{}').replaceAll('&quot;', '"'),
    ) as Record<string, unknown>
  /** 等过提交可填项的 300 毫秒。 */
  const pastDelay = () => new Promise((resolve) => setTimeout(resolve, 400))

  // 用了假计时的用例失败时也换回真的，不影响后面的用例
  afterEach(() => {
    vi.useRealTimers()
  })

  const brand = () =>
    host({
      id: 'brand-1',
      label: '示例品牌 片尾',
      item: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      start: 2_000,
      duration: 3_000,
    })
  const overlay = () =>
    host({
      id: 'overlay-1',
      label: '测试叠加',
      item: 'fixture-overlay',
      src: 'compositions/fixtures/fixture-overlay.html',
      start: 5_000,
    })

  const openWith = async (clips: Parameters<typeof mainFile>[0], extra = '') => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }, extra))
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('没选中时点「属性」说明怎么用；选中多个时列出名字、不显示字段；点空白处回到没有选中', async () => {
    const user = await openWith([
      host({ duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000 }),
    ])
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
    await user.click(sideTab('属性'))
    expect(within(inspector()).getByText('选中时间线上的片段后，可在此调整')).toBeVisible()

    await pick(user, '测试可填项')
    await user.keyboard('{Shift>}')
    await pick(user, 'B · 镜头 1')
    await user.keyboard('{/Shift}')
    expect(within(inspector()).getByRole('heading', { name: '已选中 2 个片段' })).toBeVisible()
    const names = within(within(inspector()).getByRole('list', { name: '选中的片段' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(names).toEqual(['测试可填项贴片', 'B · 镜头 1视频'])
    expect(within(inspector()).queryByRole('textbox')).toBeNull()
    expect(within(inspector()).queryByRole('heading', { level: 4 })).toBeNull()

    await user.click(row())
    for (const clip of within(row()).getAllByRole('button', { name: /^选中：/ }))
      expect(clip).toHaveAttribute('aria-pressed', 'false')
    expect(sideTab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('组件或块的片段：头部是名字、种类和时长，下面平铺「显示时长」「内容与样式」，没有手风琴', async () => {
    const user = await openWith([host({ start: 1_000, duration: 3_500 })])
    await pick(user, '测试可填项')
    const head = within(within(inspector()).getByRole('banner'))
    expect(head.getByRole('heading', { name: '测试可填项' })).toBeVisible()
    expect(head.getByText('贴片')).toBeVisible()
    expect(head.getByText('3.50s')).toBeVisible()
    expect(sections()).toEqual(['显示时长', '内容与样式'])
    expect(within(inspector()).queryByRole('button', { expanded: true })).toBeNull()
    expect(within(inspector()).getByRole('textbox', { name: '显示时长' })).toHaveValue('3.50')
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toBeVisible()
  })

  it('头部名字后面的种类按条目在组件库里的种类写：块写「场景」；组件库里没有的条目、手写的元素是「其他」，不写种类、只有「显示时长」', async () => {
    const user = await openWith(
      [brand()],
      '<div id="gone-1" data-label="已下架" data-composition-id="fixture-gone"' +
        ' data-composition-src="compositions/fixtures/fixture-gone.html" data-start="5" data-duration="2"' +
        ' data-track-index="0"></div>\n' +
        '<p id="note" data-start="1" data-duration="2" data-track-index="1">手写文字</p>',
    )
    const head = () => within(inspector()).getByRole('banner')
    await pick(user, '示例品牌 片尾')
    expect(within(head()).getByRole('heading', { name: '示例品牌 片尾' })).toBeVisible()
    expect(within(head()).getByText('场景')).toBeVisible()
    expect(within(head()).queryByText('贴片')).toBeNull()

    for (const name of ['已下架', '手写文字']) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^选中：${name}，`) }))
      expect(within(head()).getByRole('heading', { name })).toBeVisible()
      expect(within(head()).queryByText('场景')).toBeNull()
      expect(within(head()).queryByText('贴片')).toBeNull()
      expect(sections()).toEqual(['显示时长'])
    }
    // 「其他」片段也能改显示时长：结尾往后拉，开始不动
    const length = within(inspector()).getByRole('textbox', { name: '显示时长' })
    await user.clear(length)
    await user.type(length, '3{Enter}')
    await waitSaved(() =>
      expect(savedFilm()).toMatch(/<p [^>]*id="note"[^>]*data-start="1" data-duration="3"/),
    )
  })

  it('视频片段、音频片段是「原片截取」和「音量与变速」，开关分别是「关闭原声」「循环播放」；音频片段的隐藏叫静音', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      audio({ duration: 4_000 }),
    ])
    await pick(user, 'A · 镜头 1')
    expect(within(inspector()).getByText('视频')).toBeVisible()
    expect(sections()).toEqual(['原片截取', '音量与变速'])
    expect(within(inspector()).getByRole('switch', { name: '关闭原声' })).toBeVisible()
    expect(within(inspector()).getByRole('button', { name: '隐藏' })).toBeVisible()
    expect(within(inspector()).queryByRole('textbox')).toBeNull()

    await pick(user, '配乐')
    expect(within(inspector()).getByText('音频')).toBeVisible()
    expect(sections()).toEqual(['原片截取', '音量与变速'])
    expect(within(inspector()).getByRole('switch', { name: '循环播放' })).toBeVisible()
    await user.click(within(inspector()).getByRole('button', { name: '静音' }))
    await waitSaved(() => expect(savedTag('music-1')).toMatch(/^<audio data-hidden=""/))
    expect(within(inspector()).getByRole('button', { name: '取消静音' })).toBeVisible()
  })

  it('头部的隐藏、删除：隐藏写进文件、再点显示回来；删除和按 Delete 一样，后面的片段往前补，回到没有选中', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000 }),
    ])
    await pick(user, 'A · 镜头 1')
    await user.click(within(inspector()).getByRole('button', { name: '隐藏' }))
    expect(within(row()).getByRole('group', { name: 'A · 镜头 1，2.0 秒，已隐藏' })).toBeVisible()
    await waitSaved(() => expect(savedTag('clip-1')).toMatch(/^<video data-hidden=""/))
    await user.click(within(inspector()).getByRole('button', { name: '显示' }))
    await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-hidden'))

    await user.click(within(inspector()).getByRole('button', { name: '删除' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedTag('clip-2')).toContain('data-start="0"')
    expect(within(row()).getByRole('button', { name: /^选中：B · 镜头 1，/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(sideTab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('内容：每项按类型用对应的控件，没填过的显示默认值', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    expect(panel.getByRole('textbox', { name: '文字' })).toHaveValue('示例文字')
    // 选项不是原生下拉：是一个按钮，点开是单选菜单
    expect(panel.queryByRole('combobox')).toBeNull()
    const weight = panel.getByRole('button', { name: '字体粗细：常规' })
    await user.click(weight)
    expect(
      screen
        .getAllByRole('menuitemradio')
        .map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    ).toEqual([
      ['常规', 'true'],
      ['加粗', 'false'],
    ])
    await user.keyboard('{Escape}')
    expect(panel.getByRole('textbox', { name: '底色' })).toHaveValue('#2756ff')
    expect(panel.getByRole('button', { name: '底色取色' })).toBeVisible()
    const size = panel.getByRole('slider', { name: '字号' })
    expect(size).toHaveAttribute('aria-valuenow', '96')
    expect(size).toHaveAttribute('aria-valuemin', '48')
    expect(size).toHaveAttribute('aria-valuemax', '144')
    expect(size).toHaveAttribute('aria-valuetext', '96 px')
    expect(panel.getByRole('button', { name: '字号 96 px，点击可直接输入' })).toBeVisible()
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'false')
  })

  it('改文字：停下 300 毫秒才写进片段，算一步撤销，预览跟着变', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const text = within(inspector()).getByRole('textbox', { name: '文字' })
    // 从这里到结束都用假的计时（含预览页等的动画帧）、由用例拨钟，不看机器快慢；
    // user-event 在假计时下会卡住，所以直接发事件
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    })
    const elapse = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    /** 每次拨 50 毫秒，直到 `check` 通过；拨满 5 秒还不通过就失败。 */
    const elapseUntil = async (check: () => void) => {
      for (let elapsed = 0; ; elapsed += 50) {
        try {
          check()
          return
        } catch (error) {
          if (elapsed >= 5_000) throw error
        }
        await elapse(50)
      }
    }
    // 每次按键之间停 299 毫秒：加起来早过了 300 毫秒，每次都还没写进片段
    for (const value of ['', '新', '新的', '新的标', '新的标题']) {
      fireEvent.change(text, { target: { value } })
      await elapse(299)
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    }
    await elapse(1)
    expect(undoButton()).not.toHaveAttribute('aria-disabled')

    await elapseUntil(() => expect(savedValues('title-1')).toEqual({ text: '新的标题' }))
    await elapseUntil(() =>
      expect(previewPlayer().getAttribute('srcdoc')).toContain(
        '{&quot;text&quot;:&quot;新的标题&quot;}',
      ),
    )
    expect(text).toHaveValue('新的标题')

    fireEvent.click(undoButton())
    await elapseUntil(() => expect(savedValues('title-1')).toEqual({}))
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toHaveValue('示例文字')
  })

  it('输入法还在拼字时不写进片段，上屏以后才写', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const text = within(inspector()).getByRole('textbox', { name: '文字' })
    fireEvent.compositionStart(text)
    fireEvent.change(text, { target: { value: 'xin' } })
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(text, { target: { value: '新' } })
    fireEvent.compositionEnd(text)
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '新' }))
  })

  it('300 毫秒里改了几项：合成一次写进片段，几项都在；菜单里选了以后值写进片段', async () => {
    const user = await openWith([host({ values: { text: '原来的字' } })])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    // 菜单关上后焦点回到下拉上，还在这一段里：不算失焦，两项一起写
    await user.click(panel.getByRole('button', { name: '字体粗细：常规' }))
    await user.click(screen.getByRole('menuitemradio', { name: '加粗' }))
    expect(panel.getByRole('button', { name: '字体粗细：加粗' })).toHaveFocus()
    fireEvent.click(panel.getByRole('switch', { name: '阴影' }))
    await waitSaved(() =>
      expect(savedValues('title-1')).toEqual({ text: '原来的字', weight: '700', shadow: true }),
    )
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'true')
  })

  it('数字：有上下限时是滑杆加数值；按方向键一步一格，数值可直接输入，超出时收进上下限', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const size = panel.getByRole('slider', { name: '字号' })
    size.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 100 }))
    expect(size).toHaveAttribute('aria-valuetext', '100 px')

    await user.click(panel.getByRole('button', { name: '字号 100 px，点击可直接输入' }))
    const box = panel.getByRole('textbox', { name: '字号' })
    await user.clear(box)
    await user.type(box, '999{Enter}')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 144 }))
    expect(size).toHaveAttribute('aria-valuenow', '144')
  })

  it('数字：没有上下限时是数字框，后面写单位；框清空时不提交', async () => {
    server.use(
      http.get('/hyperframes/catalog.json', () =>
        HttpResponse.json({
          ...fixtureCatalog,
          items: fixtureCatalog.items.map((item) =>
            item.name === 'fixture-fields'
              ? {
                  ...item,
                  variables: [
                    { id: 'size', type: 'number', label: '字号', default: 96, unit: 'px' },
                  ],
                }
              : item,
          ),
        }),
      ),
    )
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    expect(panel.queryByRole('slider', { name: '字号' })).toBeNull()
    const box = panel.getByRole('spinbutton', { name: '字号' })
    expect(box).toHaveValue(96)
    expect(panel.getByText('px')).toBeVisible()
    await user.clear(box)
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    await user.type(box, '120')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 120 }))
  })

  it('颜色：十六进制文字照写；取色板里点预设色写成大写的 #RRGGBB，色块跟着变', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const hex = panel.getByRole('textbox', { name: '底色' })
    await user.clear(hex)
    await user.type(hex, '#ff0000')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#ff0000' }))

    await user.click(panel.getByRole('button', { name: '底色取色' }))
    const picker = screen.getByRole('dialog', { name: '取色板' })
    expect(within(picker).getByRole('slider', { name: '饱和度与明度' })).toHaveAttribute(
      'aria-valuetext',
      '#FF0000',
    )
    await user.click(within(picker).getByRole('button', { name: '#34D399' }))
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#34D399' }))
    expect(hex).toHaveValue('#34D399')
  })

  it('字体：下拉里是「默认」和组件库里有的字体；没填时显示条目的默认字体，选「默认」写空', async () => {
    const user = await openWith([brand()])
    await pick(user, '示例品牌 片尾')
    await user.click(within(inspector()).getByRole('button', { name: '字体：Playfair Display' }))
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      '默认',
      'Playfair Display',
    ])
    await user.click(screen.getByRole('menuitemradio', { name: '默认' }))
    await waitSaved(() => expect(savedValues('brand-1')).toEqual({ font: '' }))
    expect(within(inspector()).getByRole('button', { name: '字体：默认' })).toBeVisible()
  })

  it('条目没有可填项时说明没有；图片类可填项只读，说明暂不支持', async () => {
    server.use(
      http.get('/hyperframes/catalog.json', () =>
        HttpResponse.json({
          ...fixtureCatalog,
          items: fixtureCatalog.items.map((item) =>
            item.name === 'fixture-scene'
              ? {
                  ...item,
                  variables: [{ id: 'logo', type: 'image', label: '标志', default: '' }],
                }
              : item,
          ),
        }),
      ),
    )
    const user = await openWith([
      overlay(),
      host({
        id: 'scene-1',
        label: '测试画面',
        item: 'fixture-scene',
        src: 'compositions/fixtures/fixture-scene.html',
      }),
    ])
    await pick(user, '测试叠加')
    expect(within(inspector()).getByText('暂无可填项')).toBeVisible()
    await pick(user, '测试画面')
    expect(within(inspector()).getByText('标志')).toBeVisible()
    expect(within(inspector()).getByText('暂不支持在此修改图片')).toBeVisible()
    expect(within(inspector()).getAllByRole('textbox')).toEqual([
      within(inspector()).getByRole('textbox', { name: '显示时长' }),
    ])
  })

  describe('显示时长', () => {
    // 一行两个贴片：测试可填项在 1–3 秒，测试叠加从 5 秒开始
    const twoApart = () => [host({ start: 1_000 }), overlay()]
    const field = () => within(inspector()).getByRole('textbox', { name: '显示时长' })
    const step = (name: '缩短 0.5 秒' | '延长 0.5 秒') =>
      within(inspector()).getByRole('button', { name })
    const enter = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
      await user.clear(field())
      await user.type(field(), `${value}{Enter}`)
    }

    it('「−」「+」一次改 0.5 秒，开始不动；算一步撤销', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      expect(field()).toHaveValue('2.00')
      await user.click(step('延长 0.5 秒'))
      expect(field()).toHaveValue('2.50')
      await waitSaved(() =>
        expect(savedTag('title-1')).toContain('data-start="1" data-duration="2.5"'),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="2"'))
      expect(field()).toHaveValue('2.00')

      await user.click(step('缩短 0.5 秒'))
      expect(field()).toHaveValue('1.50')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="1.5"'))
    })

    it('上下限：不压到后面的片段，不短于最短长度；到头时那一边的按钮不能点', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      await enter(user, '9')
      expect(field()).toHaveValue('4.00')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="4"'))
      expect(step('延长 0.5 秒')).toBeDisabled()

      await enter(user, '0')
      expect(field()).toHaveValue('0.10')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="0.1"'))
      expect(step('缩短 0.5 秒')).toBeDisabled()
      expect(step('延长 0.5 秒')).toBeEnabled()
    })

    it('回车、失焦提交；Esc 放弃刚输入的，片段还选中着；不是数字时不提交、显示回原来的值', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      await user.clear(field())
      await user.type(field(), '3{Escape}')
      expect(field()).toHaveValue('2.00')
      expect(field()).not.toHaveFocus()
      expect(within(row()).getByRole('button', { name: /^选中：测试可填项，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await enter(user, '很长')
      expect(field()).toHaveValue('2.00')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await user.clear(field())
      await user.type(field(), '3.5')
      await user.tab()
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="3.5"'))
    })
  })

  describe('原片截取', () => {
    // 一行两个片段：A 镜头 1 在 0–2 秒、用素材 A（6 秒）的 1–3 秒；B 镜头 1 从 3 秒开始
    const twoClips = () => [
      video({ src: URL_A, duration: 2_000, mediaStart: 1_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 3_000, duration: 1_000 }),
    ]
    const summary = () => within(inspector()).getByTestId('slip-summary')
    const handle = (name: '裁剪开头' | '裁剪结尾') =>
      within(inspector()).getByRole('slider', { name })
    const strip = () => within(inspector()).getByRole('group', { name: '原片截取条' })
    /** 存下来的片段的起点、时长、入点。 */
    const timed = (start: string, duration: string, mediaStart: string) =>
      new RegExp(
        `data-start="${start}" data-duration="${duration}"[^>]* data-media-start="${mediaStart}"`,
      )

    it('标题行写入点 – 出点 / 素材总长；抓手按方向键微调入点、出点，碰到后面的片段就停', async () => {
      const user = await openWith(twoClips())
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).getByText('· A · 镜头 1')).toBeVisible()
      await waitFor(() => expect(summary()).toHaveTextContent('1.00 – 3.00s / 6.0s'))

      handle('裁剪开头').focus()
      await user.keyboard('{ArrowLeft}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2.1', '0.9')))
      expect(summary()).toHaveTextContent('0.90 – 3.00s')
      // 片段最长到 3 秒（后面的片段在 3 秒）：入点最早到 0
      await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '3', '0')))

      // 出点往外拉也被后面的片段挡住
      handle('裁剪结尾').focus()
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
      await pastDelay()
      expect(savedTag('clip-1')).toMatch(timed('0', '3', '0'))
      await user.keyboard('{ArrowLeft}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2.9', '0')))
      expect(savedTag('clip-2')).toContain('data-start="3"')
    })

    it('在条上按下、拖动：拖动中只动面板，松手写进 final-cut 一次，一步撤销回去', async () => {
      const user = await openWith(twoClips())
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      await waitFor(() => expect(summary()).toHaveTextContent('1.00 – 3.00s / 6.0s'))
      // jsdom 不排版：条宽 600px，1px 是素材的 10 毫秒
      const box = { left: 0, top: 0, right: 600, bottom: 26, width: 600, height: 26, x: 0, y: 0 }
      Object.defineProperty(strip(), 'getBoundingClientRect', { value: () => box })

      // 按在 3 秒处：框的正中对过去，入点 2 秒；再拖到最右，入点收在 6 − 2 = 4 秒
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 1, clientX: 300 })
      expect(summary()).toHaveTextContent('2.00 – 4.00s')
      fireEvent.pointerMove(strip(), { pointerId: 1, clientX: 590 })
      expect(summary()).toHaveTextContent('4.00 – 6.00s')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.pointerUp(strip(), { pointerId: 1, clientX: 590 })
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2', '4')))

      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2', '1')))
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      // 拖动中按 Esc：什么都不写，片段还选中着
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 2, clientX: 300 })
      expect(summary()).toHaveTextContent('2.00 – 4.00s')
      await user.keyboard('{Escape}')
      expect(summary()).toHaveTextContent('1.00 – 3.00s')
      fireEvent.pointerUp(strip(), { pointerId: 2, clientX: 300 })
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      expect(within(row()).getByRole('button', { name: /^选中：A · 镜头 1，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    it('素材总长还没读到：条上写读到哪了，没有框和抓手，按下不改', async () => {
      const user = await openWith([
        video({ src: 'https://media.test/videos/elsewhere.mp4', duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, 'A · 镜头 1')
      expect(within(strip()).getByText('正在读取镜头…')).toBeVisible()
      expect(within(inspector()).queryByTestId('slip-summary')).toBeNull()
      expect(within(inspector()).queryByRole('slider', { name: /^裁剪/ })).toBeNull()
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 1, clientX: 30 })
      fireEvent.pointerUp(strip(), { pointerId: 1, clientX: 30 })
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      // 配乐读不出声音：写明，同样不能拖
      await pick(user, '配乐')
      expect(await within(strip()).findByText('该音频没有声音')).toBeVisible()
      expect(within(inspector()).queryByRole('slider', { name: /^裁剪/ })).toBeNull()
    })
  })

  describe('音量与变速', () => {
    const slider = (name: string) => within(inspector()).getByRole('slider', { name })
    /** 滑杆的点按区：按下、双击都在它上面。 */
    const track = (name: string) =>
      slider(name).parentElement?.closest<HTMLElement>('[data-orientation]') ?? slider(name)
    /** 滑杆右边的数值，点一下可以直接输入。 */
    const readout = (name: string) =>
      within(inspector()).getByRole('button', { name: new RegExp(`^${name} .*，点击可直接输入$`) })
    const toggle = (name: string) => within(inspector()).getByRole('switch', { name })
    const press = async (user: ReturnType<typeof userEvent.setup>, name: string, key: string) => {
      slider(name).focus()
      await user.keyboard(key)
    }
    const type = async (user: ReturnType<typeof userEvent.setup>, name: string, text: string) => {
      await user.click(readout(name))
      const box = within(inspector()).getByRole('textbox', { name })
      await user.clear(box)
      await user.type(box, text)
      return box
    }
    const savedAttribute = (id: string, name: string) =>
      new RegExp(` ${name}(?:="([^"]*)")?[ >]`).exec(savedTag(id))?.[1]

    it('音频片段：音量、淡入、淡出、倍速，标题行右边是「循环播放」；数值照参照的换算显示', async () => {
      const user = await openWith([
        audio({
          duration: 4_000,
          volume: 0.5,
          playbackRate: 2,
          fadeIn: 1_000,
          loop: true,
        }),
      ])
      await pick(user, '配乐')
      const labels = within(inspector())
        .getAllByText(/^(音量|淡入|淡出|倍速)$/)
        .map((label) => label.textContent)
      expect(labels).toEqual(['音量', '淡入', '淡出', '倍速'])
      expect(slider('音量')).toHaveAttribute('aria-valuetext', '-6.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuemin', '-100')
      expect(slider('音量')).toHaveAttribute('aria-valuemax', '100')
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      expect(slider('倍速')).toHaveAttribute('aria-valuetext', '2x')
      expect(slider('倍速')).toHaveAttribute('aria-valuenow', '651')
      expect(readout('淡入')).toHaveTextContent('1.00 秒')
      expect(readout('淡出')).toHaveTextContent('0.00 秒')
      expect(toggle('循环播放')).toHaveAttribute('aria-checked', 'true')
      expect(within(inspector()).queryByRole('switch', { name: '关闭原声' })).toBeNull()
    })

    it('音量：方向键一步写一次，算一步撤销；最右 +12 dB，最左无声；双击回到 0 dB', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await pick(user, '配乐')
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')
      expect(readout('音量')).toHaveTextContent('0.0 dB')

      // 按一下方向键再撤销：滑杆和数值回到原来的值，不留着按键时的那一格
      await press(user, '音量', '{ArrowRight}')
      await waitSaved(() =>
        expect(Number(savedAttribute('music-1', 'data-volume'))).toBeGreaterThan(1),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(Number(savedAttribute('music-1', 'data-volume') ?? '1')).toBe(1))
      expect(readout('音量')).toHaveTextContent('0.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')

      await press(user, '音量', '{End}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('3.981072'))
      expect(readout('音量')).toHaveTextContent('+12.0 dB')
      await press(user, '音量', '{Home}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0'))
      expect(readout('音量')).toHaveTextContent('-∞ dB')

      fireEvent.doubleClick(track('音量'))
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('1'))
      expect(readout('音量')).toHaveTextContent('0.0 dB')

      await user.click(undoButton())
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0'))
    })

    it('音量直接输入：按 dB 读；读不出时回车框留着、标成不对，Esc 放弃，片段还选中着', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await pick(user, '配乐')
      await type(user, '音量', '-6{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187'))
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuetext', '-6.0 dB')

      const box = await type(user, '音量', '很响{Enter}')
      expect(box).toHaveAttribute('aria-invalid', 'true')
      expect(box).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      const soundRow = screen.getByRole('group', { name: '配乐' })
      expect(within(soundRow).getByRole('button', { name: /^选中：配乐，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187')
    })

    it('倍速：滑杆按对数走，正中 1 倍、两头 0.1 倍和 10 倍；1 倍时不写，双击回到 1 倍；片段的时长不变，用掉的素材跟着变', async () => {
      const user = await openWith([video({ src: URL_A, duration: 2_000 })])
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      expect(slider('倍速')).toHaveAttribute('aria-valuenow', '500')
      expect(readout('倍速')).toHaveTextContent('1x')
      await press(user, '倍速', '{End}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('10'))
      await press(user, '倍速', '{Home}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('0.1'))
      fireEvent.doubleClick(track('倍速'))
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-playback-rate'))

      await type(user, '倍速', '2x{Enter}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('2'))
      expect(savedAttribute('clip-1', 'data-duration')).toBe('2')
      // 2 倍速：2 秒的片段用掉素材的 0–4 秒
      expect(within(inspector()).getByTestId('slip-summary')).toHaveTextContent(
        '0.00 – 4.00s / 6.0s',
      )
    })

    it('淡入淡出：一端最多到片段长减去另一端，0 时不写', async () => {
      const user = await openWith([audio({ duration: 4_000, fadeOut: 1_000 })])
      await pick(user, '配乐')
      expect(slider('淡入')).toHaveAttribute('aria-valuemax', '300')
      expect(slider('淡出')).toHaveAttribute('aria-valuemax', '400')
      await type(user, '淡入', '10{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fade-in')).toBe('3'))
      expect(slider('淡出')).toHaveAttribute('aria-valuemax', '100')
      await press(user, '淡出', '{Home}')
      await waitSaved(() => expect(savedTag('music-1')).not.toContain('data-fade-out'))
      expect(slider('淡入')).toHaveAttribute('aria-valuemax', '400')
    })

    it('循环播放、关闭原声：开关写进文件；关闭原声写 muted、不写有声音的标记，音量和淡入淡出变得不能操作，倍速照常', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await user.click(toggle('循环播放'))
      await waitSaved(() => expect(savedAttribute('music-1', 'loop')).toBe('true'))

      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).queryByRole('switch', { name: '循环播放' })).toBeNull()
      expect(slider('淡入')).not.toHaveAttribute('aria-disabled')
      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'muted')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('data-has-audio')
      for (const name of ['音量', '淡入', '淡出']) {
        expect(slider(name)).toHaveAttribute('aria-disabled', 'true')
        expect(readout(name)).toBeDisabled()
      }
      expect(slider('倍速')).not.toHaveAttribute('aria-disabled')
      const volume = savedAttribute('clip-1', 'data-volume')
      await press(user, '音量', '{End}')
      fireEvent.doubleClick(track('音量'))
      await pastDelay()
      expect(savedAttribute('clip-1', 'data-volume')).toBe(volume)
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')

      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-has-audio')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('muted')
      expect(slider('音量')).not.toHaveAttribute('aria-disabled')
    })

    it('视频片段的素材没有声音：「关闭原声」开着、不能关，悬停说明原因；读不出有没有声音时照常能拨', async () => {
      const user = await openWith([
        video({ src: URL_SILENT, label: '无声', muted: true }),
        video({
          id: 'clip-2',
          src: URL_UNREADABLE,
          label: '读不出',
          start: 2_000,
          muted: true,
        }),
      ])
      await pick(user, '无声')
      await waitFor(() => expect(toggle('关闭原声')).toHaveAttribute('aria-disabled', 'true'))
      expect(toggle('关闭原声')).toHaveAttribute('aria-checked', 'true')
      await user.hover(toggle('关闭原声'))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
      await user.click(toggle('关闭原声'))
      expect(toggle('关闭原声')).toHaveAttribute('aria-checked', 'true')
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await pick(user, '读不出')
      expect(toggle('关闭原声')).not.toHaveAttribute('aria-disabled')
      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-2', 'data-has-audio')).toBe('true'))
    })
  })

  it('「属性」里的控件上按快捷键不动时间线：删除、退格、M、[ 都归控件，空格拨开关', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const clipButton = () => within(row()).queryByRole('button', { name: /^选中：测试可填项，/ })

    panel.getByRole('textbox', { name: '文字' }).focus()
    await user.keyboard('{Backspace}{Delete}')
    panel.getByRole('button', { name: '字体粗细：常规' }).focus()
    await user.keyboard('{Delete}{Backspace}m[[')
    panel.getByRole('slider', { name: '字号' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    const shadow = panel.getByRole('switch', { name: '阴影' })
    shadow.focus()
    await user.keyboard('{Delete} ')

    // 打开的取色板里按的键归它；Esc 只关上取色板，片段还选中着
    await user.click(panel.getByRole('button', { name: '底色取色' }))
    const picker = screen.getByRole('dialog', { name: '取色板' })
    within(picker).getByRole('button', { name: '#FFFFFF' }).focus()
    await user.keyboard('{Delete}{Backspace}m[[{ArrowRight}')
    await user.keyboard('{Escape}')
    expect(picker).not.toBeInTheDocument()

    expect(shadow).toHaveAttribute('aria-checked', 'true')
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '示例文', shadow: true }))
    expect(savedTag('title-1')).not.toBe('')
  })

  it('原片截取、音量与变速的滑杆上按 Delete、M 不动时间线，按方向键只改这一项', async () => {
    const user = await openWith([video({ src: URL_A, duration: 2_000 })])
    await shot(/^生成 A 镜头 1，/)
    await pick(user, 'A · 镜头 1')
    const panel = within(inspector())
    const clipButton = () => within(row()).queryByRole('button', { name: /^选中：A · 镜头 1，/ })
    await waitFor(() => expect(panel.getByRole('slider', { name: '裁剪结尾' })).toBeVisible())
    panel.getByRole('slider', { name: '裁剪结尾' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    panel.getByRole('slider', { name: '倍速' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('final-cut 编辑器 · 侧栏页签', () => {
  const side = () => screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐和属性' })
  const tab = (name: string) => within(side()).getByRole('tab', { name })
  const props = () => screen.getByRole('tabpanel', { name: '属性' })
  const shotsPanel = () => screen.getByRole('tabpanel', { name: '镜头' })
  const selectionDot = () => within(tab('属性')).queryByTestId('selection-dot')
  const row = (number = 1) => screen.getByRole('group', { name: `画面 ${String(number)}` })
  // twoVideos 的两个片段同名，按时长认：第一个 2 秒，第二个 1.5 秒
  const FIRST = /2\.0 秒$/
  const SECOND = /1\.5 秒$/
  const clip = (name: RegExp) => within(row()).getByRole('button', { name })

  const openTwo = async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('默认停在「镜头」，素材片只在这个页签里；选中片段切到「属性」、页签名后出现圆点，取消选中回到「镜头」，选中的镜头范围还在', async () => {
    const user = await openTwo()
    expect(tab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(within(shotsPanel()).getByRole('region', { name: '视频素材区' })).toBeVisible()
    expect(screen.getAllByRole('region', { name: '视频素材区' })).toHaveLength(1)
    await user.click(await within(shotsPanel()).findByRole('button', { name: /^生成 A 镜头 2，/ }))
    const range = () =>
      within(shotsPanel()).getByRole('group', { name: /^选中的范围 2\.0–4\.5 秒/ })
    expect(range()).toBeVisible()
    expect(selectionDot()).toBeNull()

    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(selectionDot()).not.toBeNull()
    expect(tab('属性')).toHaveAccessibleName('属性')
    expect(screen.queryByRole('region', { name: '视频素材区' })).toBeNull()

    await user.keyboard('{Escape}')
    expect(tab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(selectionDot()).toBeNull()
    expect(range()).toBeVisible()

    await user.click(tab('贴片'))
    expect(screen.queryByRole('region', { name: '视频素材区' })).toBeNull()
  })

  it('选中片段自动切到「属性」，换选别的片段仍在「属性」；选中着时点目录页签显示目录，选中不变', async () => {
    const user = await openTwo()
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(within(props()).getByRole('banner')).getByText('2.00s')).toBeVisible()

    await user.click(tab('场景'))
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toBeVisible()
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'true')

    await user.click(clip(SECOND))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(within(props()).getByRole('banner')).getByText('1.50s')).toBeVisible()
  })

  it('点时间线空白处取消选中：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.click(row())
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'false')
    expect(tab('场景')).toHaveAttribute('aria-selected', 'true')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toBeVisible()
  })

  it('按 Esc 取消选中：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('配乐'))
    await user.click(clip(FIRST))
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Escape}')
    expect(clip(FIRST)).toHaveAttribute('aria-pressed', 'false')
    expect(tab('配乐')).toHaveAttribute('aria-selected', 'true')
    expect(within(side()).getByRole('searchbox', { name: '搜索音频' })).toBeVisible()
  })

  it('撤销让选中的片段不存在了：回到切走之前停的目录页签', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.click(
      within(within(side()).getByRole('group', { name: /^测试画面/ })).getByRole('button', {
        name: '加到播放头',
      }),
    )
    const added = await within(row(2)).findByRole('button', { name: /^选中：测试画面，/ })
    await user.click(added)
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: '画面 2' })).toBeNull())
    expect(tab('场景')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('自动切到「属性」再回来：目录页签里的搜索词和分类都还在', async () => {
    const user = await openTwo()
    await user.click(tab('场景'))
    await user.type(within(side()).getByRole('searchbox', { name: '搜索场景' }), '片尾')
    const chips = () => within(side()).getByRole('radiogroup', { name: '场景分类' })
    await user.click(within(chips()).getByRole('radio', { name: '品牌' }))
    await user.click(clip(FIRST))
    expect(within(side()).queryByRole('searchbox', { name: '搜索场景' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(within(side()).getByRole('searchbox', { name: '搜索场景' })).toHaveValue('片尾')
    expect(within(chips()).getByRole('radio', { name: '品牌' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await user.click(tab('配乐'))
    await user.type(within(side()).getByRole('searchbox', { name: '搜索音频' }), '吉他')
    await user.click(clip(SECOND))
    expect(within(side()).queryByRole('searchbox', { name: '搜索音频' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(within(side()).getByRole('searchbox', { name: '搜索音频' })).toHaveValue('吉他')
  })

  it('在目录的卡片上按 ] 选中片段、切到「属性」后：焦点交还编辑器的根节点，Delete 照常删掉选中的片段', async () => {
    const user = await openTwo()
    await user.click(tab('贴片'))
    within(within(side()).getByRole('group', { name: /^测试叠加/ }))
      .getByRole('button', { name: '加到播放头' })
      .focus()
    await user.keyboard(']')
    expect(tab('属性')).toHaveAttribute('aria-selected', 'true')
    expect(within(props()).getByRole('heading', { name: '已选中 2 个片段' })).toBeVisible()
    expect(editorRoot()).toHaveFocus()

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(0))
    expect(tab('贴片')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('final-cut 编辑器 · 切走再切回', () => {
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const labels = () =>
    within(row())
      .getAllByRole('button', { name: /^选中：/ })
      .map((button) => /^选中：(.+?)，/.exec(button.getAttribute('aria-label') ?? '')?.[1])

  /** 接下来的 `count` 次保存各自先压着，`release` 按到达的先后放行一次，放行后照常存。 */
  const holdSaves = (count: number) => {
    const waiting: (() => void)[] = []
    let held = 0
    server.use(
      http.put(WRITE_URL, async () => {
        if (held >= count) return undefined
        held += 1
        await new Promise<void>((resolve) => waiting.push(resolve))
        return undefined
      }),
    )
    return { held: () => held, release: () => waiting.shift()?.() }
  }

  const stillReading = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.getByRole('status')).toHaveTextContent('正在读取 final-cut…')
    expect(screen.queryByRole('toolbar', { name: '剪辑工具' })).toBeNull()
  }

  /** 在别的页签上停一会儿再切回来。 */
  const switchBack = async (reopen: () => void) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    reopen()
  }

  it('改完马上切走、保存还没回来时切回：等保存完才读主文件，读到改过的，接着改照常保存', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: '甲', src: URL_A, duration: 2_000 }),
          video({ id: 'clip-2', label: '乙', src: URL_B, start: 2_000 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    const user = userEvent.setup()
    const { close, reopen } = await openEditor()
    await user.click(within(row()).getByRole('button', { name: /^选中：甲，/ }))
    await user.keyboard('{Delete}')
    expect(labels()).toEqual(['乙'])

    const saves = holdSaves(1)
    close()
    await waitFor(() => expect(saves.held()).toBe(1))
    await switchBack(reopen)
    await stillReading()
    saves.release()
    await screen.findByRole('toolbar', { name: '剪辑工具' })
    expect(labels()).toEqual(['乙'])

    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(labels()).toEqual(['乙', 'A · 镜头 1'])
    expect(screen.queryByText(/已在别处修改/)).toBeNull()
  })

  it('一次保存还在途时又改了一处再切走：切回时等两次保存都完成才读主文件', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: '甲', src: URL_A, duration: 2_000 }),
          video({ id: 'clip-2', label: '乙', src: URL_B, start: 2_000 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    const user = userEvent.setup()
    const { close, reopen } = await openEditor()
    const saves = holdSaves(2)
    await user.click(within(row()).getByRole('button', { name: /^选中：甲，/ }))
    await user.keyboard('{Delete}')
    await waitFor(() => expect(saves.held()).toBe(1), { timeout: 4000 })
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(labels()).toEqual(['乙', 'A · 镜头 1']))

    close()
    await switchBack(reopen)
    await stillReading()
    saves.release()
    await waitFor(() => expect(saves.held()).toBe(2))
    await stillReading()
    saves.release()
    await screen.findByRole('toolbar', { name: '剪辑工具' })
    expect(labels()).toEqual(['乙', 'A · 镜头 1'])
    expect(savedClips()).toHaveLength(2)
    expect(screen.queryByText(/已在别处修改/)).toBeNull()
  })
})

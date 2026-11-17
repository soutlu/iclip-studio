import { openComposition } from '@hyperframes/sdk'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinalCutTranslationsIn } from '@/shared/api/generated/types.gen'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { starvedVideos } from '@/testing/hyperframes-player'
import { servePreviewPages } from '@/testing/preview-page'
import { addMockConversation } from '@/testing/mocks/conversations'
import { itemFileContent, server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { audio, caption, fixtureCatalog, host, mainFile, video } from '@/testing/final-cut'
import type { GenerationJob } from '../storyboard.api'
import {
  CAPTIONS_PATH,
  CAPTIONS_PROBLEM_TEXT,
  captionsHostElement,
  captionsScene,
  captionVariable,
} from './composition/captions'
import type { CaptionClip, FilmClip } from './composition/film'
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
// 不在出片列表里的地址：final-cut 里的片段还在用、「镜头」页签里已经不显示的旧版本
const URL_OLD = 'https://media.test/take-old.mp4'
const TAKE_A = '11111111-2222-4333-8444-555555555555'
const TAKE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const TAKE_SILENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const TAKE_UNREADABLE = 'cccccccc-dddd-4eee-8fff-000000000000'

files.set(URL_A, { keyframes: [0, 2, 4.5], duration: 6 })
files.set(URL_B, { keyframes: [0, 1.5], duration: 3 })
files.set(URL_SILENT, { keyframes: [0, 1], duration: 2 })
files.set(URL_UNREADABLE, { keyframes: [0, 1], duration: 2 })
files.set(URL_OLD, { keyframes: [0, 2], duration: 5 })
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

type PreviewPlayerElement = HTMLElement & {
  playbackRate: number
  muted: boolean
  loop: boolean
  iframeElement: HTMLIFrameElement
}

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

  it('工具条：选择工具的菜单有两个工具和三条命令，点「选中播放头右边的片段」选中；没选中时「缩放到选中的片段」置灰并说明原因', async () => {
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
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['选择', '切开'])
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['在播放头处切开S', '选中播放头左边的片段[', '选中播放头右边的片段]'])

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

describe('final-cut 编辑器 · 片段右键菜单', () => {
  const user = () => userEvent.setup()
  const openWith = async (clips: Parameters<typeof mainFile>[0], extra = '') => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }, extra))
    await openEditor()
  }
  /** 时间线上名字是 `label` 的片段。 */
  const clipOf = (label: string) => screen.getByRole('group', { name: new RegExp(`^${label}，`) })
  const pressedOf = (label: string) =>
    within(clipOf(label))
      .getByRole('button', { name: /^选中：/ })
      .getAttribute('aria-pressed')
  /** 用鼠标在片段上点右键，等它的菜单出来。 */
  const openMenu = async (label: string) => {
    // 先按下右键：菜单按鼠标打开，不把焦点放到第一项上
    fireEvent.pointerDown(clipOf(label), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf(label))
    return screen.findByRole('menu', { name: label })
  }
  const itemsOf = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
  const choose = async (label: string, item: string) => {
    const menu = await openMenu(label)
    await user().click(within(menu).getByRole('menuitem', { name: new RegExp(`^${item}`) }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  const closeMenu = async () => {
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  const savedTag = (id: string) =>
    new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(savedFilm())?.[0] ?? ''

  it('各种片段的菜单项：最上面是「在播放头处切开」，视频、音频片段能静音，画面区的片段能隐藏，最后是分隔线和「删除片段」；文字随状态变', async () => {
    await openWith(
      [
        video({ src: URL_A, duration: 2_000 }),
        video({ id: 'clip-2', label: '已关', src: URL_B, start: 2_000, muted: true, hidden: true }),
        host({ start: 0, track: 1 }),
        audio({ duration: 4_000 }),
        audio({ id: 'music-2', label: '已静音', start: 4_000, hidden: true }),
      ],
      '<p id="note" data-start="0" data-duration="2" data-track-index="2">手写文字</p>',
    )
    const detach = '分离音频至独立音轨⇧⌘B'
    const expected: Record<string, string[]> = {
      'A · 镜头 1': [detach, '静音此片段', '隐藏片段画面', '删除片段Delete'],
      已关: [detach, '取消静音', '恢复显示画面', '删除片段Delete'],
      测试可填项: ['隐藏片段画面', '删除片段Delete'],
      手写文字: ['隐藏片段画面', '删除片段Delete'],
      配乐: ['静音此片段', '删除片段Delete'],
      已静音: ['取消静音', '删除片段Delete'],
    }
    for (const [label, items] of Object.entries(expected)) {
      const menu = await openMenu(label)
      expect(itemsOf(menu)).toEqual(['在播放头处切开S', ...items])
      // 「在播放头处切开」后面和「删除片段」前面各有一条分隔线，视频片段的「分离音频」自成一组
      const separators = within(menu).getAllByRole('separator')
      expect(separators).toHaveLength(items[0] === detach ? 3 : 2)
      expect(separators[0]?.previousElementSibling).toHaveTextContent(/^在播放头处切开/)
      expect(separators.at(-1)?.nextElementSibling).toHaveTextContent(/^删除片段/)
      // 切开另有用例；关着原声的视频片段不能分离音频，别的项都能选
      for (const item of within(menu).getAllByRole('menuitem').slice(1))
        if (label === '已关' && item.textContent === detach)
          expect(item).toHaveAttribute('aria-disabled', 'true')
        else expect(item).not.toHaveAttribute('aria-disabled')
      await closeMenu()
    }
  })

  it('视频片段的素材没有声音：「取消静音」置灰，悬停说明原因，选它什么都不改、菜单不关；读不出有没有声音时照常能选', async () => {
    await openWith([
      video({ src: URL_SILENT, label: '无声', muted: true }),
      video({ id: 'clip-2', src: URL_UNREADABLE, label: '读不出', start: 2_000, muted: true }),
    ])
    const menu = await openMenu('无声')
    const unmute = () => within(menu).getByRole('menuitem', { name: '取消静音' })
    await waitFor(() => expect(unmute()).toHaveAttribute('aria-disabled', 'true'))
    await user().hover(unmute())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
    await user().click(unmute())
    expect(screen.getByRole('menu', { name: '无声' })).toBeVisible()
    await closeMenu()
    // 用键盘也能走到置灰的那一项（前两项是「在播放头处切开」「分离音频至独立音轨」），聚焦时说明原因
    await openMenu('无声')
    await user().keyboard('{End}{Home}{ArrowDown}{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '取消静音' })).toHaveFocus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
    // 第一下 Esc 先收起说明，第二下关菜单
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(screen.getByRole('menu', { name: '无声' })).toBeVisible()
    await closeMenu()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

    await choose('读不出', '取消静音')
    await waitSaved(() => expect(savedTag('clip-2')).toContain('data-has-audio="true"'))
  })

  it('右键没选中的片段先只选中它、侧栏切到「属性」；多选时右键其中一个选中不变，静音、隐藏只改它，删除删掉全部选中的', async () => {
    await openWith([
      video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 1_500 }),
      video({ id: 'clip-3', label: 'A · 镜头 2', src: URL_A, start: 3_500, duration: 1_500 }),
    ])
    // 菜单开着时页面别处对读屏藏起来，关了再看
    await openMenu('B · 镜头 1')
    await closeMenu()
    expect(pressedOf('B · 镜头 1')).toBe('true')
    expect(pressedOf('A · 镜头 1')).toBe('false')
    expect(within(inspector()).getByRole('heading', { name: 'B · 镜头 1' })).toBeVisible()

    const clicks = user()
    await clicks.keyboard('{Shift>}')
    await clicks.click(within(clipOf('A · 镜头 1')).getByRole('button', { name: /^选中：/ }))
    await clicks.keyboard('{/Shift}')
    await choose('B · 镜头 1', '隐藏片段画面')
    await waitSaved(() => expect(savedTag('clip-2')).toContain('data-hidden'))
    expect(savedTag('clip-1')).not.toContain('data-hidden')
    await choose('A · 镜头 1', '静音此片段')
    await waitSaved(() => expect(savedTag('clip-1')).toContain('muted="true"'))
    expect(savedTag('clip-2')).not.toContain('muted')
    expect(['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'].map(pressedOf)).toEqual([
      'true',
      'true',
      'false',
    ])

    // 开着波纹编辑：剩下的那个补到开头
    await choose('A · 镜头 1', '删除片段')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedTag('clip-3')).toContain('data-start="0"')
  })

  it('菜单里的静音、隐藏写进文件的和「属性」里同样的操作一样，各算一步撤销', async () => {
    await openWith([video({ src: URL_A, duration: 2_000 }), audio({ duration: 4_000 })])
    /** 先用菜单做一次、撤销一步，再用「属性」做一次：两次存下来的一样，撤销一步就回到做之前。 */
    const sameAsInspector = async (
      label: string,
      item: string,
      viaInspector: () => Promise<void>,
    ) => {
      const before = savedFilm()
      await choose(label, item)
      await waitSaved(() => expect(savedFilm()).not.toBe(before))
      const viaMenu = savedFilm()
      await user().click(undoButton())
      await waitSaved(() => expect(savedFilm()).not.toBe(viaMenu))
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      const undone = savedFilm()
      await viaInspector()
      await waitSaved(() => expect(savedFilm()).not.toBe(undone))
      expect(savedFilm()).toBe(viaMenu)
      await user().click(undoButton())
      await waitSaved(() => expect(savedFilm()).toBe(undone))
    }
    await sameAsInspector('A · 镜头 1', '静音此片段', () =>
      user().click(within(inspector()).getByRole('switch', { name: '关闭原声' })),
    )
    await sameAsInspector('A · 镜头 1', '隐藏片段画面', () =>
      user().click(within(inspector()).getByRole('button', { name: '隐藏' })),
    )
    await sameAsInspector('配乐', '静音此片段', () =>
      user().click(within(inspector()).getByRole('button', { name: '静音' })),
    )
  })

  it('片段上右键只出片段的菜单，空档上右键只出空档的菜单；在打开的菜单上再点右键不换成空档的菜单', async () => {
    // 片段从 2 秒开始，开头是一段空档
    await openWith([video({ src: URL_A, start: 2_000, duration: 2_000 })])
    const row = screen.getByRole('group', { name: '画面 1' })
    fireEvent.contextMenu(row, { clientX: 0 })
    const gap = await screen.findByRole('menu', { name: '空档' })
    expect(itemsOf(gap)).toEqual(['合拢此空档', '合拢该行的所有空档'])
    await closeMenu()

    const menu = await openMenu('A · 镜头 1')
    expect(screen.getAllByRole('menu')).toEqual([menu])
    fireEvent.contextMenu(within(menu).getByRole('menuitem', { name: '静音此片段' }), {
      clientX: 0,
    })
    expect(screen.queryByRole('menu', { name: '空档' })).toBeNull()
    expect(screen.getAllByRole('menu')).toEqual([menu])
  })

  it('菜单开着时按 Esc 只关菜单、选中不变；菜单里按的键不当快捷键', async () => {
    await openWith([video({ src: URL_A, duration: 2_000 })])
    await openMenu('A · 镜头 1')
    await user().keyboard('{Delete}{Backspace}m')
    await closeMenu()
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    expect(pressedOf('A · 镜头 1')).toBe('true')
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedClips()).toHaveLength(1)
  })

  it('拖片段、框选进行中点右键：不出菜单，也不打断拖动', async () => {
    await openWith([video({ src: URL_A, start: 1_000, duration: 2_000 })])
    const body = within(clipOf('A · 镜头 1')).getByRole('button', { name: /^选中：/ })
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 200, clientY: 50 })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    fireEvent.contextMenu(screen.getByRole('group', { name: '画面 1' }), { clientX: 0 })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 200, clientY: 50 })
    await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-start="1"'))

    const row = screen.getByRole('group', { name: '画面 1' })
    fireEvent.pointerDown(row, { button: 0, pointerId: 2, clientX: 0, clientY: 50 })
    fireEvent.pointerMove(row, { pointerId: 2, clientX: 300, clientY: 80 })
    expect(screen.getByTestId('marquee')).toBeInTheDocument()
    fireEvent.contextMenu(row, { clientX: 0 })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.pointerUp(row, { pointerId: 2, clientX: 300, clientY: 80 })
    expect(screen.queryByTestId('marquee')).toBeNull()
  })
})

describe('final-cut 编辑器 · 切开', () => {
  // 画面 1：A 镜头 1 在 0–2 秒、B 镜头 1 在 2–3.5 秒；画面 2：贴片在 0–3 秒
  const film = () =>
    mainFile(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000, mediaStart: 500 }),
        video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 1_500 }),
        host({ start: 0, duration: 3_000, track: 1 }),
      ],
      { width: 720, height: 1280 },
    )
  const open = async () => {
    putMockProjectMain(CONVERSATION, film())
    const user = userEvent.setup()
    await openEditor()
    return user
  }
  const lanes = () => screen.getByRole('group', { name: '画面 1' })
  /** 选中片段的按钮：`label` 是名字，名字重了时连时长一起写（「A · 镜头 1，0.8 秒」）。 */
  const body = (label: string) =>
    screen.getByRole('button', { name: new RegExp(`^选中：${label}(，|$)`) })
  const pressedOf = (label: string) => body(label).getAttribute('aria-pressed')
  /** 时间线上的片段，按名字和时长，按时间线上的先后。 */
  const shownClips = () =>
    screen
      .getAllByRole('button', { name: /^选中：/ })
      .map((each) => each.getAttribute('aria-label'))
  /** 存出的文件里的视频片段：起点、时长、入点（秒）。 */
  const savedVideos = () =>
    savedClips().map((tag) =>
      ['data-start', 'data-duration', 'data-media-start'].map(
        (name) => new RegExp(`${name}="([\\d.]+)"`).exec(tag)?.[1],
      ),
    )
  /** 把播放头挪到第 `tenths` 个 0.1 秒（从 0 起）。 */
  const playheadTo = async (user: ReturnType<typeof userEvent.setup>, tenths: number) => {
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    editorRoot().focus()
    await user.keyboard('{ArrowRight}'.repeat(tenths))
  }
  const picker = (name: string) =>
    within(toolbar()).getByRole('button', { name: `选择工具：${name}` })
  // 测试里时间线没有宽度，按一秒 100 像素排：横坐标 x 就是第 x × 10 毫秒
  const razorAt = (target: HTMLElement, x: number, shiftKey = false) =>
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: 10,
      shiftKey,
    })

  it('按 S 在播放头处切开选中的片段：后半段紧跟着、入点接上，选着的还是前半段，一步撤销', async () => {
    const user = await open()
    await playheadTo(user, 8)
    await user.click(body('A · 镜头 1'))
    editorRoot().focus()
    // 键被用掉了：不往别处传
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()).toEqual([
      ['0', '0.8', '0.5'],
      ['0.8', '1.2', '1.3'],
      ['2', '1.5', '0'],
    ])
    expect(shownClips()).toEqual([
      '选中：A · 镜头 1，0.8 秒',
      '选中：A · 镜头 1，1.2 秒',
      '选中：B · 镜头 1，1.5 秒',
      '选中：测试可填项，3.0 秒',
    ])
    expect(body('A · 镜头 1，0.8 秒')).toHaveAttribute('aria-pressed', 'true')
    expect(body('A · 镜头 1，1.2 秒')).toHaveAttribute('aria-pressed', 'false')

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
  })

  it('S 切不开时什么都不做：没选中、播放头不在选中的片段里；选中了多个时提示只选一个', async () => {
    const user = await open()
    await playheadTo(user, 8)
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await user.click(body('B · 镜头 1'))
    editorRoot().focus()
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await user.keyboard('{Shift>}')
    await user.click(body('A · 镜头 1'))
    await user.keyboard('{/Shift}')
    editorRoot().focus()
    await user.keyboard('s')
    expect(await screen.findByText('选中了多个片段，无法切开；请只选中一个片段')).toBeVisible()
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedClips()).toHaveLength(2)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('选择工具的下拉里「在播放头处切开」：切不开时置灰、悬停说明原因；能切时点了就切', async () => {
    const user = await open()
    await playheadTo(user, 8)
    await user.click(picker('选择'))
    const item = () =>
      within(screen.getByRole('menu', { name: '选择工具：选择' })).getByRole('menuitem', {
        name: /^在播放头处切开/,
      })
    expect(item()).toHaveAttribute('aria-disabled', 'true')
    expect(item()).toHaveTextContent('S')
    await user.hover(item())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '尚未选中片段，无法切开；请先选中一个片段',
    )
    await user.click(item())
    expect(screen.getByRole('menu', { name: '选择工具：选择' })).toBeVisible()
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(body('B · 镜头 1'))
    await user.click(picker('选择'))
    await user.hover(item())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '播放头不在片段里，无法切开；请把播放头移到片段里面',
    )
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(body('A · 镜头 1'))
    await user.click(picker('选择'))
    expect(item()).not.toHaveAttribute('aria-disabled')
    await user.click(item())
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
  })

  it('B 换成切开工具：下拉按钮跟着变；点片段在点的地方切开、选中不变，点得太靠边夹进 0.1 秒', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    editorRoot().focus()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    await user.click(picker('切开'))
    const menu = await screen.findByRole('menu', { name: '选择工具：切开' })
    expect(within(menu).getByRole('menuitemradio', { name: '切开' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // 指针在各行上时有一条竖线跟着它
    fireEvent.pointerMove(lanes(), { clientX: 50, clientY: 10 })
    expect(screen.getByTestId('razor-line')).toHaveStyle({ left: '50px' })
    fireEvent.pointerLeave(lanes())
    expect(screen.queryByTestId('razor-line')).toBeNull()

    razorAt(body('A · 镜头 1'), 50)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos().slice(0, 2)).toEqual([
      ['0', '0.5', '0.5'],
      ['0.5', '1.5', '1'],
    ])
    expect(pressedOf('B · 镜头 1')).toBe('true')
    expect(pressedOf('A · 镜头 1，0.5 秒')).toBe('false')

    // 点在离开头 0.01 秒处：切在离开头 0.1 秒（最短片段长度）处
    razorAt(body('B · 镜头 1'), 201)
    await waitSaved(() => expect(savedClips()).toHaveLength(4))
    expect(savedVideos().slice(2)).toEqual([
      ['2', '0.1', '0'],
      ['2.1', '1.4', '0.1'],
    ])
  })

  it('切开工具切的是指针所在那一行、那个时间上的片段，不看按下的是哪个元素', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    // 按在 A 上、指针的时间已经在 B 上（2.5 秒）：切的是 B
    razorAt(body('A · 镜头 1'), 250)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '0.5', '0'],
      ['2.5', '1', '0.5'],
    ])
  })

  it('切开工具下按着 Shift 点：在那个时间把所有能切的片段一起切开，点在空白处也一样', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    razorAt(lanes(), 100, true)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(shownClips()).toEqual([
      '选中：A · 镜头 1，1.0 秒',
      '选中：A · 镜头 1，1.0 秒',
      '选中：B · 镜头 1，1.5 秒',
      '选中：测试可填项，1.0 秒',
      '选中：测试可填项，2.0 秒',
    ])
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).not.toHaveAttribute(
      'aria-disabled',
    )
    // 一步撤销：两个片段都回去
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(shownClips()).toHaveLength(3))
  })

  it('切开工具下选中的片段没有裁剪把手：原来聚焦在把手上时焦点交还编辑器，按方向键不改文件；回到选择后把手回来', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    within(lanes()).getByRole('slider', { name: '裁剪结尾' }).focus()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    expect(within(lanes()).queryAllByRole('slider', { name: /^裁剪/ })).toEqual([])
    expect(editorRoot()).toHaveFocus()
    await user.keyboard('{ArrowLeft}{Shift>}{ArrowRight}{/Shift}')
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '1.5', '0'],
    ])
    expect(pressedOf('B · 镜头 1')).toBe('true')

    await user.keyboard('v')
    expect(within(lanes()).getAllByRole('slider', { name: /^裁剪/ })).toHaveLength(2)
  })

  it('切开工具下不能拖片段、不能框选、点片段（含按 Enter）不选中；Esc 先取消选中再回到选择，V 也回到选择', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    editorRoot().focus()
    await user.keyboard('b')
    // 在片段上按下又拖：只是在按下的地方切一刀，片段不跟着走
    const host = body('测试可填项')
    razorAt(host, 290)
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 100, clientY: 40 })
    fireEvent.pointerUp(host, { pointerId: 1, clientX: 100, clientY: 40 })
    await waitSaved(() => expect(savedFilm()).toContain('data-start="0" data-duration="2.9"'))
    expect(savedFilm()).toMatch(/data-start="2.9" data-duration="0.1"/)
    // 在空白处按下又拖：不出框
    razorAt(lanes(), 380)
    fireEvent.pointerMove(lanes(), { pointerId: 1, clientX: 100, clientY: 40 })
    expect(screen.queryByTestId('marquee')).toBeNull()
    fireEvent.pointerUp(lanes(), { pointerId: 1, clientX: 100, clientY: 40 })
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '1.5', '0'],
    ])
    body('A · 镜头 1').focus()
    await user.keyboard('{Enter}')
    expect(pressedOf('A · 镜头 1')).toBe('false')
    expect(pressedOf('B · 镜头 1')).toBe('true')

    editorRoot().focus()
    await user.keyboard('{Escape}')
    expect(pressedOf('B · 镜头 1')).toBe('false')
    expect(picker('切开')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(picker('选择')).toBeVisible()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    await user.keyboard('v')
    expect(picker('选择')).toBeVisible()
    await user.keyboard('b')
    await user.keyboard('a')
    expect(picker('选择')).toBeVisible()
    // 回到选择以后点片段又是选中
    await user.click(body('A · 镜头 1'))
    expect(pressedOf('A · 镜头 1')).toBe('true')
  })

  it('切开工具下片段的右键菜单照常能用：选里面的项不当成在时间线上点了一下', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    const clip = screen.getByRole('group', { name: /^B · 镜头 1，/ })
    fireEvent.pointerDown(clip, { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clip)
    const menu = await screen.findByRole('menu', { name: 'B · 镜头 1' })
    const mute = within(menu).getByRole('menuitem', { name: '静音此片段' })
    // 按着 Shift 在菜单项上按下：不在那个位置切开所有片段
    razorAt(mute, 100, true)
    await user.click(mute)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitSaved(() => expect(savedClips()[1]).toContain('muted="true"'))
    expect(savedClips()).toHaveLength(2)
    expect(shownClips()).toHaveLength(3)
  })

  it('片段右键菜单最上面是「在播放头处切开」：播放头在片段里时能切，不在时置灰、悬停说明原因', async () => {
    const user = await open()
    await playheadTo(user, 8)
    const openMenu = async (label: string) => {
      const clip = screen.getByRole('group', { name: new RegExp(`^${label}，`) })
      fireEvent.pointerDown(clip, { button: 2, pointerType: 'mouse' })
      fireEvent.contextMenu(clip)
      return screen.findByRole('menu', { name: label })
    }
    const splitItem = (menu: HTMLElement) =>
      within(menu).getByRole('menuitem', { name: /^在播放头处切开/ })

    const outside = await openMenu('B · 镜头 1')
    expect(splitItem(outside)).toHaveAttribute('aria-disabled', 'true')
    await user.hover(splitItem(outside))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '播放头不在片段里，无法切开；请把播放头移到片段里面',
    )
    await user.click(splitItem(outside))
    expect(screen.getByRole('menu', { name: 'B · 镜头 1' })).toBeVisible()
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    const inside = await openMenu('A · 镜头 1')
    expect(splitItem(inside)).not.toHaveAttribute('aria-disabled')
    expect(splitItem(inside)).toHaveTextContent('S')
    await user.click(splitItem(inside))
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()[1]).toEqual(['0.8', '1.2', '1.3'])
  })
})

describe('final-cut 编辑器 · 分离音频', () => {
  const openWith = async (clips: Parameters<typeof mainFile>[0]) => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }))
    await openEditor()
    return userEvent.setup()
  }
  const clipOf = (label: string) => screen.getByRole('group', { name: new RegExp(`^${label}，`) })
  const select = (user: ReturnType<typeof userEvent.setup>, label: string) =>
    user.click(within(clipOf(label)).getByRole('button', { name: /^选中：/ }))
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const savedTags = () => savedFilm().match(/<(video|audio) [^>]*>/g) ?? []
  const pair = (offset = 0) => [
    audio({
      id: 'voice',
      label: 'A · 镜头 1 · 原声',
      src: URL_A,
      start: 1_000 + offset,
      duration: 2_000,
      link: offset === 0 ? 'lk-1' : null,
      syncOrigin: 'lk-1',
    }),
    video({
      src: URL_A,
      start: 1_000,
      duration: 2_000,
      muted: true,
      link: offset === 0 ? 'lk-1' : null,
      syncOrigin: 'lk-1',
    }),
  ]

  it('选中有声音的视频片段点「分离音频」：声音区最上面多一条「人声」行、选中原声，同步栏写口型同步、小标写联动；⇧⌘B 合并回视频', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      audio({ start: 0, duration: 4_000 }),
    ])
    const button = () => within(toolbar()).getByRole('button', { name: /^(分离音频|合并回视频)$/ })
    expect(button()).toHaveAccessibleName('分离音频')
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    await select(user, 'A · 镜头 1')
    await waitFor(() => expect(button()).not.toHaveAttribute('aria-disabled'))
    await user.click(button())

    expect(screen.getByRole('group', { name: '人声' })).toBeVisible()
    expect(screen.getByRole('group', { name: '配乐' })).toBeVisible()
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/，联动$/)
    expect(within(inspector()).getByRole('heading', { name: 'A · 镜头 1 · 原声' })).toBeVisible()
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面口型同步')
    expect(within(inspector()).getByRole('switch', { name: '联动' })).toBeChecked()
    expect(button()).toHaveAccessibleName('合并回视频')
    await waitSaved(() => expect(savedTags()).toHaveLength(3))
    // 原声写在视频片段前面
    expect(savedTags()[0]).toMatch(/^<audio [^>]*data-sync-origin="lk-1"/)
    expect(savedTags()[1]).toMatch(/^<video [^>]*data-sync-origin="lk-1"/)

    editorRoot().focus()
    await user.keyboard('{Shift>}{Meta>}b{/Meta}{/Shift}')
    expect(screen.queryByRole('group', { name: '人声' })).toBeNull()
    expect(within(inspector()).getByRole('heading', { name: 'A · 镜头 1' })).toBeVisible()
    await waitSaved(() => expect(savedTags()).toHaveLength(2))
    expect(savedTags()[0]).toContain('data-has-audio="true"')
  })

  it('不能分离：素材没有声音、已关闭原声时按钮置灰并说明原因', async () => {
    const user = await openWith([video({ src: URL_A, duration: 2_000, muted: true })])
    await select(user, 'A · 镜头 1')
    const detach = within(inspector()).getByRole('button', { name: '分离音频' })
    expect(detach).toHaveAttribute('aria-disabled', 'true')
    await user.click(detach)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '已关闭原声，无法分离音频；请先打开原声',
    )
    expect(savedTags()).toHaveLength(1)
  })

  it('原声单独挪开了：时间线小标和同步栏写错开多少，视频片段那边合并置灰；「对齐画面」挪回去，联动仍关着', async () => {
    const user = await openWith(pair(400))
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/，错开 \+0\.40s$/)

    await select(user, 'A · 镜头 1')
    expect(within(inspector()).getByText('原声已分离至「人声」行')).toBeVisible()
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('错开 +0.40s')
    expect(within(inspector()).getByRole('switch', { name: '与分离原声联动' })).not.toBeChecked()
    expect(within(inspector()).queryByRole('switch', { name: '关闭原声' })).toBeNull()
    const merge = within(inspector()).getByRole('button', { name: '合并' })
    expect(merge).toHaveAttribute('aria-disabled', 'true')
    await user.hover(merge)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('原声和画面没对齐，请先对齐口型')

    await user.click(within(inspector()).getByRole('button', { name: '定位分离原声' }))
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面错开 +0.40 秒')
    await user.click(within(inspector()).getByRole('button', { name: '对齐画面' }))
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面口型同步')
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/秒$/)
    await waitSaved(() => expect(savedTags()[0]).toContain('data-start="1"'))
    expect(savedTags()[0]).not.toContain('data-link')
  })

  it('联动开着：改原声的倍速两段一起改；删掉其中一段时两段都删', async () => {
    const user = await openWith(pair())
    await select(user, 'A · 镜头 1 · 原声')
    await user.click(within(inspector()).getByRole('button', { name: /^倍速 1x/ }))
    await user.keyboard('2{Enter}')
    await waitSaved(() =>
      expect(savedTags().map((tag) => tag.includes('data-playback-rate="2"'))).toEqual([
        true,
        true,
      ]),
    )
    await select(user, 'A · 镜头 1')
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedTags()).toHaveLength(0))
  })

  it('一对里的片段的右键菜单：选中另一段、联动开关、合并回视频；视频片段没有静音', async () => {
    await openWith(pair())
    fireEvent.pointerDown(clipOf('A · 镜头 1'), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    const menu = await screen.findByRole('menu', { name: 'A · 镜头 1' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      '在播放头处切开S',
      '选中分离的原声片段',
      '解除与画面的联动',
      '合并回视频⇧⌘B',
      '隐藏片段画面',
      '删除片段Delete',
    ])
    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: '解除与画面的联动' }))
    await waitSaved(() => expect(savedTags().join('')).not.toContain('data-link'))
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

  it('连着按方向键按几下走几步：预览晚报回来的上一次跳转的时刻不把播放头拉回去', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    editorRoot().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    // 真播放器的时刻由运行库异步报回：第一次跳转的时刻在预览页处理完第二次跳转以后才到
    previewPlayer().dispatchEvent(new CustomEvent('timeupdate', { detail: { currentTime: 0.1 } }))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.20 / 00:03.50')

    await user.keyboard('{ArrowRight}')
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.30 / 00:03.50')
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

    // 加的片段直接打进预览里正在播的那一份
    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(
        previewPlayer().iframeElement.contentDocument?.querySelector(`video[src="${URL_B}"]`),
      ).not.toBeNull(),
    )
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

  it('选 2×：素材预览和 final-cut 预览都是 2×，加进 final-cut 的片段直接打进预览，还是 2×', async () => {
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
    await waitFor(() =>
      expect(player().iframeElement.contentDocument?.querySelectorAll('video')).toHaveLength(3),
    )
    expect(player()).toBe(old)
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
    locale: null,
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
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
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

  it('侧栏六个页签：镜头、贴片、场景、配乐、字幕、属性；贴片、场景各记着自己的搜索词和分类，切走再回来还在', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(
      within(side())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['镜头', '贴片', '场景', '配乐', '字幕', '属性'])
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
    within(
      screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
    ).getByRole('tab', { name })
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

    it('「−」「+」一次改 0.5 秒，开始不动；每按一次算一步撤销，连按两次撤销一次只退回一次', async () => {
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
      await user.click(step('缩短 0.5 秒'))
      expect(field()).toHaveValue('1.00')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="1"'))
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="1.5"'))
      expect(field()).toHaveValue('1.50')
      expect(undoButton()).not.toHaveAttribute('aria-disabled')
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
      expect(within(inspector()).getByText('· 镜头组 1 · A · V1')).toBeVisible()
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

    it('片段用的素材不在出片里：标题写片段自己的名字，照样读到总长，能截取', async () => {
      const user = await openWith([video({ src: URL_OLD, duration: 2_000 })])
      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).getByText('· A · 镜头 1')).toBeVisible()
      await waitFor(() => expect(summary()).toHaveTextContent('0.00 – 2.00s / 5.0s'))
      handle('裁剪结尾').focus()
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
      expect(summary()).toHaveTextContent('0.00 – 3.00s / 5.0s')
      await waitSaved(() => expect(savedClips()[0]).toContain('data-duration="3"'))
    })

    it('素材总长读不出来：条上写原因，没有框和抓手，按下不改', async () => {
      const user = await openWith([
        video({ src: 'https://media.test/videos/elsewhere.mp4', duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, 'A · 镜头 1')
      expect(await within(strip()).findByText('视频时长无效，无法分段')).toBeVisible()
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
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
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

const EMPTY_CAPTIONS_TEXT = '暂无字幕，请点击「识别字幕」或「在播放头处加一句」'

describe('final-cut 编辑器 · 字幕页签', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const openCaptions = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(within(side()).getByRole('tab', { name: '字幕' }))
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const addButton = () => within(panel()).getByRole('button', { name: '在播放头处加一句' })
  const savedScene = () =>
    mockWorkspaceFile(CONVERSATION, `final-cut/${CAPTIONS_PATH}`)?.content ?? ''
  /** 存下来的主文件根上声明的变量的默认值。 */
  const savedTexts = () =>
    (
      JSON.parse(
        new DOMParser()
          .parseFromString(savedFilm(), 'text/html')
          .documentElement.getAttribute('data-composition-variables') ?? '[]',
      ) as { default: unknown }[]
    ).map((declaration) => declaration.default)

  it('还没有工程时「在播放头处加一句」置灰并说明原因', async () => {
    const user = userEvent.setup()
    await openEditor()
    await openCaptions(user)
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(addButton())
    expect(
      (await screen.findAllByText('final-cut 暂无内容，无法加字幕；请先加入镜头')).length,
    ).toBeGreaterThan(0)
  })

  it('加一句：列表里出现、焦点进文字框；同一处再加置灰；改字存进主文件的变量和字幕文件；删掉回到空的', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await openCaptions(user)
    expect(within(panel()).getByText(EMPTY_CAPTIONS_TEXT)).toBeVisible()

    await user.click(addButton())
    const field = await within(panel()).findByRole('textbox', {
      name: '字幕文字 00:00.00 – 00:02.00',
    })
    expect(field).toHaveValue('新字幕')
    expect(field).toHaveFocus()
    expect(within(panel()).getByRole('listitem')).toHaveAttribute('aria-current', 'true')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(addButton())
    expect(
      (await screen.findAllByText('播放头处已有字幕，无法再加一句；请把播放头移到没有字幕的地方'))
        .length,
    ).toBeGreaterThan(0)

    // 回车是换行；写进去以后焦点还在框里
    await user.clear(field)
    await user.type(field, '第一句{Enter}第二行')
    await waitSaved(() => expect(savedTexts()).toEqual(['第一句\n第二行']))
    await waitSaved(() => expect(savedScene()).toContain('>第一句<br>第二行</div>'))
    expect(field).toHaveFocus()

    await user.click(
      within(panel()).getByRole('button', { name: '删除 00:00.00 – 00:02.00 的字幕' }),
    )
    expect(within(panel()).getByText(EMPTY_CAPTIONS_TEXT)).toBeVisible()
    await waitSaved(() => expect(savedTexts()).toEqual([]))
    expect(savedScene()).not.toContain('class="clip caption"')
  })

  it('字幕写法不对（宿主带了取值）：导出置灰写原因，字幕页签里也显示这句', async () => {
    const user = userEvent.setup()
    const canvas = { width: 720, height: 1280 }
    const host = captionsHostElement(canvas, 2_000).replace(
      'data-no-timeline',
      'data-no-timeline data-variable-values="{}"',
    )
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A })], canvas).replace(
        '</div>\n</body>',
        `${host}\n</div>\n</body>`,
      ),
    )
    putMockWorkspaceFile(
      CONVERSATION,
      `final-cut/${CAPTIONS_PATH}`,
      captionsScene(canvas, fixtureCatalog),
    )
    await openEditor()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.click(exportButton)
    expect((await screen.findAllByText(CAPTIONS_PROBLEM_TEXT)).length).toBeGreaterThan(0)
    await openCaptions(user)
    expect(within(panel()).getByRole('alert')).toHaveTextContent(CAPTIONS_PROBLEM_TEXT)
  })
})

describe('final-cut 编辑器 · 时间线上的字幕', () => {
  const CANVAS = { width: 720, height: 1280 }
  const SCENE = `final-cut/${CAPTIONS_PATH}`
  // 画面 1：视频 0–2 秒；字幕：0–1、1.5–2.5、3–4 秒三句；配乐 0–4 秒
  const lines = [
    caption({ id: 'cap-a1', variable: 'cap_a1', start: 0, duration: 1_000, text: '第一句' }),
    caption({ id: 'cap-b2', variable: 'cap_b2', start: 1_500, duration: 1_000, text: '第二句' }),
    caption({ id: 'cap-c3', variable: 'cap_c3', start: 3_000, duration: 1_000, text: '第三句' }),
  ]
  const others = [video({ src: URL_A, duration: 2_000 }), audio({ duration: 4_000 })]

  /** 工作区里放一份带字幕的工程（照编辑器用 SDK 写的样子），打开编辑器。 */
  const open = async () => {
    const main = await openComposition(mainFile(others, CANVAS))
    main.addElement('film', 99, captionsHostElement(CANVAS, 4_000))
    for (const each of lines) main.declareVariable(captionVariable(each))
    putMockWorkspaceFile(CONVERSATION, SCENE, captionsScene(CANVAS, fixtureCatalog, lines))
    putMockProjectMain(CONVERSATION, main.serialize())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  const captionRow = () => screen.getByRole('group', { name: '字幕' })
  const clipOf = (text: string) => screen.getByRole('group', { name: new RegExp(`^${text}，`) })
  const bodyOf = (text: string) =>
    within(clipOf(text)).getByRole('button', { name: new RegExp(`^选中：${text}，`) })
  /** 存下来的字幕场景里各句的「编号、开始、时长」（秒）。 */
  const savedLines = () =>
    [
      ...new DOMParser()
        .parseFromString(
          (mockWorkspaceFile(CONVERSATION, SCENE)?.content ?? '').replace(/<\/?template>/g, ''),
          'text/html',
        )
        .querySelectorAll('.caption'),
    ].map((element) => [
      element.id,
      Number(element.getAttribute('data-start')),
      Number(element.getAttribute('data-duration')),
    ])
  /** 存下来的主文件里字幕宿主带没带隐藏标记。 */
  const hostHidden = () =>
    new DOMParser()
      .parseFromString(savedFilm(), 'text/html')
      .getElementById('captions')
      ?.hasAttribute('data-hidden')
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  /**
   * 拖片段：测试里时间线按一秒 100 像素排、没有排版（片段的左边都量成 0），拖 `dx` 像素就是想挪到
   * 第 `dx` × 10 毫秒。
   */
  const drag = (target: HTMLElement, dx: number) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
  }

  it('「字幕」一行在画面区和声音区之间，行头是名字和眼睛；每句是一个片段，写着这句的字', async () => {
    await open()
    const rows = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
      .filter((name) => name === '画面 1' || name === '字幕' || name === '配乐')
    expect(rows).toEqual(['画面 1', '字幕', '配乐'])
    expect(
      within(captionRow())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['第一句，1.0 秒', '第二句，1.0 秒', '第三句，1.0 秒'])
    expect(within(clipOf('第二句')).getByText('第二句')).toBeVisible()
    expect(screen.getByRole('button', { name: '隐藏字幕' }).parentElement).toHaveTextContent(
      /^字幕$/,
    )
  })

  it('拖着挪一句：碰到后一句就停；把手上按方向键裁结尾，不压到后一句；都写进字幕场景，各一步撤销', async () => {
    const user = await open()
    // 想挪到 0.8 秒：会压到 1.5 秒开始的第二句，停在 0.5 秒
    drag(bodyOf('第一句'), 80)
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0.5, 1]))
    expect(savedLines().slice(1)).toEqual([
      ['cap-b2', 1.5, 1],
      ['cap-c3', 3, 1],
    ])

    await user.click(bodyOf('第二句'))
    const end = within(clipOf('第二句')).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 0.9]))
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 1.5]))

    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 0.9]))
    await user.click(undoButton())
    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1]))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('删一句：选中按 Delete，或者右键选「删除字幕」（菜单里只有这一项）；开着波纹编辑别的片段也不动', async () => {
    const user = await open()
    await user.click(bodyOf('第一句'))
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedLines().map(([id]) => id)).toEqual(['cap-b2', 'cap-c3']))
    expect(savedClips()[0]).toContain('data-start="0" data-duration="2"')

    fireEvent.pointerDown(clipOf('第二句'), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf('第二句'))
    const menu = await screen.findByRole('menu', { name: '第二句' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['删除字幕Delete'])
    await user.click(within(menu).getByRole('menuitem', { name: /^删除字幕/ }))
    await waitSaved(() => expect(savedLines().map(([id]) => id)).toEqual(['cap-c3']))
  })

  it('和视频片段一起多选：一起挪同样的时间，一起删；删除一步撤销两个都回来', async () => {
    const user = await open()
    await user.click(within(screen.getByRole('group', { name: '画面 1' })).getByRole('button'))
    await user.keyboard('{Shift>}')
    await user.click(bodyOf('第三句'))
    await user.keyboard('{/Shift}')
    drag(bodyOf('第三句'), 350)
    await waitSaved(() => expect(savedLines()[2]).toEqual(['cap-c3', 3.5, 1]))
    await waitSaved(() => expect(savedClips()[0]).toContain('data-start="0.5"'))

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(0))
    expect(savedLines().map(([id]) => id)).toEqual(['cap-a1', 'cap-b2'])
    await user.click(undoButton())
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedLines().map(([id]) => id)).toEqual(['cap-a1', 'cap-b2', 'cap-c3'])
  })

  it('点行头的眼睛：隐藏标记写在字幕宿主上，每句都标成已隐藏；再点显示回来', async () => {
    const user = await open()
    await user.click(screen.getByRole('button', { name: '隐藏字幕' }))
    await waitSaved(() => expect(hostHidden()).toBe(true))
    expect(
      within(captionRow())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['第一句，1.0 秒，已隐藏', '第二句，1.0 秒，已隐藏', '第三句，1.0 秒，已隐藏'])
    expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).not.toContain('data-hidden')

    await user.click(screen.getByRole('button', { name: '显示字幕' }))
    await waitSaved(() => expect(hostHidden()).toBe(false))
    expect(screen.getByRole('button', { name: '隐藏字幕' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('切开工具点在字幕上什么都不做；按着 Shift 点只切开那个时间上的视频片段，字幕不切', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    const razorAt = (x: number, shiftKey = false) =>
      fireEvent.pointerDown(captionRow(), {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: 10,
        shiftKey,
      })
    razorAt(50)
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    razorAt(50, true)
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(savedLines()).toEqual([
      ['cap-a1', 0, 1],
      ['cap-b2', 1.5, 1],
      ['cap-c3', 3, 1],
    ])
  })

  it('选中一句时的「属性」：头部是字、「字幕」、时长和删除，没有隐藏；改字停下才写进去、改时长按「+」，各一步撤销', async () => {
    const user = await open()
    await user.click(bodyOf('第一句'))
    const inspector = screen.getByRole('tabpanel', { name: '属性' })
    expect(within(inspector).getByRole('heading', { name: '第一句' })).toBeVisible()
    expect(within(inspector).getByText('字幕')).toBeVisible()
    expect(within(inspector).getByText('1.00s')).toBeVisible()
    expect(within(inspector).getByRole('button', { name: '删除' })).toBeVisible()
    expect(within(inspector).queryByRole('button', { name: '隐藏' })).toBeNull()

    const field = within(inspector).getByRole('textbox', { name: '内容' })
    expect(field).toHaveValue('第一句')
    await user.clear(field)
    await user.type(field, '改过的{Enter}两行')
    await waitSaved(() =>
      expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).toContain('>改过的<br>两行</div>'),
    )
    // 名字里的换行合成一个空格；文字框里照旧是换行
    expect(clipOf('改过的 两行')).toBeVisible()
    expect(within(inspector).getByRole('heading', { name: '改过的 两行' })).toBeVisible()
    expect(field).toHaveValue('改过的\n两行')
    await user.click(undoButton())
    await waitSaved(() =>
      expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).toContain('>第一句</div>'),
    )
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

    // 第二句从 1.5 秒开始：结尾最多拉到那里
    await user.click(within(inspector).getByRole('button', { name: '延长 0.5 秒' }))
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1.5]))
    expect(within(inspector).getByRole('button', { name: '延长 0.5 秒' })).toBeDisabled()
    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1]))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('停在「字幕」页签时在时间线上选中片段（字幕、视频都一样）不切走，选中的字幕在列表里标成当前；在页签里点一句的时间：选中它、播放头到它的开始', async () => {
    const user = await open()
    const side = screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
    await user.click(within(side).getByRole('tab', { name: '字幕' }))
    const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
    const current = () =>
      within(panel())
        .getAllByRole('listitem')
        .filter((item) => item.getAttribute('aria-current') === 'true')
        .map((item) => within(item).getByRole('textbox').getAttribute('aria-label'))

    await user.click(bodyOf('第二句'))
    expect(panel()).toBeVisible()
    expect(current()).toEqual(['字幕文字 00:01.50 – 00:02.50'])
    await user.click(within(screen.getByRole('group', { name: '画面 1' })).getByRole('button'))
    expect(panel()).toBeVisible()
    expect(current()).toEqual([])

    await user.click(within(panel()).getByRole('button', { name: '00:03.00 – 00:04.00' }))
    expect(bodyOf('第三句')).toHaveAttribute('aria-pressed', 'true')
    expect(current()).toEqual(['字幕文字 00:03.00 – 00:04.00'])
    expect(progress()).toHaveAttribute('aria-valuetext', '00:03.00 / 00:04.00')
    expect(panel()).toBeVisible()
  })

  it('停在别的页签时在时间线上选中字幕：照常切到「属性」', async () => {
    const user = await open()
    await user.click(bodyOf('第二句'))
    expect(screen.getByRole('tabpanel', { name: '属性' })).toBeVisible()
  })

  it('字幕那一行的空白处点右键什么都不出：合拢会把字幕从说话的时间上挪开', async () => {
    await open()
    // 1.2 秒处是第一句和第二句之间的空档（测试里一秒 100 像素）
    fireEvent.contextMenu(captionRow(), { clientX: 120 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

/** 字幕场景里的一句：`owner` 是它属于的视频片段，手动加的是 null。 */
type SceneLine = Pick<CaptionClip, 'id' | 'start' | 'duration' | 'variable' | 'text' | 'owner'>
const sceneLine = (key: string, start: number, duration: number, owner: string | null = null) => ({
  id: `cap-${key}`,
  variable: `cap_${key}`,
  text: `字幕 ${key}`,
  start,
  duration,
  owner,
})

const CAPTION_CANVAS = { width: 720, height: 1280 }
const SCENE_FILE = `final-cut/${CAPTIONS_PATH}`

/** 工作区里放一份工程：主文件按 `clips` 写；有 `lines` 时照编辑器用 SDK 写的样子加上字幕宿主、变量和场景文件。 */
const putFilm = async (clips: FilmClip[], lines: SceneLine[] = []) => {
  const main = await openComposition(mainFile(clips, CAPTION_CANVAS))
  if (lines.length > 0) {
    const end = Math.max(...[...clips, ...lines].map((clip) => clip.start + clip.duration))
    main.addElement('film', 99, captionsHostElement(CAPTION_CANVAS, end))
    for (const each of lines) main.declareVariable(captionVariable(each))
    putMockWorkspaceFile(
      CONVERSATION,
      SCENE_FILE,
      captionsScene(CAPTION_CANVAS, fixtureCatalog, lines),
    )
  }
  putMockProjectMain(CONVERSATION, main.serialize())
}

/** 存下来的字幕场景里各句的「字、开始、时长（秒）、属于哪个片段」，按文件里的先后。 */
const savedSceneLines = () =>
  [
    ...new DOMParser()
      .parseFromString(
        (mockWorkspaceFile(CONVERSATION, SCENE_FILE)?.content ?? '').replace(/<\/?template>/g, ''),
        'text/html',
      )
      .querySelectorAll('.caption'),
  ].map((element) => [
    element.textContent,
    Number(element.getAttribute('data-start')),
    Number(element.getAttribute('data-duration')),
    element.getAttribute('data-caption-of'),
  ])

/** 存下来的主文件根上声明的字幕变量的默认值。 */
const savedVariableTexts = () =>
  (
    JSON.parse(
      new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .documentElement.getAttribute('data-composition-variables') ?? '[]',
    ) as { default: unknown }[]
  ).map((declaration) => declaration.default)

const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })

const subtitleJob = (sourceJobId: string, overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({ kind: 'subtitle', sourceJobId, sentences: [], ...overrides })

const said = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text,
  speaker: null,
  words: [],
})

/**
 * 字幕识别记录：`stored` 是已有的记录。发起识别时记下素材片，答复一条排队中的记录，之后读到的是
 * `outcome(素材片)` 给的那一条（默认识别完成、没有句子）；`hold` 给了时发起识别的答复等它放行。
 */
const serveSubtitles = (
  stored: GenerationJob[],
  outcome: (sourceJobId: string) => GenerationJob = (source) => subtitleJob(source),
  hold?: Promise<void>,
) => {
  const records = [...stored]
  const submitted: string[] = []
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const params = new URL(request.url).searchParams
      if (params.get('kind') !== 'subtitle') return undefined
      const source = params.get('sourceJobId')
      return HttpResponse.json({ items: records.filter((job) => job.sourceJobId === source) })
    }),
    http.post('*/api/generations/subtitles', async ({ request }) => {
      const { sourceJobId } = (await request.json()) as { sourceJobId: string }
      submitted.push(sourceJobId)
      await hold
      records.unshift(outcome(sourceJobId))
      return HttpResponse.json(
        { generation: subtitleJob(sourceJobId, { status: 'submitted', sentences: null }) },
        { status: 202 },
      )
    }),
  )
  return submitted
}

describe('final-cut 编辑器 · 识别字幕', () => {
  const openCaptions = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    return screen.getByRole('tabpanel', { name: '字幕' })
  }
  const recognizeButton = (panel: HTMLElement) =>
    within(panel).getByRole('button', { name: /^(识别字幕|识别中…)$/ })
  const clipA = video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 })
  const clipB = video({
    id: 'clip-2',
    label: 'B · 镜头 1',
    src: URL_B,
    start: 2_000,
    duration: 1_500,
  })

  it('已有识别完成的记录：不发起识别，各片段的句子换算到 final-cut 里一次写进去，属于各自的片段，一步撤销', async () => {
    await putFilm([clipA, clipB])
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { sentences: [said(300, 1_200, '第一句话')] }),
      // 片段只用到素材的前 1.5 秒：后一句截到片段结尾
      subtitleJob(TAKE_B, { sentences: [said(200, 1_000, '第二段'), said(1_200, 2_500, '截短')] }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['第一句话', 0.3, 0.9, 'clip-1'],
        ['第二段', 2.2, 0.8, 'clip-2'],
        ['截短', 3.2, 0.3, 'clip-2'],
      ]),
    )
    expect(savedVariableTexts()).toEqual(['第一句话', '第二段', '截短'])
    expect(submitted).toEqual([])
    expect(await screen.findByText('已加入 3 句字幕')).toBeVisible()
    // 都有字幕了：不再识别
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')

    await user.click(undoButton())
    await waitSaved(() => expect(savedSceneLines()).toEqual([]))
    expect(savedVariableTexts()).toEqual([])
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('没有记录：同一条素材的两个片段只发起一次识别；识别中按钮写「识别中…」、写着在识别几个片段，结果来了一次写进去', async () => {
    // 两个片段用同一条素材的前后两段
    await putFilm([
      video({ label: '前半', src: URL_A, duration: 2_000 }),
      video({
        id: 'clip-2',
        label: '后半',
        src: URL_A,
        start: 2_000,
        duration: 2_000,
        mediaStart: 2_000,
      }),
    ])
    const user = userEvent.setup()
    await openEditor()
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const submitted = serveSubtitles(
      [],
      (source) =>
        subtitleJob(source, {
          sentences: [said(500, 1_500, '前一句'), said(2_500, 3_500, '后一句')],
        }),
      hold,
    )
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitFor(() => expect(recognizeButton(panel)).toHaveTextContent('识别中…'))
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    expect(within(panel).getByText('正在识别 2 个视频片段的字幕，可继续编辑')).toBeVisible()
    // 识别中再点不会再发起
    await user.click(recognizeButton(panel))
    release()
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['前一句', 0.5, 1, 'clip-1'],
        ['后一句', 2.5, 1, 'clip-2'],
      ]),
    )
    expect(submitted).toEqual([TAKE_A])
    expect(recognizeButton(panel)).toHaveTextContent('识别字幕')
    expect(within(panel).queryByText(/^正在识别/)).toBeNull()
  })

  it('这条素材正在识别：不再发起，等着它', async () => {
    await putFilm([clipA])
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { status: 'submitted', sentences: null }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(submitted).toEqual([])
    expect(recognizeButton(panel)).toHaveTextContent('识别中…')
    expect(within(panel).getByText('正在识别 1 个视频片段的字幕，可继续编辑')).toBeVisible()
  })

  it('已经有字幕的片段、关闭了原声又没分离的片段不识别，别的照常', async () => {
    await putFilm(
      [
        clipA,
        video({
          id: 'clip-2',
          label: '静音',
          src: URL_B,
          start: 2_000,
          duration: 1_500,
          muted: true,
        }),
        video({ id: 'clip-3', label: '有声', src: URL_B, start: 4_000, duration: 1_500 }),
      ],
      [sceneLine('a1', 0, 1_000, 'clip-1')],
    )
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { sentences: [said(1_200, 1_800, '不会写进去')] }),
      subtitleJob(TAKE_B, { sentences: [said(100, 900, '有声的话')] }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['字幕 a1', 0, 1, 'clip-1'],
        ['有声的话', 4.1, 0.8, 'clip-3'],
      ]),
    )
    expect(submitted).toEqual([])
  })

  it('一个片段识别失败：其余照常写进去，提示失败的片段，可以再点重试；识别出来没有话的片段也提示', async () => {
    await putFilm([
      clipA,
      clipB,
      video({ id: 'clip-3', label: '安静', src: URL_SILENT, start: 4_000 }),
    ])
    const user = userEvent.setup()
    await openEditor([...takes, ...quietTakes])
    const submitted = serveSubtitles(
      [
        subtitleJob(TAKE_A, { status: 'failed', sentences: null }),
        subtitleJob(TAKE_B, { sentences: [said(200, 1_000, '照常写')] }),
        subtitleJob(TAKE_SILENT, { sentences: [] }),
      ],
      (source) => subtitleJob(source, { status: 'failed', sentences: null }),
    )
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() => expect(savedSceneLines()).toEqual([['照常写', 2.2, 0.8, 'clip-2']]))
    expect(
      await screen.findByText('A · 镜头 1 的字幕识别失败，请点击「识别字幕」重试'),
    ).toBeVisible()
    expect(await screen.findByText('安静 没有识别出说话，未加字幕')).toBeVisible()
    // 上次失败了的那条重新发起一次
    expect(submitted).toEqual([TAKE_A])
    await waitFor(() => expect(recognizeButton(panel)).not.toHaveAttribute('aria-disabled'))
    await user.click(recognizeButton(panel))
    await waitFor(() => expect(submitted).toEqual([TAKE_A, TAKE_A]))
  })

  it('没有可识别的片段时「识别字幕」置灰，点了说明原因', async () => {
    const user = userEvent.setup()
    await openEditor()
    const panel = await openCaptions(user)
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    await user.click(recognizeButton(panel))
    expect(
      (await screen.findAllByText('final-cut 里暂无视频片段，无法识别字幕；请先加入镜头')).length,
    ).toBeGreaterThan(0)
  })

  it('视频片段都关了原声：「识别字幕」置灰，说明原因', async () => {
    await putFilm([{ ...clipA, muted: true }])
    const user = userEvent.setup()
    await openEditor()
    // 素材片读完了才知道片段对不对得上素材
    await shot(/^生成 A 镜头 1，/)
    const panel = await openCaptions(user)
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    await user.click(recognizeButton(panel))
    expect(
      (
        await screen.findAllByText(
          '视频片段都关闭了原声或找不到素材记录，无法识别字幕；请先打开原声',
        )
      ).length,
    ).toBeGreaterThan(0)
  })
})

describe('final-cut 编辑器 · 字幕跟着视频片段走', () => {
  /** 画面 1：视频 0–4 秒；字幕：它的两句 0.5–1 秒、2.5–3 秒，手动加的一句 6–7 秒。 */
  const open = async () => {
    await putFilm(
      [video({ label: 'A · 镜头 1', src: URL_A, duration: 4_000 })],
      [
        sceneLine('a1', 500, 500, 'clip-1'),
        sceneLine('b2', 2_500, 500, 'clip-1'),
        sceneLine('m3', 6_000, 1_000),
      ],
    )
    const user = userEvent.setup()
    await openEditor()
    return user
  }
  const lane = () => screen.getByRole('group', { name: '画面 1' })
  const videoBodies = () => within(lane()).getAllByRole('button', { name: /^选中：/ })
  /** 拖片段：测试里时间线按一秒 100 像素排，拖 `dx` 像素就是想挪到第 `dx` × 10 毫秒。 */
  const drag = (target: HTMLElement, dx: number) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
  }
  const timingsOf = () => savedSceneLines().map(([text, start]) => [text, start])

  it('在时间线上拖视频片段：它的字幕挪同样的时间，手动加的不动；一步撤销都回去', async () => {
    const user = await open()
    const [body] = videoBodies()
    if (body === undefined) throw new Error('没有视频片段')
    drag(body, 100)
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 1.5],
        ['字幕 b2', 3.5],
        ['字幕 m3', 6],
      ]),
    )
    expect(savedClips()[0]).toContain('data-start="1"')
    await user.click(undoButton())
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 0.5],
        ['字幕 b2', 2.5],
        ['字幕 m3', 6],
      ]),
    )
    expect(savedClips()[0]).toContain('data-start="0"')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('删掉视频片段：它的字幕和变量一起删，手动加的留着；一步撤销都回来', async () => {
    const user = await open()
    const [body] = videoBodies()
    if (body === undefined) throw new Error('没有视频片段')
    await user.click(body)
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(timingsOf()).toEqual([['字幕 m3', 6]]))
    expect(savedVariableTexts()).toEqual(['字幕 m3'])
    expect(savedClips()).toHaveLength(0)
    await user.click(undoButton())
    await waitSaved(() => expect(timingsOf()).toHaveLength(3))
    expect(savedClips()).toHaveLength(1)
  })

  it('开着波纹编辑删视频片段，后一段的字幕跟着补上来会压到别的字幕：不删，提示原因，片段还选中着', async () => {
    // 画面 1：视频 0–2 秒、2–4 秒；后一段的一句 2.5–3 秒，手动加的一句 0.6–1 秒。
    // 删掉前一段时后一段补到 0 秒，它的字幕挪到 0.5–1 秒，压到手动加的那句
    await putFilm(
      [
        video({ src: URL_A, duration: 2_000 }),
        video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 2_000 }),
      ],
      [sceneLine('m1', 600, 400), sceneLine('b2', 2_500, 500, 'clip-2')],
    )
    const user = userEvent.setup()
    await openEditor()
    const savedVersions = () => [
      savedVersion(),
      mockWorkspaceFile(CONVERSATION, SCENE_FILE)?.version,
    ]
    const versionsBefore = savedVersions()
    const [first] = videoBodies()
    if (first === undefined) throw new Error('没有视频片段')
    await user.click(first)
    expect(first).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{Delete}')
    expect(
      await screen.findByText(
        '字幕跟着视频片段挪动后会和别的字幕重叠，无法完成这次编辑；请先挪开或删掉挡住的字幕',
      ),
    ).toBeVisible()
    expect(videoBodies()).toHaveLength(2)
    expect(videoBodies()[0]).toHaveAttribute('aria-pressed', 'true')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    // 过了自动保存的等待时间也不存：主文件和字幕场景都还是原来那一版
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_500)))
    expect(savedVersions()).toEqual(versionsBefore)
  })

  it('切开以后挪后半段：切点以后的字幕跟着后半段走，切点以前的留在原处', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    // 剃刀点在 2 秒处（一秒 100 像素）
    fireEvent.pointerDown(lane(), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 10,
    })
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    const halfId = /id="(clip-[^"]+)"/.exec(
      savedClips().find((tag) => tag.includes('data-start="2"')) ?? '',
    )?.[1]
    expect(halfId).toBeDefined()
    expect(savedSceneLines().map(([text, , , owner]) => [text, owner])).toEqual([
      ['字幕 a1', 'clip-1'],
      ['字幕 b2', halfId],
      ['字幕 m3', null],
    ])

    editorRoot().focus()
    await user.keyboard('v')
    const second = videoBodies()[1]
    if (second === undefined) throw new Error('没有后半段')
    // 后半段从 2 秒挪到 4.5 秒
    drag(second, 450)
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 0.5],
        ['字幕 b2', 5],
        ['字幕 m3', 6],
      ]),
    )
  })
})

describe('final-cut 编辑器 · 语言', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })

  /** 最后一次发给预览页的 final-cut 里套的值；没套时是 undefined。 */
  const previewValues = (): unknown => {
    const load = previewPages
      .latest()
      .commands.filter((command) => command.type === 'load')
      .at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    const match = /<script data-hf-preview-variables>window\.__hfVariables=(.*?);<\/script>/.exec(
      load.html,
    )
    return match?.[1] === undefined ? undefined : JSON.parse(match[1])
  }

  /** 工程：0–2 秒一段视频，两句字幕；English 翻了第一句。 */
  const open = async () => {
    await putFilm(
      [video({ src: URL_A, duration: 2_000 })],
      [sceneLine('a1', 0, 1_000), sceneLine('b2', 1_000, 1_000)],
    )
    putMockWorkspaceFile(CONVERSATION, EN_FILE, '{"cap_a1": "Line one"}')
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    return user
  }

  it('工具条上一排语言：中文和工程里有的语言，当前的高亮；「+」里列出还没加的语言，选一个就加上并切过去', async () => {
    const user = await open()
    expect(
      within(languages())
        .getAllByRole('button')
        .map((button) => [button.textContent, button.getAttribute('aria-pressed')]),
    ).toEqual([
      ['ZH', 'true'],
      ['EN', 'false'],
      ['', null],
    ])
    await user.click(within(languages()).getByRole('button', { name: '添加语言' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Deutsch（DE）', 'Español（ES）', 'Français（FR）'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Français（FR）' }))
    await waitFor(() =>
      expect(within(languages()).getByRole('button', { name: 'Français（FR）' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(mockWorkspaceFile(CONVERSATION, 'final-cut/locales/fr.json')?.content).toBe('{}\n')
  })

  it('所有语言都加了：不显示「+」', async () => {
    await putFilm([video({ src: URL_A, duration: 2_000 })])
    for (const code of ['en', 'de', 'es', 'fr'])
      putMockWorkspaceFile(CONVERSATION, `final-cut/locales/${code}.json`, '{}')
    await openEditor()
    expect(
      within(languages())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['ZH', 'EN', 'DE', 'ES', 'FR'])
  })

  it('切到 English：预览套上 English 的值，字幕页签、时间线上是英文，没翻的显示原文并标出来，不能加字幕；切回中文都回来', async () => {
    const user = await open()
    expect(previewValues()).toBeUndefined()
    await user.click(within(side()).getByRole('tab', { name: '字幕' }))

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(previewValues()).toEqual({ cap_a1: 'Line one' }))
    const first = within(panel()).getByRole('textbox', { name: '字幕文字 00:00.00 – 00:01.00' })
    const second = within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' })
    expect(first).toHaveValue('Line one')
    expect(first).toHaveAccessibleDescription('原文 字幕 a1')
    expect(second).toHaveValue('')
    expect(second).toHaveAttribute('placeholder', '输入 English 字幕…')
    const row = screen.getByRole('group', { name: '字幕' })
    expect(within(row).getByRole('group', { name: /^Line one，/ })).toBeVisible()
    expect(within(row).getByRole('group', { name: /^字幕 b2，1\.0 秒，原文$/ })).toBeVisible()
    const add = within(panel()).getByRole('button', { name: '在播放头处加一句' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    await user.click(add)
    expect(
      (await screen.findAllByText('当前语言是 English，无法加字幕；请先切换到中文')).length,
    ).toBeGreaterThan(0)

    // 外语下写一句：存进 English 的值表，原文不变
    await user.type(second, 'Line two')
    await waitSaved(() =>
      expect(JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? '')).toEqual({
        cap_a1: 'Line one',
        cap_b2: 'Line two',
      }),
    )
    expect(savedVariableTexts()).toEqual(['字幕 a1', '字幕 b2'])
    await waitFor(() => expect(previewValues()).toEqual({ cap_a1: 'Line one', cap_b2: 'Line two' }))

    await user.click(within(languages()).getByRole('button', { name: '中文（ZH）' }))
    await waitFor(() => expect(previewValues()).toBeUndefined())
    expect(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
    ).toHaveValue('字幕 b2')
    expect(within(row).getByRole('group', { name: /^字幕 a1，1\.0 秒$/ })).toBeVisible()
  })

  it('切到 English 点「导出」：导出 English 版，提示里提醒还有几条没翻；发起时带上语言，状态写这次导出的语言；中文时带 null', async () => {
    const exportId = '22222222-3333-4444-8555-666666666666'
    const bodies: unknown[] = []
    // 中文那次答「还没导出过」，按钮留在「导出」；English 那次答渲染中、记着 English
    server.use(
      http.post('*/api/conversations/:conversationId/whole-film/exports', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ exportId }, { status: 202 })
      }),
      http.get('*/api/conversations/:conversationId/whole-film/exports/latest', () =>
        HttpResponse.json({
          export:
            bodies.length < 2
              ? null
              : {
                  id: exportId,
                  locale: 'en',
                  status: 'rendering',
                  progress: 0.4,
                  queuePosition: null,
                  error: null,
                  downloadUrl: null,
                },
        }),
      ),
    )
    const user = await open()
    const exportButton = () => within(toolbar()).getByRole('button', { name: '导出' })
    await user.click(exportButton())
    await waitFor(() => expect(bodies).toEqual([{ locale: null }]))
    await waitFor(() => expect(exportButton()).not.toHaveAttribute('aria-disabled'))

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    // 两句字幕 English 翻了一句
    await user.hover(exportButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /^导出 English 版；有 1 条文字未翻译，导出后显示中文$/,
    )
    await user.click(exportButton())
    await waitFor(() => expect(bodies).toEqual([{ locale: null }, { locale: 'en' }]))
    expect(await screen.findByText('正在渲染 English 版 40%')).toHaveAttribute('role', 'status')
  })
})

describe('final-cut 编辑器 · 贴片、场景的文字分语言', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const texts = () => within(panel()).getByRole('list', { name: '组件文字' })
  const savedHost = (id: string) => {
    const element = new DOMParser().parseFromString(savedFilm(), 'text/html').getElementById(id)
    const bindings = element?.getAttribute('data-locale-bindings')
    return {
      values: JSON.parse(element?.getAttribute('data-variable-values') ?? 'null') as unknown,
      bindings:
        bindings === null || bindings === undefined ? null : (JSON.parse(bindings) as unknown),
    }
  }
  const savedEnglish = (): unknown =>
    JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? 'null')
  /** 最后一次发给预览页的 final-cut 里片段 `id` 的取值。 */
  const previewHostValues = (id: string): unknown => {
    const load = previewPages
      .latest()
      .commands.filter((command) => command.type === 'load')
      .at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    const element = new DOMParser().parseFromString(load.html, 'text/html').getElementById(id)
    return JSON.parse(element?.getAttribute('data-variable-values') ?? 'null')
  }

  /** 工程：一段视频，两个贴片——中文标题、英文季标。`english` 时已有 English，中文标题随语言。 */
  const open = async (english = false) => {
    const main = await openComposition(
      mainFile(
        [
          video({ src: URL_A, duration: 4_000 }),
          host({ id: 'zh', label: '中文标题', start: 500, track: 1, values: { text: '新品上市' } }),
          host({
            id: 'latin',
            label: '季标',
            start: 2_000,
            track: 2,
            values: { text: 'NEW IN · AW26' },
          }),
        ],
        CAPTION_CANVAS,
      ),
    )
    if (english) {
      main.declareVariable({
        id: 'txt_zh_text',
        type: 'string',
        label: '文字',
        default: '新品上市',
      })
      main.setAttribute('zh', 'data-locale-bindings', '{"text":"txt_zh_text"}')
      putMockWorkspaceFile(CONVERSATION, EN_FILE, '{}')
    }
    putMockProjectMain(CONVERSATION, main.serialize())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(side()).getByRole('tab', { name: '字幕' }))
    return user
  }

  it('「字幕」页签上面切换「字幕」「组件文字」，各带个数；「组件文字」每个贴片一块、每个文字字段一行，没有外语时不显示「固定 / 随语言」，改的是中文', async () => {
    const user = await open()
    const views = within(panel()).getByRole('group', { name: '字幕或组件文字' })
    expect(
      within(views)
        .getAllByRole('button')
        .map((button) => [button.textContent, button.getAttribute('aria-pressed')]),
    ).toEqual([
      ['字幕 0', 'true'],
      ['组件文字 2', 'false'],
    ])
    await user.click(within(views).getByRole('button', { name: '组件文字 2' }))
    expect(
      within(texts())
        .getAllByRole('listitem')
        .map((item) => within(item).getAllByRole('button')[0]?.textContent),
    ).toEqual(['中文标题00:00.50', '季标00:02.00'])
    expect(within(texts()).queryByRole('button', { name: /：(固定|随语言)$/ })).toBeNull()

    const field = within(texts()).getByRole('textbox', { name: '中文标题 文字' })
    expect(field).toHaveValue('新品上市')
    await user.clear(field)
    await user.type(field, '早秋新品')
    await waitSaved(() => expect(savedHost('zh').values).toEqual({ text: '早秋新品' }))
    // 点一块的名字：选中它（停在「字幕」页签），播放头到它的开始
    await user.click(within(texts()).getByRole('button', { name: /^季标/ }))
    expect(within(texts()).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:04.00'))
  })

  it('加上 English：中文的字段随语言、西文的固定；外语下随语言的框里写英文存进值表、预览里那个贴片是英文，固定的只读；点「随语言」改成固定', async () => {
    const user = await open()
    await user.click(
      within(within(panel()).getByRole('group', { name: '字幕或组件文字' })).getByRole('button', {
        name: '组件文字 2',
      }),
    )
    await user.click(within(languages()).getByRole('button', { name: '添加语言' }))
    await user.click(await screen.findByRole('menuitem', { name: 'English（EN）' }))
    await waitFor(() =>
      expect(within(languages()).getByRole('button', { name: 'English（EN）' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(within(texts()).getByRole('button', { name: '文字：随语言' })).toBeVisible()
    expect(within(texts()).getByRole('button', { name: '文字：固定' })).toBeVisible()
    await waitSaved(() => expect(savedHost('zh').bindings).toEqual({ text: 'txt_zh_text' }))
    expect(savedHost('latin').bindings).toBeNull()
    expect(savedVariableTexts()).toEqual(['新品上市'])

    const zh = within(texts()).getByRole('textbox', { name: '中文标题 文字' })
    expect(zh).toHaveValue('')
    expect(zh).toHaveAttribute('placeholder', '输入 English 文字…')
    expect(zh).toHaveAccessibleDescription('原文 新品上市')
    const latin = within(texts()).getByRole('textbox', { name: '季标 文字' })
    expect(latin).toHaveValue('NEW IN · AW26')
    expect(latin).toHaveAttribute('readonly')
    expect(latin).toHaveAccessibleDescription('固定原文，所有语言共用；点击「随语言」可分别修改')

    await user.type(zh, 'New in')
    await waitSaved(() => expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' }))
    expect(savedHost('zh').values).toEqual({ text: '新品上市' })
    await waitFor(() => expect(previewHostValues('zh')).toEqual({ text: 'New in' }))
    expect(previewHostValues('latin')).toEqual({ text: 'NEW IN · AW26' })

    await user.click(within(texts()).getByRole('button', { name: '文字：随语言' }))
    await waitSaved(() => expect(savedEnglish()).toEqual({}))
    expect(savedHost('zh').bindings).toBeNull()
    expect(savedVariableTexts()).toEqual([])
    expect(within(texts()).getByRole('textbox', { name: '中文标题 文字' })).toHaveValue('新品上市')
    expect(within(texts()).getAllByRole('button', { name: '文字：固定' })).toHaveLength(2)
  })

  it('「属性」里的文字字段右边也有「固定 / 随语言」；外语下随语言的写这种语言，固定的只读', async () => {
    const user = await open(true)
    await user.click(screen.getByRole('button', { name: /^选中：中文标题，/ }))
    await user.click(within(side()).getByRole('tab', { name: '属性' }))
    const toggle = within(inspector()).getByRole('button', { name: '文字：随语言' })
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toHaveValue('新品上市')

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    const field = within(inspector()).getByRole('textbox', { name: '文字' })
    expect(field).toHaveValue('')
    await user.type(field, 'New in')
    await waitSaved(() => expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' }))

    await user.click(toggle)
    await waitSaved(() => expect(savedHost('zh').bindings).toBeNull())
    const pinned = within(inspector()).getByRole('textbox', { name: '文字' })
    expect(pinned).toHaveValue('新品上市')
    expect(pinned).toHaveAttribute('readonly')
    expect(within(inspector()).getByRole('button', { name: '文字：固定' })).toBeVisible()
  })
})

describe('final-cut 编辑器 · 翻译', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const TRANSLATIONS_URL = '*/api/conversations/:conversationId/final-cut/translations'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const translateButton = () => within(panel()).getByRole('button', { name: /^(翻译|翻译中…)$/ })
  const savedEnglish = (): unknown =>
    JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? 'null')

  /**
   * 换上翻译接口：记下每次请求，译文照模拟环境写成「[EN] 原文」。`fail` 给第几次请求（从 0 数）答失败，
   * `hold` 了结之前不答。
   */
  const serveTranslations = (
    fail?: (index: number) => Response | undefined,
    hold?: Promise<void>,
  ) => {
    const sent: FinalCutTranslationsIn[] = []
    server.use(
      http.post(TRANSLATIONS_URL, async ({ request }) => {
        const body = (await request.json()) as FinalCutTranslationsIn
        sent.push(body)
        await hold
        const failure = fail?.(sent.length - 1)
        if (failure !== undefined) return failure
        return HttpResponse.json({
          translations: body.entries.map((entry) => ({
            id: entry.id,
            text: `[${body.targetLocale.toUpperCase()}] ${entry.text}`,
          })),
        })
      }),
    )
    return sent
  }

  /**
   * 工程：一段视频，两个贴片（中文标题随语言、英文季标固定），字幕 `lines`；English 的值表是 `english`。
   * 打开编辑器，切到「字幕」页签。
   */
  const open = async (lines: SceneLine[], english: Record<string, string>) => {
    await putFilm(
      [
        video({ src: URL_A, duration: 2_000 }),
        host({ id: 'zh', label: '中文标题', start: 0, track: 1, values: { text: '新品上市' } }),
        host({ id: 'latin', label: '季标', start: 0, track: 2, values: { text: 'NEW IN' } }),
      ],
      lines,
    )
    const main = await openComposition(mockProjectMain(CONVERSATION)?.content ?? '')
    main.declareVariable({ id: 'txt_zh_text', type: 'string', label: '文字', default: '新品上市' })
    main.setAttribute('zh', 'data-locale-bindings', '{"text":"txt_zh_text"}')
    putMockProjectMain(CONVERSATION, main.serialize())
    putMockWorkspaceFile(CONVERSATION, EN_FILE, JSON.stringify(english))
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    return user
  }

  const toEnglish = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(translateButton()).toBeVisible())
  }

  const twoLines = [sceneLine('a1', 0, 1_000), sceneLine('b2', 1_000, 1_000)]

  it('中文时没有「翻译」；English 下只翻还没翻的，固定的不翻，一次写进值表、一步撤销；都翻过了置灰说明原因', async () => {
    const sent = serveTranslations()
    const user = await open(twoLines, { cap_a1: 'Line one' })
    expect(within(panel()).queryByRole('button', { name: '翻译' })).toBeNull()

    await toEnglish(user)
    await user.click(translateButton())
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({
        cap_a1: 'Line one',
        cap_b2: '[EN] 字幕 b2',
        txt_zh_text: '[EN] 新品上市',
      }),
    )
    expect(sent).toEqual([
      {
        targetLocale: 'en',
        entries: [
          { id: 'txt_zh_text', text: '新品上市' },
          { id: 'cap_b2', text: '字幕 b2' },
        ],
      },
    ])
    expect(await screen.findByText('已翻译 2 条')).toBeVisible()
    expect(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
    ).toHaveValue('[EN] 字幕 b2')

    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())
    expect(
      (await screen.findAllByText('English 的字幕和文字都已翻译；要重新翻译哪一句，请先清空那一句'))
        .length,
    ).toBeGreaterThan(0)
    expect(sent).toHaveLength(1)

    await user.click(undoButton())
    await waitSaved(() => expect(savedEnglish()).toEqual({ cap_a1: 'Line one' }))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(translateButton()).not.toHaveAttribute('aria-disabled')
  })

  it('翻译中按钮写「翻译中…」并置灰，连点只发一次，照常能编辑；翻译期间填了的那句不覆盖，别的写进去', async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent = serveTranslations(undefined, hold)
    const user = await open(twoLines, { cap_a1: 'Line one' })
    await toEnglish(user)
    await user.click(translateButton())
    await waitFor(() => expect(translateButton()).toHaveTextContent('翻译中…'))
    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())

    await user.type(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
      'Mine',
    )
    await waitSaved(() => expect(savedEnglish()).toEqual({ cap_a1: 'Line one', cap_b2: 'Mine' }))
    release()
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({
        cap_a1: 'Line one',
        cap_b2: 'Mine',
        txt_zh_text: '[EN] 新品上市',
      }),
    )
    expect(sent).toHaveLength(1)
    expect(await screen.findByText('已翻译 1 条')).toBeVisible()
    expect(await screen.findByText('1 条在翻译期间已修改或删除，未写入译文')).toBeVisible()
    expect(translateButton()).toHaveTextContent('翻译')
  })

  it('分两批发、第二批失败：整次不写，按接口答的原因提示，按钮恢复可点', async () => {
    // 十句各 450 字：合计超过 4000 字，前八句一批、后两句一批
    const lines = Array.from({ length: 10 }, (_, index) => ({
      ...sceneLine(`l${index}`, index * 200, 200),
      text: `${index}`.padEnd(450, '字'),
    }))
    const sent = serveTranslations((index) =>
      index === 1
        ? HttpResponse.json({ code: 'model_call_failed', detail: '上游限流' }, { status: 502 })
        : undefined,
    )
    const user = await open(lines, { txt_zh_text: 'New in' })
    await toEnglish(user)
    await user.click(translateButton())
    expect(await screen.findByText('翻译失败，请点击「翻译」重试')).toBeVisible()
    expect(sent.map((body) => body.entries.length)).toEqual([8, 2])
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' })
    expect(translateButton()).toHaveTextContent('翻译')
    expect(translateButton()).not.toHaveAttribute('aria-disabled')
  })

  it('没有启用翻译用的模型（409）：提示翻译服务暂不可用', async () => {
    serveTranslations(() =>
      HttpResponse.json({ code: 'model_unavailable', detail: '未配置' }, { status: 409 }),
    )
    const user = await open(twoLines, {})
    await toEnglish(user)
    await user.click(translateButton())
    expect(await screen.findByText('翻译服务暂不可用，请稍后再试')).toBeVisible()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('超过 500 字的那句不发，写完提示跳过了几条；剩下的都超长时置灰说明原因', async () => {
    const sent = serveTranslations()
    const user = await open(
      [{ ...sceneLine('a1', 0, 1_000), text: '长'.repeat(501) }, sceneLine('b2', 1_000, 1_000)],
      { txt_zh_text: 'New in' },
    )
    await toEnglish(user)
    await user.click(translateButton())
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({ cap_b2: '[EN] 字幕 b2', txt_zh_text: 'New in' }),
    )
    expect(sent.map((body) => body.entries.map((entry) => entry.id))).toEqual([['cap_b2']])
    expect(await screen.findByText('1 条超过 500 字，未翻译；请手动填写')).toBeVisible()
    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())
    expect(
      (await screen.findAllByText('还没翻译的 1 条超过 500 字，无法自动翻译；请手动填写')).length,
    ).toBeGreaterThan(0)
  })
})

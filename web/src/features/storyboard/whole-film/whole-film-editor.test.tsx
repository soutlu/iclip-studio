import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { starvedVideos } from '@/testing/hyperframes-player'
import { addMockConversation } from '@/testing/mocks/conversations'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { renderWithProviders } from '@/testing/render'
import { audio, filmFile, fixtureCatalog, host, video } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { WholeFilmEditor } from './whole-film-editor'

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
  const rendered = await renderWithProviders(
    <>
      <WholeFilmEditor
        conversationTitle="夜景延时素材生成"
        conversationId={CONVERSATION}
        onClose={vi.fn()}
      />
      <Toaster />
    </>,
  )
  await screen.findByRole('group', { name: '成片编辑器' })
  return { close: () => rendered.rerender(<Toaster />) }
}

const toolbar = () => screen.getByRole('toolbar', { name: '剪辑工具' })
const transport = () => screen.getByRole('group', { name: '播放控制' })
const progress = () => within(transport()).getByRole('slider', { name: '播放进度' })
const materials = () => screen.getByRole('region', { name: '视频素材区' })
const shot = (name: RegExp) => within(materials()).findByRole('button', { name })

const savedFilm = () => mockWholeFilmDraft(CONVERSATION)?.html ?? ''
const savedClips = () => savedFilm().match(/<video [^>]*>/g) ?? []
const waitSaved = (check: () => void) => waitFor(check, { timeout: 4000 })

const twoVideos = () =>
  filmFile(
    [
      video({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', jobId: TAKE_B, src: URL_B, start: 2_000, duration: 1_500 }),
    ],
    { width: 720, height: 1280 },
  )

describe('成片编辑器 · 加入素材', () => {
  it('还没有成片：播放、进度条、导出置灰并说明原因，没选镜头时按 Enter 提示先选，打开不保存', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('成片还是空的；加入内容后可以在这里预览')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(progress()).toHaveAttribute('data-disabled')
    expect(within(toolbar()).queryByRole('button', { name: '加入成片' })).toBeNull()
    screen.getByRole('dialog').focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('先在下方点一个镜头选中范围')).toBeVisible()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.click(exportButton)
    expect(
      (await screen.findAllByText('成片还是空的，无法导出；请先加入内容')).length,
    ).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockWholeFilmDraft(CONVERSATION)).toBeUndefined()
  })

  it('选一个镜头按 Enter：按素材的画幅建成片，片段上写素材片的地址并绑到它的变量', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="720" data-height="1280"')
    const [clip] = savedClips()
    expect(clip).toContain(`src="${URL_A}"`)
    expect(clip).toContain(`data-var-src="src-${TAKE_A}"`)
    expect(clip).toContain('data-start="0" data-duration="2.5" data-media-start="2"')
    expect(clip).toContain('data-label="A · 镜头 2"')
    expect(within(transport()).getByText('/ 00:02.50')).toBeVisible()
  })

  it('再选别的镜头按 Enter：接在末尾；选几个镜头一次加入时一个镜头一个片段', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{/Shift}{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(4))
    // 新加的片段写在根下第一个：后加的在前面
    const [fourth, third] = savedClips()
    expect(third).toContain('data-start="3.5" data-duration="2" data-media-start="0"')
    expect(fourth).toContain('data-start="5.5" data-duration="2.5" data-media-start="2"')
    expect(savedFilm().match(/&quot;id&quot;:&quot;src-/g)).toHaveLength(2)
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
      http.put(
        '*/api/conversations/:conversationId/whole-film/draft',
        () => HttpResponse.json({ detail: '渲染服务连不上，稍后再试' }, { status: 502 }),
        { once: true },
      ),
    )
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/渲染服务连不上，稍后再试$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重新保存' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
  })

  it('成片草稿读取失败：说明原因，重试后打开', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(
        '*/api/conversations/:conversationId/whole-film/draft',
        () => HttpResponse.json({ detail: '服务暂时不可用' }, { status: 503 }),
        { once: true },
      ),
    )
    serveGenerations(takes)
    await renderWithProviders(
      <WholeFilmEditor
        conversationTitle="夜景延时素材生成"
        conversationId={CONVERSATION}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByText(/服务暂时不可用$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('group', { name: '成片编辑器' })).toBeVisible()
  })
})

describe('成片编辑器 · 时间线', () => {
  const timeline = () => screen.getByRole('group', { name: '第 1 行' })

  it('成片里只有组件或块的片段、没有视频片段：照样能播放、能导出', async () => {
    putMockWholeFilmDraft(CONVERSATION, filmFile([host()], { width: 720, height: 1280 }))
    await openEditor()
    expect(screen.queryByText('成片还是空的；加入内容后可以在这里预览')).toBeNull()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('还没有成片：留一行空的，提示把镜头拖进来', async () => {
    await openEditor()
    expect(within(timeline()).getByText('把下面的镜头拖到这里')).toBeVisible()
    expect(screen.queryByRole('group', { name: '第 2 行' })).toBeNull()
  })

  it('成片里的片段排在一行里，行头是第一个片段的名字和片段数', async () => {
    putMockWholeFilmDraft(
      CONVERSATION,
      filmFile(
        [
          video({ label: 'A · 镜头 2', jobId: TAKE_A, src: URL_A, duration: 2_000 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            jobId: TAKE_B,
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
    const head = screen.getByLabelText('2 个片段').parentElement
    expect(head).toHaveTextContent('A · 镜头 2')
    expect(screen.getByRole('slider', { name: '时间线播放位置' })).toBeEnabled()
  })

  it('两行的成片：行号小的在上面，一个片段的行不显示片段数', async () => {
    putMockWholeFilmDraft(
      CONVERSATION,
      filmFile(
        [
          video({ label: 'A · 镜头 2', jobId: TAKE_A, src: URL_A, duration: 2_000, track: 1 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            jobId: TAKE_B,
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
      within(screen.getByRole('group', { name: '第 2 行' })).getByRole('group'),
    ).toHaveAccessibleName('A · 镜头 2，2.0 秒')
    expect(screen.queryByLabelText(/个片段$/)).toBeNull()
  })

  it('点行头的眼睛：这一行的片段一起隐藏，存出的文件带着隐藏标记；再点显示回来', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: '隐藏第 1 行' }))
    expect(
      within(timeline())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['A · 镜头 1，2.0 秒，已隐藏', 'A · 镜头 1，1.5 秒，已隐藏'])
    await waitSaved(() => expect(savedFilm().match(/data-hidden=""/g)).toHaveLength(2))

    const eye = screen.getByRole('button', { name: '显示第 1 行' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    await user.click(eye)
    await waitSaved(() => expect(savedFilm()).not.toContain('data-hidden'))
    expect(screen.getByRole('button', { name: '隐藏第 1 行' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  const clip = (name: RegExp) => within(timeline()).getByRole('button', { name })

  it('点一个片段选中它，按 Delete 删掉：开着波纹编辑，后面的片段往前补上，成片变短', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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

  it('选中一个片段按 Esc：只取消选中，编辑器还开着', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
  })

  it('选中以后在把手上按方向键裁剪：裁结尾只改长度，裁开头起点和入点一起动；不超出素材', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/1\.5 秒$/))
    const end = within(timeline()).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() =>
      expect(savedClips()[1]).toContain('data-start="2" data-duration="1.4" data-media-start="0"'),
    )
    // 素材 B 一共 3 秒：再怎么往外拉也只到 3 秒
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() =>
      expect(savedClips()[1]).toContain('data-start="2" data-duration="3" data-media-start="0"'),
    )

    const start = within(timeline()).getByRole('slider', { name: '裁剪开头' })
    start.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() =>
      expect(savedClips()[1]).toContain(
        'data-start="2.1" data-duration="2.9" data-media-start="0.1"',
      ),
    )
    // 往前裁不能压到前一个片段
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await waitSaved(() =>
      expect(savedClips()[1]).toContain('data-start="2" data-duration="3" data-media-start="0"'),
    )
    expect(within(transport()).getByText('/ 00:05.00')).toBeVisible()
  })
})

describe('成片编辑器 · 多选', () => {
  // 一行三个片段：A 镜头 1 在 0–2 秒，B 镜头 1 在 2–3.5 秒，A 镜头 2 在 3.5–5 秒
  const threeVideos = () =>
    filmFile(
      [
        video({ label: 'A · 镜头 1', jobId: TAKE_A, src: URL_A, duration: 2_000 }),
        video({
          id: 'clip-2',
          label: 'B · 镜头 1',
          jobId: TAKE_B,
          src: URL_B,
          start: 2_000,
          duration: 1_500,
        }),
        video({
          id: 'clip-3',
          label: 'A · 镜头 2',
          jobId: TAKE_A,
          src: URL_A,
          start: 3_500,
          duration: 1_500,
          mediaStart: 2_000,
        }),
      ],
      { width: 720, height: 1280 },
    )
  const row = () => screen.getByRole('group', { name: '第 1 行' })
  const NAMES = ['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'] as const
  const clip = (label: (typeof NAMES)[number]) =>
    within(row()).getByRole('button', { name: new RegExp(`^选中：${label}，`) })
  /** 选中着的片段，按时间线上的先后。 */
  const pressed = () => NAMES.filter((label) => clip(label).getAttribute('aria-pressed') === 'true')

  const openThree = async () => {
    putMockWholeFilmDraft(CONVERSATION, threeVideos())
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

  it('点行里的空白处取消全部选中；按 Esc 也全部取消，编辑器还开着', async () => {
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
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
  })

  it('[ 选中播放头左边的片段、] 选中右边的片段，替换原有选中；正好从播放头开始或结束的只算一边', async () => {
    const user = await openThree()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await user.click(clip('A · 镜头 2'))
    // 播放头挪到 2 秒：A 镜头 1 正好在这里结束，B 镜头 1 正好从这里开始
    screen.getByRole('dialog').focus()
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
    expect((await screen.findAllByText('先选中一个片段')).length).toBeGreaterThan(0)

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

  it('开着菜单又有选中的片段：第一下 Esc 只关菜单、选中不变，第二下才取消选中，编辑器一直开着', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    await screen.findByRole('menu', { name: '选择工具：选择' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(pressed()).toEqual(['A · 镜头 1'])
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()

    await user.keyboard('{Escape}')
    expect(pressed()).toEqual([])
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
  })
})

describe('成片编辑器 · 播放', () => {
  afterEach(() => {
    starvedVideos.clear()
  })

  it('打开存着的成片：显示总时长，可以播放', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    await openEditor()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(1)
  })

  it('在进度条上按方向键跳到别的位置；加素材、撤销之后停在原处', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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

  it('当前片段数据不够时舞台转圈，播放按钮是「暂停」', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    starvedVideos.add(URL_A)
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    expect(screen.getByRole('status', { name: '正在缓冲' })).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '暂停' })).toBeVisible()
  })
})

describe('成片编辑器 · 播放条设置', () => {
  type Player = HTMLElement & { playbackRate: number; muted: boolean; loop: boolean }
  const player = () => {
    const found = screen.getByRole('region', { name: '预览' }).querySelector('hyperframes-player')
    if (found === null) throw new Error('没有播放器')
    return found as Player
  }
  const playerUp = () => act(() => new Promise((resolve) => setTimeout(resolve, 500)))

  it('M 静音、再按恢复，⇧L 开关循环：交给播放器，成片不保存、不进撤销', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()
    screen.getByRole('dialog').focus()

    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '开启声音' })).toBeVisible()
    expect(player().muted).toBe(true)
    await user.keyboard('m')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    expect(player().muted).toBe(false)

    await user.keyboard('{Shift>}L{/Shift}')
    expect(within(transport()).getByRole('button', { name: '循环播放' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(player().loop).toBe(true)
    // 不按 Shift 的 L 不是快捷键
    await user.keyboard('l')
    expect(player().loop).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(1)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('选 2×：素材预览和成片预览都是 2×，改动成片换了播放器还是 2×', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await playerUp()

    await user.click(within(transport()).getByRole('button', { name: '播放速度 1×' }))
    await user.click(await screen.findByRole('menuitemradio', { name: '2×' }))
    expect(within(transport()).getByRole('button', { name: '播放速度 2×' })).toBeVisible()
    expect(player().playbackRate).toBe(2)

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

    it('F 把预览连同播放条一起全屏，菜单挂在全屏的元素里；Esc 退出全屏，编辑器还开着', async () => {
      putMockWholeFilmDraft(CONVERSATION, twoVideos())
      const user = userEvent.setup()
      await openEditor()
      await playerUp()
      screen.getByRole('dialog').focus()

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

      screen.getByRole('dialog').focus()
      await user.keyboard('{Escape}')
      expect(exitFullscreen).toHaveBeenCalledTimes(1)
      expect(within(transport()).getByRole('button', { name: '全屏' })).toBeVisible()
      expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
    })
  })
})

describe('成片编辑器 · 导出', () => {
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

  it('打开编辑器时最近一次导出还没结束：接着显示进度，关掉编辑器不取消它', async () => {
    const cancelled = trackCancels()
    serveLatest({ status: 'rendering', progress: null }, RENDERING)
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await screen.findByRole('button', { name: '取消导出' }))
    expect(await screen.findByText(/正在交给渲染服务，稍后再取消/)).toBeInTheDocument()
    expect(screen.getByText('正在渲染 40%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消导出' })).toBeInTheDocument()
  })

  it('加了素材马上导出：先把成片存好，再按存下的版本提交', async () => {
    const user = userEvent.setup()
    const revisions: unknown[] = []
    server.use(
      http.post(EXPORTS_URL, async ({ request }) => {
        revisions.push(((await request.json()) as { revision: number }).revision)
        return HttpResponse.json({ exportId: EXPORT_ID }, { status: 202 })
      }),
    )
    serveLatest(null, DONE)
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await user.click(await screen.findByRole('button', { name: '导出' }))
    expect(await screen.findByRole('button', { name: '下载成片' })).toBeInTheDocument()
    expect(savedClips()).toHaveLength(1)
    expect(revisions).toEqual([mockWholeFilmDraft(CONVERSATION)?.revision])
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
          : HttpResponse.json({ exportId: EXPORT_ID }, { status: 202 })
      }),
    )
    serveLatest(null, DONE)
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
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
    ['排队时成片又改过', 'FILM_CHANGED', 'draft moved on', '成片在排队时又改过，请重新导出'],
    ['没见过的错误码', 'SUBMIT_INTERRUPTED', 'worker restarted', '成片导出失败，请重新导出'],
  ])('导出失败（%s）：按原因说一句话，不露给开发看的原文', async (_, code, message, text) => {
    serveLatest({ status: 'failed', error: { code, message } })
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status')
    expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出' })).not.toHaveAttribute('aria-disabled')
  })

  it('渲染服务不收这份成片：显示它给的原因', async () => {
    serveLatest({
      status: 'failed',
      error: { code: 'RENDER_REJECTED', message: '素材地址的主机不在允许范围' },
    })
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    await openEditor()
    expect(await screen.findByText(/素材地址的主机不在允许范围$/)).toHaveAttribute('role', 'status')
  })
})

describe('成片编辑器 · 组件栏', () => {
  const componentCard = (name: RegExp) =>
    within(screen.getByRole('list', { name: '组件' })).getByRole('group', { name })
  const addAtPlayhead = (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
    user.click(within(componentCard(name)).getByRole('button', { name: '加到播放头' }))
  const savedComponents = () => savedFilm().match(/<div [^>]*class="clip component"[^>]*>/g) ?? []
  const previewHtml = () =>
    screen
      .getByRole('region', { name: '预览' })
      .querySelector('hyperframes-player')
      ?.getAttribute('srcdoc') ?? ''
  const playerUp = () => act(() => new Promise((resolve) => setTimeout(resolve, 500)))

  it('block 类加到播放头：第一行那段时间有片段，就在它下面新开一行；预览里固定尺寸的组件缩进画面', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await addAtPlayhead(user, /^测试画面/)

    await waitSaved(() => expect(savedComponents()).toHaveLength(1))
    const [clip] = savedComponents()
    expect(clip).toContain('data-label="测试画面"')
    expect(clip).toContain('data-composition-id="fixture-scene"')
    expect(clip).toContain('data-start="0" data-duration="6" data-track-index="1"')
    expect(clip).toContain('data-variable-values="{}"')
    expect(
      within(screen.getByRole('group', { name: '第 2 行' })).getByRole('group'),
    ).toHaveAccessibleName('测试画面，6.0 秒')

    await playerUp()
    const id = /id="([^"]+)"/.exec(clip ?? '')?.[1] ?? ''
    expect(previewHtml()).toContain(
      `#film #${id}{left:50%;top:50%;width:1920px;height:1080px;translate:-50% -50%;scale:0.375}`,
    )
  })

  it('component 类加到播放头：第一行空着也放在画面区最下面新开的一行，从播放头开始；撤销回去', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    progress().focus()
    await user.keyboard('{End}')
    expect(within(transport()).getByText('00:03.50')).toBeVisible()
    await addAtPlayhead(user, /^测试叠加/)

    await waitSaved(() => expect(savedComponents()).toHaveLength(1))
    expect(savedComponents()[0]).toContain(
      'data-start="3.5" data-duration="4" data-track-index="1"',
    )
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedComponents()).toHaveLength(0))
    expect(savedClips()).toHaveLength(2)
  })

  it('还没有成片时加组件：按竖版 1080×1920 建一份', async () => {
    const user = userEvent.setup()
    await openEditor()
    await addAtPlayhead(user, /^测试叠加/)
    await waitSaved(() => expect(savedComponents()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="1080" data-height="1920"')
    expect(savedComponents()[0]).toContain('data-start="0" data-duration="4" data-track-index="0"')
  })

  it('上一个组件还没加完又点「加到播放头」：只加一个，提示稍后再加', async () => {
    await openEditor()
    const add = within(componentCard(/^测试叠加/)).getByRole('button', { name: '加到播放头' })
    fireEvent.click(add)
    fireEvent.click(add)
    await waitSaved(() => expect(savedComponents()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(savedComponents()).toHaveLength(1)
    expect(screen.getByText('上一个组件正在加入成片，请稍后再加')).toBeVisible()
  })
})

describe('成片编辑器 · 右侧栏', () => {
  const inspector = () => screen.getByRole('complementary', { name: '属性' })
  const row = () => screen.getByRole('group', { name: '第 1 行' })
  const pick = (user: ReturnType<typeof userEvent.setup>, label: string) =>
    user.click(screen.getByRole('button', { name: new RegExp(`^选中：${label}，`) }))
  const groupButton = (title: string) =>
    within(inspector()).getByRole('button', { name: new RegExp(`^${title}`) })
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

  const brand = () =>
    host({
      id: 'brand-1',
      label: '示例品牌 片尾',
      component: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      start: 2_000,
      duration: 3_000,
    })
  const overlay = () =>
    host({
      id: 'overlay-1',
      label: '测试叠加',
      component: 'fixture-overlay',
      src: 'compositions/fixtures/fixture-overlay.html',
      start: 5_000,
    })

  const openWith = async (clips: Parameters<typeof filmFile>[0]) => {
    putMockWholeFilmDraft(CONVERSATION, filmFile(clips, { width: 720, height: 1280 }))
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('没选中时说明怎么用；选中多个时列出名字、不显示字段；点空白处回到没有选中', async () => {
    const user = await openWith([
      host({ duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', jobId: TAKE_B, src: URL_B, start: 2_000 }),
    ])
    expect(within(inspector()).getByRole('heading', { name: '没有选中' })).toBeVisible()
    expect(within(inspector()).getByText('在时间线上点一个片段，在这里改它')).toBeVisible()

    await pick(user, '测试可填项')
    await user.keyboard('{Shift>}')
    await pick(user, 'B · 镜头 1')
    await user.keyboard('{/Shift}')
    expect(within(inspector()).getByRole('heading', { name: '选中了 2 个片段' })).toBeVisible()
    const names = within(within(inspector()).getByRole('list', { name: '选中的片段' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(names).toEqual(['测试可填项组件', 'B · 镜头 1视频'])
    expect(within(inspector()).queryByRole('textbox')).toBeNull()
    expect(within(inspector()).queryByRole('button', { name: /^时间/ })).toBeNull()

    await user.click(row())
    expect(within(inspector()).getByRole('heading', { name: '没有选中' })).toBeVisible()
  })

  it('组件或块的片段：头部是名字和种类，先展开「内容」；分组一次只展开一个，收起的写摘要，再点展开着的就全收起', async () => {
    const user = await openWith([host({ start: 1_000, duration: 3_500 })])
    await pick(user, '测试可填项')
    expect(within(inspector()).getByRole('heading', { name: '测试可填项' })).toBeVisible()
    expect(within(inspector()).getByText('组件')).toBeVisible()
    expect(groupButton('内容')).toHaveAttribute('aria-expanded', 'true')
    expect(groupButton('内容')).toHaveAccessibleName('内容')
    expect(groupButton('时间')).toHaveAttribute('aria-expanded', 'false')
    expect(groupButton('时间')).toHaveAccessibleName('时间 1.00 – 4.50 秒')
    expect(within(inspector()).queryByRole('button', { name: /^媒体/ })).toBeNull()
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toBeVisible()

    await user.click(groupButton('时间'))
    expect(groupButton('时间')).toHaveAttribute('aria-expanded', 'true')
    expect(groupButton('内容')).toHaveAttribute('aria-expanded', 'false')
    expect(groupButton('内容')).toHaveAccessibleName('内容 示例文字')
    expect(within(inspector()).queryByRole('textbox', { name: '文字' })).toBeNull()
    expect(within(inspector()).getByRole('textbox', { name: '开始' })).toHaveValue('1.00')

    await user.click(groupButton('时间'))
    expect(groupButton('时间')).toHaveAttribute('aria-expanded', 'false')
    expect(groupButton('内容')).toHaveAttribute('aria-expanded', 'false')
  })

  it('视频片段、音频片段有「时间」和「媒体」，默认展开「时间」；音频片段的隐藏叫静音', async () => {
    const user = await openWith([
      video({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
      audio({ duration: 4_000 }),
    ])
    await pick(user, 'A · 镜头 1')
    expect(within(inspector()).getByText('视频')).toBeVisible()
    expect(within(inspector()).getAllByRole('button', { expanded: true })).toEqual([
      groupButton('时间'),
    ])
    expect(groupButton('媒体')).toHaveAttribute('aria-expanded', 'false')
    expect(within(inspector()).queryByRole('button', { name: /^内容/ })).toBeNull()
    expect(within(inspector()).getByRole('button', { name: '隐藏' })).toBeVisible()

    await pick(user, '配乐')
    expect(within(inspector()).getByText('音频')).toBeVisible()
    expect(groupButton('时间')).toHaveAttribute('aria-expanded', 'true')
    expect(within(inspector()).queryByRole('button', { name: /^内容/ })).toBeNull()
    await user.click(within(inspector()).getByRole('button', { name: '静音' }))
    await waitSaved(() => expect(savedTag('music-1')).toMatch(/^<audio data-hidden=""/))
    expect(within(inspector()).getByRole('button', { name: '取消静音' })).toBeVisible()
  })

  it('头部的隐藏、删除：隐藏写进文件、再点显示回来；删除和按 Delete 一样，后面的片段往前补，回到没有选中', async () => {
    const user = await openWith([
      video({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', jobId: TAKE_B, src: URL_B, start: 2_000 }),
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
    expect(within(inspector()).getByRole('heading', { name: '没有选中' })).toBeVisible()
  })

  it('内容：每项按类型用对应的控件，没填过的显示默认值', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    expect(panel.getByRole('textbox', { name: '文字' })).toHaveValue('示例文字')
    const weight = panel.getByRole('combobox', { name: '字体粗细' })
    expect(weight).toHaveValue('400')
    expect(
      within(weight)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['常规', '加粗'])
    expect(panel.getByRole('textbox', { name: '底色' })).toHaveValue('#2756ff')
    expect(panel.getByLabelText('底色取色')).toHaveValue('#2756ff')
    expect(panel.getByRole('spinbutton', { name: '字号' })).toHaveValue(96)
    const size = panel.getByRole('slider', { name: '字号' })
    expect(size).toHaveValue('96')
    expect(size).toHaveAttribute('min', '48')
    expect(size).toHaveAttribute('max', '144')
    expect(panel.getByText('px')).toBeVisible()
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'false')
  })

  it('改文字：停下 300 毫秒才写进片段，算一步撤销，预览跟着变', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const text = within(inspector()).getByRole('textbox', { name: '文字' })
    await user.clear(text)
    await user.type(text, '新的标题')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() => expect(undoButton()).not.toHaveAttribute('aria-disabled'))
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '新的标题' }))
    expect(
      screen
        .getByRole('region', { name: '预览' })
        .querySelector('hyperframes-player')
        ?.getAttribute('srcdoc'),
    ).toContain('{&quot;text&quot;:&quot;新的标题&quot;}')
    expect(text).toHaveValue('新的标题')

    await user.click(undoButton())
    await waitSaved(() => expect(savedValues('title-1')).toEqual({}))
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

  it('300 毫秒里改了几项：合成一次写进片段，几项都在', async () => {
    const user = await openWith([host({ values: { text: '原来的字' } })])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    // 焦点不动，两项都还没写进片段
    fireEvent.change(panel.getByRole('combobox', { name: '字体粗细' }), {
      target: { value: '700' },
    })
    fireEvent.click(panel.getByRole('switch', { name: '阴影' }))
    await waitSaved(() =>
      expect(savedValues('title-1')).toEqual({ text: '原来的字', weight: '700', shadow: true }),
    )
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'true')
  })

  it('数字：数字框写数字，滑杆拖到哪写到哪；框清空时不提交', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const box = panel.getByRole('spinbutton', { name: '字号' })
    await user.clear(box)
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    await user.type(box, '120')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 120 }))

    fireEvent.change(panel.getByRole('slider', { name: '字号' }), { target: { value: '60' } })
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 60 }))
    expect(box).toHaveValue(60)
  })

  it('颜色：取色和十六进制文字都写进片段', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const hex = panel.getByRole('textbox', { name: '底色' })
    await user.clear(hex)
    await user.type(hex, '#ff0000')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#ff0000' }))
    fireEvent.input(panel.getByLabelText('底色取色'), { target: { value: '#00ff00' } })
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#00ff00' }))
    expect(hex).toHaveValue('#00ff00')
  })

  it('字体：下拉里是「默认」和组件库里有的字体；没填时显示条目的默认字体，选「默认」写空', async () => {
    const user = await openWith([brand()])
    await pick(user, '示例品牌 片尾')
    const font = within(inspector()).getByRole('combobox', { name: '字体' })
    expect(
      within(font)
        .getAllByRole('option')
        .map((option) => [option.getAttribute('value'), option.textContent]),
    ).toEqual([
      ['', '默认'],
      ['Playfair Display', 'Playfair Display'],
    ])
    expect(font).toHaveValue('Playfair Display')
    await user.selectOptions(font, '')
    await waitSaved(() => expect(savedValues('brand-1')).toEqual({ font: '' }))
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
        component: 'fixture-scene',
        src: 'compositions/fixtures/fixture-scene.html',
      }),
    ])
    await pick(user, '测试叠加')
    expect(within(inspector()).getByText('这个组件没有可以填的内容')).toBeVisible()
    await pick(user, '测试画面')
    expect(within(inspector()).getByText('标志')).toBeVisible()
    expect(within(inspector()).getByText('图片暂不支持在这里修改')).toBeVisible()
    expect(within(inspector()).queryByRole('textbox')).toBeNull()
  })

  describe('时间', () => {
    // 一行两个片段：A 镜头 1 在 0–2 秒；B 镜头 1 在 5–6.5 秒，素材 3 秒长
    const twoApart = () => [
      video({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
      video({
        id: 'clip-2',
        label: 'B · 镜头 1',
        jobId: TAKE_B,
        src: URL_B,
        start: 5_000,
        duration: 1_500,
      }),
    ]
    const field = (name: string) => within(inspector()).getByRole('textbox', { name })
    const enter = async (user: ReturnType<typeof userEvent.setup>, name: string, value: string) => {
      await user.clear(field(name))
      await user.type(field(name), `${value}{Enter}`)
    }

    it('改开始是在本行里挪过去：放不下时落到最近的空处，框里显示实际的值；一步撤销', async () => {
      const user = await openWith(twoApart())
      await pick(user, 'B · 镜头 1')
      expect(field('开始')).toHaveValue('5.00')
      expect(field('结束')).toHaveValue('6.50')
      expect(field('时长')).toHaveValue('1.50')
      await enter(user, '开始', '1')
      expect(field('开始')).toHaveValue('2.00')
      expect(field('结束')).toHaveValue('3.50')
      await waitSaved(() => expect(savedTag('clip-2')).toContain('data-start="2"'))

      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-2')).toContain('data-start="5"'))
      expect(field('开始')).toHaveValue('5.00')
    })

    it('改结束、时长是裁结尾：不压到后面的片段，不超出素材的长度', async () => {
      const user = await openWith(twoApart())
      await shot(/^生成 B 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      await enter(user, '结束', '4')
      await waitSaved(() => expect(savedTag('clip-1')).toContain('data-duration="4"'))
      await enter(user, '结束', '9')
      expect(field('结束')).toHaveValue('5.00')
      await waitSaved(() => expect(savedTag('clip-1')).toContain('data-duration="5"'))

      await pick(user, 'B · 镜头 1')
      await enter(user, '时长', '10')
      expect(field('时长')).toHaveValue('3.00')
      expect(field('结束')).toHaveValue('8.00')
      await waitSaved(() => expect(savedTag('clip-2')).toContain('data-duration="3"'))
    })

    it('失焦也提交；Esc 放弃刚输入的，片段还选中着、编辑器还开着；不是数字时不提交、显示回原来的值', async () => {
      const user = await openWith(twoApart())
      await pick(user, 'B · 镜头 1')
      await user.clear(field('开始'))
      await user.type(field('开始'), '3{Escape}')
      expect(field('开始')).toHaveValue('5.00')
      expect(field('开始')).not.toHaveFocus()
      expect(within(row()).getByRole('button', { name: /^选中：B · 镜头 1，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()

      await enter(user, '时长', '很长')
      expect(field('时长')).toHaveValue('1.50')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await user.clear(field('开始'))
      await user.type(field('开始'), '5.5')
      await user.tab()
      await waitSaved(() => expect(savedTag('clip-2')).toContain('data-start="5.5"'))
    })
  })

  describe('媒体', () => {
    const slider = (name: string) => within(inspector()).getByRole('slider', { name })
    /** 滑杆右边的数值，点一下可以直接输入。 */
    const readout = (name: string) =>
      within(inspector()).getByRole('button', { name: new RegExp(`^${name} .*，点一下直接输入$`) })
    const toggle = (name: string) => within(inspector()).getByRole('switch', { name })
    /** 拖到第 `position` 格再松手。 */
    const drag = (name: string, position: number) => {
      fireEvent.input(slider(name), { target: { value: String(position) } })
      fireEvent.change(slider(name), { target: { value: String(position) } })
    }
    const type = async (user: ReturnType<typeof userEvent.setup>, name: string, text: string) => {
      await user.click(readout(name))
      const box = within(inspector()).getByRole('textbox', { name })
      await user.clear(box)
      await user.type(box, text)
      return box
    }
    const openMedia = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
      await pick(user, label)
      await user.click(groupButton('媒体'))
    }
    const savedAttribute = (id: string, name: string) =>
      new RegExp(` ${name}(?:="([^"]*)")?[ >]`).exec(savedTag(id))?.[1]

    it('音频片段：文件、增益、速度、起始位置、淡入、淡出、循环，没有静音；数值照参照的换算显示', async () => {
      const user = await openWith([
        audio({
          duration: 4_000,
          mediaStart: 1_500,
          volume: 0.5,
          playbackRate: 2,
          fadeIn: 1_000,
          loop: true,
        }),
      ])
      await openMedia(user, '配乐')
      const labels = within(inspector())
        .getAllByText(/^(文件|增益|速度|起始位置|淡入|淡出|循环|静音)$/)
        .map((label) => label.textContent)
      expect(labels).toEqual(['文件', '增益', '速度', '起始位置', '淡入', '淡出', '循环'])
      expect(within(inspector()).getAllByText('配乐')).toHaveLength(2)
      expect(slider('增益')).toHaveAttribute('aria-valuetext', '-6.0 dB')
      expect(slider('增益')).toHaveAttribute('min', '-100')
      expect(slider('增益')).toHaveAttribute('max', '100')
      expect(readout('增益')).toHaveTextContent('-6.0 dB')
      expect(slider('速度')).toHaveAttribute('aria-valuetext', '2x')
      expect(slider('速度')).toHaveValue('651')
      expect(readout('起始位置')).toHaveTextContent('1.50 秒')
      expect(readout('淡入')).toHaveTextContent('1.00 秒')
      expect(readout('淡出')).toHaveTextContent('0.00 秒')
      expect(toggle('循环')).toHaveAttribute('aria-checked', 'true')
      expect(within(inspector()).queryByRole('switch', { name: '静音' })).toBeNull()
    })

    it('增益：拖动中只改数值，松手写进成片，算一步撤销；正中不增不减，最左无声，最右 +12 dB', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await openMedia(user, '配乐')
      expect(slider('增益')).toHaveValue('0')
      expect(readout('增益')).toHaveTextContent('0.0 dB')

      fireEvent.input(slider('增益'), { target: { value: '50' } })
      expect(readout('增益')).toHaveTextContent('+6.0 dB')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.change(slider('增益'), { target: { value: '50' } })
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('1.995262'))
      expect(readout('增益')).toHaveTextContent('+6.0 dB')

      drag('增益', 100)
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('3.981072'))
      drag('增益', -100)
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0'))
      expect(readout('增益')).toHaveTextContent('-∞ dB')

      await user.click(undoButton())
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('3.981072'))
    })

    it('增益直接输入：按 dB 读；读不出时回车框留着、标成不对，Esc 放弃，片段还选中着', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await openMedia(user, '配乐')
      // 拖出去又拖回原处松手：浏览器不发 change，滑杆照样跟着后来输入的值
      fireEvent.input(slider('增益'), { target: { value: '50' } })
      fireEvent.input(slider('增益'), { target: { value: '0' } })
      await type(user, '增益', '-6{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187'))
      expect(readout('增益')).toHaveTextContent('-6.0 dB')
      expect(slider('增益')).toHaveAttribute('aria-valuetext', '-6.0 dB')

      const box = await type(user, '增益', '很响{Enter}')
      expect(box).toHaveAttribute('aria-invalid', 'true')
      expect(box).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(readout('增益')).toHaveTextContent('-6.0 dB')
      expect(within(row()).getByRole('button', { name: /^选中：配乐，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187')
    })

    it('速度：滑杆按对数走，正中 1 倍、两头 0.1 倍和 10 倍；1 倍时不写；片段的时长不变，结尾最多到（素材长 − 入点）÷ 速度', async () => {
      const user = await openWith([video({ jobId: TAKE_A, src: URL_A, duration: 2_000 })])
      await shot(/^生成 A 镜头 1，/)
      await openMedia(user, 'A · 镜头 1')
      expect(slider('速度')).toHaveValue('500')
      expect(readout('速度')).toHaveTextContent('1x')
      drag('速度', 1000)
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('10'))
      drag('速度', 0)
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('0.1'))
      drag('速度', 500)
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-playback-rate'))

      await type(user, '速度', '2x{Enter}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('2'))
      expect(savedAttribute('clip-1', 'data-duration')).toBe('2')
      // 素材 6 秒、从 0 放起，2 倍速时片段最长 3 秒
      await user.click(groupButton('时间'))
      const length = within(inspector()).getByRole('textbox', { name: '时长' })
      await user.clear(length)
      await user.type(length, '9{Enter}')
      expect(length).toHaveValue('3.00')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-duration')).toBe('3'))
    })

    it('起始位置：最多到「素材长 − 片段长 × 速度」，输入超出时收到上限；写进入点', async () => {
      const user = await openWith([
        video({ jobId: TAKE_A, src: URL_A, duration: 2_000, playbackRate: 2 }),
      ])
      await shot(/^生成 A 镜头 1，/)
      await openMedia(user, 'A · 镜头 1')
      // 素材 6 秒，片段 2 秒 × 2 倍用掉 4 秒：入点最多 2 秒
      expect(slider('起始位置')).toHaveAttribute('max', '200')
      drag('起始位置', 150)
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-media-start')).toBe('1.5'))
      expect(readout('起始位置')).toHaveTextContent('1.50 秒')
      await type(user, '起始位置', '5 秒{Enter}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-media-start')).toBe('2'))
      expect(savedAttribute('clip-1', 'data-duration')).toBe('2')
    })

    it('淡入淡出：一端最多到片段长减去另一端，0 时不写', async () => {
      const user = await openWith([audio({ duration: 4_000, fadeOut: 1_000 })])
      await openMedia(user, '配乐')
      expect(slider('淡入')).toHaveAttribute('max', '300')
      expect(slider('淡出')).toHaveAttribute('max', '400')
      await type(user, '淡入', '10{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fade-in')).toBe('3'))
      expect(slider('淡出')).toHaveAttribute('max', '100')
      drag('淡出', 0)
      await waitSaved(() => expect(savedTag('music-1')).not.toContain('data-fade-out'))
      expect(slider('淡入')).toHaveAttribute('max', '400')
    })

    it('循环、静音：开关写进文件；视频片段静音时写 muted、不写有声音的标记，也不再显示淡入淡出', async () => {
      const user = await openWith([
        video({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await openMedia(user, '配乐')
      await user.click(toggle('循环'))
      await waitSaved(() => expect(savedAttribute('music-1', 'loop')).toBe('true'))

      await openMedia(user, 'A · 镜头 1')
      expect(within(inspector()).queryByRole('switch', { name: '循环' })).toBeNull()
      expect(slider('淡入')).toBeVisible()
      await user.click(toggle('静音'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'muted')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('data-has-audio')
      expect(within(inspector()).queryByRole('slider', { name: '淡入' })).toBeNull()
      expect(within(inspector()).queryByRole('slider', { name: '淡出' })).toBeNull()

      await user.click(toggle('静音'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-has-audio')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('muted')
    })

    it('视频片段的素材没有声音：静音开着、不能取消，悬停说明原因；读不出有没有声音时照常能拨', async () => {
      const user = await openWith([
        video({ jobId: TAKE_SILENT, src: URL_SILENT, label: '无声', muted: true }),
        video({
          id: 'clip-2',
          jobId: TAKE_UNREADABLE,
          src: URL_UNREADABLE,
          label: '读不出',
          start: 2_000,
          muted: true,
        }),
      ])
      await openMedia(user, '无声')
      await waitFor(() => expect(toggle('静音')).toHaveAttribute('aria-disabled', 'true'))
      expect(toggle('静音')).toHaveAttribute('aria-checked', 'true')
      await user.hover(toggle('静音'))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('这段素材没有声音')
      await user.click(toggle('静音'))
      expect(toggle('静音')).toHaveAttribute('aria-checked', 'true')
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await openMedia(user, '读不出')
      expect(toggle('静音')).not.toHaveAttribute('aria-disabled')
      await user.click(toggle('静音'))
      await waitSaved(() => expect(savedAttribute('clip-2', 'data-has-audio')).toBe('true'))
    })
  })

  it('右侧栏的控件上按快捷键不动时间线：删除、退格、M、[ 都归控件，空格拨开关', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const clipButton = () => within(row()).queryByRole('button', { name: /^选中：测试可填项，/ })

    panel.getByRole('textbox', { name: '文字' }).focus()
    await user.keyboard('{Backspace}{Delete}')
    panel.getByRole('combobox', { name: '字体粗细' }).focus()
    await user.keyboard('{Delete}{Backspace}m[[')
    panel.getByRole('slider', { name: '字号' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    const shadow = panel.getByRole('switch', { name: '阴影' })
    shadow.focus()
    await user.keyboard('{Delete} ')

    expect(shadow).toHaveAttribute('aria-checked', 'true')
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '示例文', shadow: true }))
    expect(savedTag('title-1')).not.toBe('')
  })
})

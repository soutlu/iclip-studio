import { act, screen, waitFor, within } from '@testing-library/react'
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
import { filmFile, picture } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { WholeFilmEditor } from './whole-film-editor'

const files = vi.hoisted(() => new Map<string, { keyframes: number[]; duration: number }>())

vi.mock('mediabunny', async () => {
  const { createMediaReaderMock } = await import('@/testing/media-reader')
  class AudioSampleSink {}
  return { ...createMediaReaderMock(files, () => Promise.resolve(null)), AudioSampleSink }
})

const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const URL_A = 'https://media.test/take-a.mp4'
const URL_B = 'https://media.test/take-b.mp4'
const TAKE_A = '11111111-2222-4333-8444-555555555555'
const TAKE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'

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
const savedBlocks = () => savedFilm().match(/<video [^>]*>/g) ?? []
const waitSaved = (check: () => void) => waitFor(check, { timeout: 4000 })

const twoPictures = () =>
  filmFile(
    [
      picture({ jobId: TAKE_A, src: URL_A, duration: 2_000 }),
      picture({ id: 'clip-2', jobId: TAKE_B, src: URL_B, start: 2_000, duration: 1_500 }),
    ],
    { width: 720, height: 1280 },
  )

describe('成片编辑器 · 加入素材', () => {
  it('还没有成片：播放、进度条、导出置灰并说明原因，没选镜头时按 Enter 提示先选，打开不保存', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('成片里还没有画面；加入素材片后可以在这里预览')).toBeVisible()
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
      (await screen.findAllByText('成片里还没有画面，无法导出；请先加入素材片')).length,
    ).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockWholeFilmDraft(CONVERSATION)).toBeUndefined()
  })

  it('选一个镜头按 Enter：按素材的画幅建成片，块上写素材片的地址并绑到它的变量', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{Enter}')

    await waitSaved(() => expect(savedBlocks()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="720" data-height="1280"')
    const [block] = savedBlocks()
    expect(block).toContain(`src="${URL_A}"`)
    expect(block).toContain(`data-var-src="src-${TAKE_A}"`)
    expect(block).toContain('data-start="0" data-duration="2.5" data-media-start="2"')
    expect(block).toContain('data-label="A · 镜头 2"')
    expect(within(transport()).getByText('/ 00:02.50')).toBeVisible()
  })

  it('再选别的镜头按 Enter：接在末尾；选几个镜头一次加入时一个镜头一块', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{/Shift}{Enter}')

    await waitSaved(() => expect(savedBlocks()).toHaveLength(4))
    // 新加的块写在根下第一个：后加的在前面
    const [fourth, third] = savedBlocks()
    expect(third).toContain('data-start="3.5" data-duration="2" data-media-start="0"')
    expect(fourth).toContain('data-start="5.5" data-duration="2.5" data-media-start="2"')
    expect(savedFilm().match(/&quot;id&quot;:&quot;src-/g)).toHaveLength(2)
  })

  it('撤销退回加之前，重做再加回来；⌘Z 也可以', async () => {
    const user = userEvent.setup()
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    await openEditor()
    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(3))

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedBlocks()).toHaveLength(2))
    await user.click(within(toolbar()).getByRole('button', { name: '重做' }))
    await waitSaved(() => expect(savedBlocks()).toHaveLength(3))
    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(2))
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
    await waitSaved(() => expect(savedBlocks()).toHaveLength(1))
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

  it('还没有成片：留一行空的，提示把镜头拖进来', async () => {
    await openEditor()
    expect(within(timeline()).getByText('把下面的镜头拖到这里')).toBeVisible()
    expect(screen.queryByRole('group', { name: '第 2 行' })).toBeNull()
  })

  it('成片里的块排在一行里，行头是第一个块的名字和块数', async () => {
    putMockWholeFilmDraft(
      CONVERSATION,
      filmFile(
        [
          picture({ label: 'A · 镜头 2', jobId: TAKE_A, src: URL_A, duration: 2_000 }),
          picture({
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
    const blocks = within(timeline()).getAllByRole('group')
    expect(blocks.map((block) => block.getAttribute('aria-label'))).toEqual([
      'A · 镜头 2，2.0 秒',
      'B · 镜头 1，1.5 秒',
    ])
    const head = screen.getByLabelText('2 个块').parentElement
    expect(head).toHaveTextContent('A · 镜头 2')
    expect(screen.getByRole('slider', { name: '时间线播放位置' })).toBeEnabled()
  })

  it('两行的成片：行号小的在上面，一个块的行不显示块数', async () => {
    putMockWholeFilmDraft(
      CONVERSATION,
      filmFile(
        [
          picture({ label: 'A · 镜头 2', jobId: TAKE_A, src: URL_A, duration: 2_000, track: 1 }),
          picture({
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
    expect(screen.queryByLabelText(/个块$/)).toBeNull()
  })

  it('点行头的眼睛：这一行的块一起隐藏，存出的文件带着隐藏标记；再点显示回来', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: '隐藏第 1 行' }))
    expect(
      within(timeline())
        .getAllByRole('group')
        .map((block) => block.getAttribute('aria-label')),
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

  const block = (name: RegExp) => within(timeline()).getByRole('button', { name })

  it('点一个块选中它，按 Delete 删掉：开着波纹编辑，后面的块往前补上，成片变短', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await user.click(block(/2\.0 秒$/))
    expect(block(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(timeline()).getAllByRole('slider')).toHaveLength(2)

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(1))
    expect(savedBlocks()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(transport()).getByText('/ 00:01.50')).toBeVisible()
    expect(within(timeline()).queryAllByRole('slider')).toHaveLength(0)
  })

  it('关掉波纹编辑再删：后面的块留在原处', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(toolbar()).getByRole('button', { name: '波纹编辑' }))
    expect(within(toolbar()).getByRole('button', { name: '波纹编辑' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await user.click(block(/2\.0 秒$/))
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(1))
    expect(savedBlocks()[0]).toContain('data-start="2" data-duration="1.5"')
  })

  it('选中一个块按 Esc：只取消选中，编辑器还开着', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await user.click(block(/2\.0 秒$/))
    expect(block(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(block(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
  })

  it('选中以后在把手上按方向键裁剪：裁结尾只改长度，裁开头起点和入点一起动；不超出素材', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await user.click(block(/1\.5 秒$/))
    const end = within(timeline()).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() =>
      expect(savedBlocks()[1]).toContain('data-start="2" data-duration="1.4" data-media-start="0"'),
    )
    // 素材 B 一共 3 秒：再怎么往外拉也只到 3 秒
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() =>
      expect(savedBlocks()[1]).toContain('data-start="2" data-duration="3" data-media-start="0"'),
    )

    const start = within(timeline()).getByRole('slider', { name: '裁剪开头' })
    start.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() =>
      expect(savedBlocks()[1]).toContain(
        'data-start="2.1" data-duration="2.9" data-media-start="0.1"',
      ),
    )
    // 往前裁不能压到前一个块
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await waitSaved(() =>
      expect(savedBlocks()[1]).toContain('data-start="2" data-duration="3" data-media-start="0"'),
    )
    expect(within(transport()).getByText('/ 00:05.00')).toBeVisible()
  })
})

describe('成片编辑器 · 多选', () => {
  // 一行三个块：A 镜头 1 在 0–2 秒，B 镜头 1 在 2–3.5 秒，A 镜头 2 在 3.5–5 秒
  const threePictures = () =>
    filmFile(
      [
        picture({ label: 'A · 镜头 1', jobId: TAKE_A, src: URL_A, duration: 2_000 }),
        picture({
          id: 'clip-2',
          label: 'B · 镜头 1',
          jobId: TAKE_B,
          src: URL_B,
          start: 2_000,
          duration: 1_500,
        }),
        picture({
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
  const block = (label: (typeof NAMES)[number]) =>
    within(row()).getByRole('button', { name: new RegExp(`^选中：${label}，`) })
  /** 选中着的块，按时间线上的先后。 */
  const pressed = () =>
    NAMES.filter((label) => block(label).getAttribute('aria-pressed') === 'true')

  const openThree = async () => {
    putMockWholeFilmDraft(CONVERSATION, threePictures())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('Shift、⌘ 点块逐个加减选中，每个选中的块都有两端的把手；直接点收成只选这一个', async () => {
    const user = await openThree()
    await user.click(block('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(block('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    expect(pressed()).toEqual(['A · 镜头 1', 'A · 镜头 2'])
    expect(within(row()).getAllByRole('slider', { name: /^裁剪/ })).toHaveLength(4)

    await user.keyboard('{Meta>}')
    await user.click(block('A · 镜头 1'))
    await user.click(block('B · 镜头 1'))
    await user.keyboard('{/Meta}')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])

    await user.click(block('A · 镜头 1'))
    expect(pressed()).toEqual(['A · 镜头 1'])
  })

  it('点行里的空白处取消全部选中；按 Esc 也全部取消，编辑器还开着', async () => {
    const user = await openThree()
    await user.click(block('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(block('B · 镜头 1'))
    await user.keyboard('{/Shift}')
    await user.click(row())
    expect(pressed()).toEqual([])

    await user.click(block('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(block('A · 镜头 2'))
    await user.keyboard('{/Shift}{Escape}')
    expect(pressed()).toEqual([])
    expect(screen.getByRole('group', { name: '成片编辑器' })).toBeVisible()
  })

  it('[ 选中播放头左边的块、] 选中右边的块，替换原有选中；正好从播放头开始或结束的只算一边', async () => {
    const user = await openThree()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await user.click(block('A · 镜头 2'))
    // 播放头挪到 2 秒：A 镜头 1 正好在这里结束，B 镜头 1 正好从这里开始
    screen.getByRole('dialog').focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:02.00')).toBeVisible()

    await user.keyboard('[[')
    expect(pressed()).toEqual(['A · 镜头 1'])
    await user.keyboard(']')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])
  })

  it('选两个块按 Delete 一起删掉，开着波纹编辑剩下的往前补；撤销一步两个都回来', async () => {
    const user = await openThree()
    await user.click(block('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(block('A · 镜头 2'))
    await user.keyboard('{/Shift}{Delete}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(1))
    expect(savedBlocks()[0]).toContain('data-label="B · 镜头 1"')
    expect(savedBlocks()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(row()).queryAllByRole('slider', { name: /^裁剪/ })).toHaveLength(0)

    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(3))
    expect(savedBlocks().map((saved) => /data-start="([\d.]+)"/.exec(saved)?.[1])).toEqual([
      '0',
      '2',
      '3.5',
    ])
    // 删掉的块撤销回来以后不再是选中的
    expect(pressed()).toEqual([])
  })

  it('选中相邻的两个块，在一个的结尾把手上按方向键：两个一起裁，往外拉按被挡住的那个收住', async () => {
    const user = await openThree()
    await user.click(block('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(block('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    const end = within(row()).getAllByRole('slider', { name: '裁剪结尾' }).at(-1)
    if (end === undefined) throw new Error('没有结尾把手')
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() => {
      expect(savedBlocks()[1]).toContain('data-start="2" data-duration="1.4"')
      expect(savedBlocks()[2]).toContain('data-start="3.5" data-duration="1.4"')
    })
    // B · 镜头 1 再拉长 0.1 秒就碰到 A · 镜头 2：一起裁时把手最多到 5 秒（A · 镜头 2 自己能到 7.5 秒）
    await waitFor(() => expect(end).toHaveAttribute('aria-valuemax', '5'))
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    await waitSaved(() => {
      expect(savedBlocks()[1]).toContain('data-start="2" data-duration="1.5"')
      expect(savedBlocks()[2]).toContain('data-start="3.5" data-duration="1.5"')
    })
  })

  it('工具条：选择工具的菜单有三项，点「选中播放头右边的块」选中；没选中时「缩放到选中的块」置灰并说明原因', async () => {
    const user = await openThree()
    const zoomTo = within(toolbar()).getByRole('button', { name: '缩放到选中的块' })
    expect(zoomTo).toHaveAttribute('aria-disabled', 'true')
    await user.click(zoomTo)
    expect((await screen.findAllByText('先选中一个块')).length).toBeGreaterThan(0)

    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    const menu = await screen.findByRole('menu', { name: '选择工具：选择' })
    expect(menu).toHaveAttribute('data-side', 'top')
    expect(within(menu).getByRole('menuitemradio', { name: '选择' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByRole('menuitem', { name: /^选中播放头左边的块/ })).toHaveTextContent(
      '[',
    )
    const right = within(menu).getByRole('menuitem', { name: /^选中播放头右边的块/ })
    expect(right).toHaveTextContent(']')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1)
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)

    await user.click(right)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pressed()).toEqual(['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'])
    expect(zoomTo).not.toHaveAttribute('aria-disabled')
  })

  it('开着菜单又有选中的块：第一下 Esc 只关菜单、选中不变，第二下才取消选中，编辑器一直开着', async () => {
    const user = await openThree()
    await user.click(block('A · 镜头 1'))
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    await openEditor()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(1)
  })

  it('在进度条上按方向键跳到别的位置；加素材、撤销之后停在原处', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    const user = userEvent.setup()
    await openEditor()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))

    progress().focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{Shift>}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(progress()).toHaveAttribute('aria-valuetext', '00:01.20 / 00:03.50')

    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedBlocks()).toHaveLength(3))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedBlocks()).toHaveLength(2))
    expect(within(transport()).getByText('00:01.20')).toBeVisible()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
  })

  it('当前片段数据不够时舞台转圈，播放按钮是「暂停」', async () => {
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    await waitSaved(() => expect(savedBlocks()).toHaveLength(3))
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
      putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    expect(savedBlocks()).toHaveLength(1)
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
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
    putMockWholeFilmDraft(CONVERSATION, twoPictures())
    await openEditor()
    expect(await screen.findByText(/素材地址的主机不在允许范围$/)).toHaveAttribute('role', 'status')
  })
})

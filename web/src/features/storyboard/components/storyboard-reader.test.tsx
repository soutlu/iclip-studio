import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { workspaceQueryKeys, type ArtifactRendererProps } from '@/shared/workbench'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ShotsDocument } from '../shot-document'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { StoryboardReader } from './storyboard-reader'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const PATH = 'video_shot.json'
const artifact: ArtifactRendererProps['artifact'] = {
  id: `file:${PATH}`,
  source: { kind: 'file', path: PATH, version: 1 },
  title: '分镜',
  type: 'storyboard',
}

const document: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      seconds: 8,
      image_urls: [
        'https://example.com/one.png',
        'https://example.com/two.png',
        'https://example.com/unassigned.png',
      ],
      prompt: {
        global_settings: '  人物和产品保持一致。\n剪辑形式：硬切。\n',
        timeline: [
          {
            timestamps: [0, 2.5],
            prompt: '  模特走出门厅 @Image2，再看向鞋面 @Image1。\n',
            image_indexes: [2, 1],
          },
          {
            timestamps: [3.25, 5],
            prompt: '共用同一帧继续动作 @Image2，再次看向 @Image1。',
            image_indexes: [2, 1],
          },
          { timestamps: [5, 6], prompt: '这里保留旁白，没有图片引用。', image_indexes: [] },
        ],
      },
    },
    {
      index: 2,
      seconds: 4,
      image_urls: ['https://example.com/other-group.png'],
      prompt: {
        global_settings: '第二组保持固定机位。',
        timeline: [
          { timestamps: [0, 4], prompt: '第二组展示穿着效果 @Image1。', image_indexes: [1] },
        ],
      },
    },
  ],
}

const jobs: GenerationJob[] = [
  makeGenerationJob({
    id: 'aba2268d-b27b-4fb5-a592-d952f4483b88',
    createdAt: '2026-09-01T10:00:00Z',
    outputUrl: 'https://example.com/take.mp4',
    request: { prompt: '本组生成时使用的历史描述。' },
    shotIndex: 1,
  }),
  makeGenerationJob({
    id: 'cdf9d301-fe78-4c9b-a4f7-c936621179f0',
    createdAt: '2026-09-01T10:01:00Z',
    request: { prompt: '另一组的历史描述。' },
    shotIndex: 2,
  }),
]

/** 一条带结构化 shot 的历史记录，可以回填镜头组；正文是服务端从 shot 拼出来的。 */
const historyPrompt = [
  '历史版参考锁定：人物和产品保持一致。',
  '剪辑形式：硬切。',
  '',
  '[0–2.5秒｜镜头1] 历史版：模特走出门厅 @Image2。',
  '[2.5–6秒｜镜头2] 历史版：转身看向鞋面 @Image1。',
  '不要生成字幕，不要生成背景音乐。',
].join('\n')

const historyShot = {
  global_settings: '  历史版参考锁定：人物和产品保持一致。\n剪辑形式：硬切。\n',
  timeline: [
    { image_indexes: [2], prompt: '  历史版：模特走出门厅 @Image2。\n', timestamps: [0, 2.5] },
    { image_indexes: [1], prompt: '历史版：转身看向鞋面 @Image1。', timestamps: [2.5, 6] },
  ],
}

const editableJob = makeGenerationJob({
  id: 'e5b1c0de-6c1e-4f1a-9b3d-8c0a1f2e3d40',
  createdAt: '2026-09-01T10:02:00Z',
  outputUrl: 'https://example.com/history.mp4',
  request: { prompt: historyPrompt, shot: historyShot },
  shotIndex: 1,
})

/** 刚提交、还在跑的那一条，服务端刷新列表时才会出现。 */
const runningJob = makeGenerationJob({
  id: 'b7e0f4c2-3d1a-4e5b-9c6d-7e8f9a0b1c2d',
  createdAt: '2026-09-01T10:03:00Z',
  request: { prompt: '刚提交的这一版。' },
  shotIndex: 1,
  status: 'submitted',
})

const provide = (content: ShotsDocument | string = document, version = 1) => {
  let stored = typeof content === 'string' ? content : JSON.stringify(content)
  let storedVersion = version
  let failure: string | undefined
  const writes: { content: string; expectedVersion: number }[] = []
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({ files: [{ path: PATH, version: storedVersion }] }),
    ),
    http.get('*/api/conversations/:conversationId/workspace/file', () =>
      HttpResponse.json({ file: { content: stored, path: PATH, version: storedVersion } }),
    ),
    http.put('*/api/conversations/:conversationId/workspace/file', async ({ request }) => {
      const body = (await request.json()) as { content: string; expectedVersion: number }
      writes.push(body)
      if (failure !== undefined) return HttpResponse.json({ detail: failure }, { status: 503 })
      if (body.expectedVersion !== storedVersion)
        return HttpResponse.json({ detail: '版本冲突' }, { status: 409 })
      stored = body.content
      storedVersion += 1
      return HttpResponse.json({ file: { content: stored, path: PATH, version: storedVersion } })
    }),
    http.get('*/api/generations', () => HttpResponse.json({ items: jobs })),
  )
  return {
    writes,
    snapshot: () => JSON.parse(stored) as ShotsDocument,
    failSave: (message: string | undefined) => {
      failure = message
    },
  }
}

const emptyDocument: ShotsDocument = {
  aspect_ratio: '9:16',
  shots: [
    {
      index: 1,
      image_urls: [],
      seconds: 6,
      prompt: {
        global_settings: '人物和场景保持一致。',
        timeline: [
          { timestamps: [0, 3], prompt: '无图镜头一。', image_indexes: [] },
          { timestamps: [3, 6], prompt: '无图镜头二。', image_indexes: [] },
        ],
      },
    },
  ],
}

const imageFile = () => new File(['image bytes'], '新帧.png', { type: 'image/png' })
const replaceText = async (editor: HTMLElement, text: string) => {
  editor.focus()
  await userEvent.keyboard('{Control>}a{/Control}')
  pasteTextIntoComposer(editor, text)
}
const delayedUpload = (status = 200) => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  server.use(
    http.put('*/mock-oss/:uploadId', async () => {
      await pending
      return new HttpResponse(null, { status })
    }),
  )
  return release
}

const renderReader = (initialPath = '/?shot=1&content=scene:1', readOnly = false) =>
  renderWithProviders(
    <>
      <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />
      <Toaster />
    </>,
    {
      initialPath,
    },
  )

/** 成片区里的卡，新的在前。 */
const findTakes = async () =>
  within(await screen.findByRole('region', { name: '本组成片' })).getAllByRole('listitem')

/** 各张卡的提交时刻，认卡用。 */
const takeTimes = (takes: HTMLElement[]) =>
  takes.map((take) => take.querySelector('time')?.getAttribute('datetime'))

/** 文案列里的一段：全局设定或「镜头 N」。 */
const segmentOf = (page: HTMLElement, name: string) => within(page).getByRole('group', { name })

/** 从顶栏组号打开全部镜头组，点进第 n 组。 */
const openShot = async (index: number) => {
  await userEvent.click(screen.getByRole('button', { name: /打开全部镜头组/ }))
  const overview = await screen.findByRole('complementary', { name: '全部镜头组' })
  await userEvent.click(within(overview).getByRole('button', { name: `查看镜头组 ${index}` }))
}

describe('StoryboardReader', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => {
    toast.dismiss()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  it('按结构读取图片顺序与首帧，整组正文连续排开并标出选中段，保留小数时间', async () => {
    provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/two.png',
    )
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' }).textContent).toBe(
      '  模特走出门厅 @2，再看向鞋面 @1。',
    )
    // 全组各段都排出来，未引用的图不成段。
    expect(
      within(page)
        .getAllByRole('group', { name: /^(全局设定|镜头 \d)$/ })
        .map((segment) => segment.getAttribute('aria-label')),
    ).toEqual(['全局设定', '镜头 1', '镜头 2', '镜头 3'])
    expect(within(page).getByRole('textbox', { name: '全局设定' })).toHaveTextContent(
      '人物和产品保持一致。',
    )
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    const first = segmentOf(page, '镜头 1')
    expect(first).toHaveAttribute('aria-current', 'true')
    expect(
      within(first)
        .getAllByRole('button', { name: /^看第 \d+ 帧$/ })
        .map((chip) => chip.getAttribute('aria-label')),
    ).toEqual(['看第 2 帧', '看第 1 帧'])
    expect(within(first).getByText('0–2.5s')).toBeVisible()
  })

  it('共用帧时明确选择第二镜，切帧、帧标记和箭头仍保留该镜头', async () => {
    provide()
    const { router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2' }),
    )
    const second = segmentOf(page, '镜头 2')
    expect(second).toHaveAttribute('aria-current', 'true')
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toBeVisible()
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toBeVisible()
    expect(second).toHaveAttribute('aria-current', 'true')
    await userEvent.click(within(second).getByRole('button', { name: '看第 2 帧' }))
    await userEvent.click(within(page).getByRole('button', { name: '上一帧' }))
    expect(second).toHaveAttribute('aria-current', 'true')
    expect(segmentOf(page, '镜头 1')).toHaveAttribute('aria-current', 'false')
  })

  it('无帧镜头可查看正文，未关联图片可独立预览，外部导航清除局部镜头选择', async () => {
    provide()
    const { router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '镜头 3' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:3' }),
    )
    expect(within(page).getByRole('textbox', { name: '镜头 3 的描述' })).toHaveTextContent(
      '这里保留旁白',
    )
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    // 未引用的图不成段，地址指到它时舞台照样能看。
    await act(async () => {
      await router.navigate({ href: '/?shot=1&content=unreferenced' })
    })
    expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toHaveAttribute(
      'src',
      'https://example.com/unassigned.png',
    )
    for (const segment of within(page).getAllByRole('group', { name: /^(全局设定|镜头 \d)$/ }))
      expect(segment).toHaveAttribute('aria-current', 'false')
    await act(async () => {
      await router.navigate({ href: '/?shot=1&content=scene:1&frame=1' })
    })
    expect(segmentOf(page, '镜头 1')).toHaveAttribute('aria-current', 'true')
  })

  it('帧箭头沿当前内容引用顺序导航；↑↓ 切组、换组时默认选中全局设定，编辑器里的方向键不切组', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 }),
    )
    expect(within(page).getByRole('button', { name: '下一帧' })).toBeDisabled()

    within(page).getByRole('textbox', { name: '镜头 1 的描述' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 })

    screen.getByRole('button', { name: /打开全部镜头组/ }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(screen.getByRole('button', { name: /打开全部镜头组/ })).toHaveAccessibleName(
      '镜头组 2 / 2，打开全部镜头组',
    )
    const second = screen.getByRole('region', { name: '镜头组 2' })
    expect(segmentOf(second, '全局设定')).toHaveAttribute('aria-current', 'true')
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
  })

  it('查看原图并关闭后返回原来的帧', async () => {
    provide()
    await renderReader('/?shot=1&content=scene:1&frame=1')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const trigger = within(page).getByRole('button', { name: '打开原图' })
    await userEvent.click(trigger)
    const lightbox = await screen.findByRole('dialog', { name: '镜头组 1 第 1 帧' })
    expect(within(lightbox).getByRole('img')).toHaveAttribute('src', 'https://example.com/one.png')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('文案列照原文展示全局设定与各镜头正文，镜头标出起止秒，浏览不改地址', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const original = document.shots[0]
    expect(within(page).getByRole('textbox', { name: '全局设定' }).textContent).toBe(
      original?.prompt.global_settings.replaceAll('\n', ''),
    )
    const second = segmentOf(page, '镜头 2')
    expect(within(second).getByText('3.25–5s')).toBeVisible()
    const secondPrompt = within(second).getByRole('textbox', { name: '镜头 2 的描述' })
    expect(secondPrompt).toHaveTextContent('共用同一帧继续动作 @2，再次看向 @1。')
    expect(
      within(secondPrompt)
        .getAllByRole('button')
        .map((chip) => chip.getAttribute('aria-label')),
    ).toEqual(['看第 2 帧', '看第 1 帧'])
    expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 2 })
  })

  it('点文案段，舞台切到这段引用的第一帧', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=global')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    // 全局设定不引用图，舞台留空。
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    // 点进正文就是焦点落进这一段；jsdom 里 ProseMirror 的 mousedown 量不了坐标，直接给焦点。
    act(() => within(page).getByRole('textbox', { name: '镜头 2 的描述' }).focus())
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2' }),
    )
    expect(segmentOf(page, '镜头 2')).toHaveAttribute('aria-current', 'true')
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/two.png',
    )
  })

  it('顶栏组号打开全部组概览，标出当前组并可定位镜头组，成片区只列当前组', async () => {
    provide()
    const { router } = await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    expect(takeTimes(await findTakes())).toEqual([jobs[0]?.createdAt])
    await userEvent.click(screen.getByRole('button', { name: /打开全部镜头组/ }))
    const overview = await screen.findByRole('complementary', { name: '全部镜头组' })
    expect(within(overview).getAllByRole('listitem')).toHaveLength(2)
    expect(within(overview).getByRole('button', { name: '查看镜头组 1' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(overview).getByRole('button', { name: '查看镜头组 2' })).not.toHaveAttribute(
      'aria-current',
    )
    await userEvent.click(within(overview).getByRole('button', { name: '查看镜头组 2' }))
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    await screen.findByRole('region', { name: '镜头组 2' })
    expect(takeTimes(await findTakes())).toEqual([jobs[1]?.createdAt])
  })

  it('接口提交的出片（只有镜号、正文不是结构化 shot）照样列在本组成片区，播放在灯箱里放、关掉焦点回到播放钮', async () => {
    provide()
    // 网关只发 shot_index 与正文，记录上只有镜号。
    server.use(
      http.get('*/api/generations', () =>
        HttpResponse.json({
          items: [
            makeGenerationJob({
              id: 'f1f3a6b0-6b1a-4a3e-9f1d-2c5b7a9e0d31',
              createdAt: '2026-09-01T10:02:00Z',
              outputUrl: 'https://example.com/task.mp4',
              request: { prompt: '需求单那边出的片。' },
              shotIndex: 1,
            }),
          ],
        }),
      ),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    // 只有正文回填不了，照样能播、能编辑。
    expect(within(take).getByRole('button', { name: '回填提示词' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(take).getByRole('button', { name: '编辑视频' })).toBeEnabled()
    const play = within(take).getByRole('button', { name: '播放视频' })

    await userEvent.click(play)

    const dialog = await screen.findByRole('dialog', { name: '生成的视频' })
    expect(within(dialog).getByLabelText('生成的视频')).toHaveAttribute(
      'src',
      'https://example.com/task.mp4',
    )
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '生成的视频' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('生成的视频', { selector: 'video' })).toBeNull()
    await waitFor(() => expect(play).toHaveFocus())
  })

  describe('视频记录超过一页', () => {
    // 第一页整页都是别的组更新的记录，本组唯一的出片落在第二页。
    const newer = Array.from({ length: 100 }, () =>
      makeGenerationJob({ createdAt: '2026-09-02T10:00:00Z', shotIndex: 2 }),
    )
    const serveTwoPages = () =>
      server.use(
        http.get('*/api/generations', ({ request }) => {
          const params = new URL(request.url).searchParams
          // 帧上的图片任务与编辑器的编辑链走同一端点，这里都给空。
          if (params.get('kind') !== 'video') return HttpResponse.json({ items: [] })
          const before = params.get('before')
          return HttpResponse.json({ items: before === null ? newer : [editableJob] })
        }),
      )

    it('成片区列出更早那页的本组出片', async () => {
      provide()
      serveTwoPages()
      await renderReader()
      await screen.findByRole('region', { name: '镜头组 1' })

      expect(takeTimes(await findTakes())).toEqual([editableJob.createdAt])
    })

    it('带着更早那页的 ?video= 进来，编辑器照样打开', async () => {
      provide()
      serveTwoPages()
      await renderReader(`/?shot=1&content=scene:1&video=${editableJob.id}`)

      expect(await screen.findByRole('button', { name: '编辑模型' })).toBeVisible()
      expect(screen.queryByText(/找不到这条视频记录/)).not.toBeInTheDocument()
    })
  })

  it('只读时生成、正文编辑与历史回填的入口全部收起，不写工作区', async () => {
    const files = provide()
    let posts = 0
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: [editableJob] })),
      http.post('*/api/generations/video', () => {
        posts += 1
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader('/?shot=1&content=scene:1', true)
    const page = await screen.findByRole('region', { name: '镜头组 1' })

    // 置灰的出片按钮仍可聚焦（为了说出原因），点了也不提交。
    const generate = screen.getByRole('button', { name: '生成第 1 组' })
    expect(generate).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '视频模型' })).toHaveValue('vendor-a-seedance-2-5'),
    )
    await userEvent.click(generate)
    expect(posts).toBe(0)
    for (const name of ['全局设定', '镜头 1 的描述', '镜头 2 的描述', '镜头 3 的描述'])
      expect(within(page).getByRole('textbox', { name })).toHaveAttribute(
        'contenteditable',
        'false',
      )
    // 只读的段落照样能聚焦、选中切帧。
    act(() => within(page).getByRole('textbox', { name: '镜头 2 的描述' }).focus())
    await waitFor(() => expect(segmentOf(page, '镜头 2')).toHaveAttribute('aria-current', 'true'))
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    expect(within(take).getByRole('button', { name: '播放视频' })).toBeVisible()
    expect(within(take).queryByRole('button', { name: '回填提示词' })).toBeNull()
    expect(within(take).queryByRole('button', { name: '编辑视频' })).toBeNull()
    expect(files.writes).toEqual([])
  })

  it('成片卡的回填把那次出片的镜头组写回当前组并保存', async () => {
    const files = provide()
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [editableJob] })))
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    await userEvent.hover(take)
    await userEvent.click(within(take).getByRole('button', { name: '回填提示词' }))
    expect(await screen.findByText('历史提示词已回填到当前镜头组')).toBeVisible()

    await waitFor(() => expect(files.writes).toHaveLength(1))
    const saved = JSON.parse(files.writes[0]?.content ?? '{}') as ShotsDocument
    expect(saved.shots[0]?.prompt).toEqual({
      global_settings: '  历史版参考锁定：人物和产品保持一致。\n剪辑形式：硬切。\n',
      timeline: [
        {
          timestamps: [0, 2.5],
          prompt: '  历史版：模特走出门厅 @Image2。\n',
          image_indexes: [2],
        },
        {
          timestamps: [2.5, 6],
          prompt: '历史版：转身看向鞋面 @Image1。',
          image_indexes: [1],
        },
      ],
    })
    // 图片跟着文档，不跟历史记录。
    expect(saved.shots[0]?.image_urls).toEqual(document.shots[0]?.image_urls)
  })

  it('浏览与播放成片不会触发写入', async () => {
    provide()
    const requests: { method: string; url: string }[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/')) requests.push({ method: request.method, url: request.url })
    })
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).getByRole('textbox', { name: '镜头 1 的描述' })).toBeVisible()
    await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    await userEvent.click(screen.getByRole('button', { name: '复制完整提示词' }))
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    await userEvent.click(within(take).getByRole('button', { name: '播放视频' }))
    await screen.findByRole('dialog', { name: '生成的视频' })
    await userEvent.keyboard('{Escape}')
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  it('生成任务帧到了立刻重拉记录，不等轮询', async () => {
    provide()
    let served = 0
    server.use(
      http.get('*/api/generations', ({ request }) => {
        // 只数视频列表的重拉；帧上的图片查询走同一端点，另有用例覆盖。
        if (new URL(request.url).searchParams.get('kind') === 'image')
          return HttpResponse.json({ items: [] })
        served += 1
        const finished = {
          ...runningJob,
          outputUrl: 'https://example.com/new.mp4',
          status: 'completed',
        }
        return HttpResponse.json({ items: [served === 1 ? runningJob : finished] })
      }),
    )
    const { socket } = await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const tray = await screen.findByRole('region', { name: '本组成片' })
    expect(within(tray).getByRole('button', { name: /^生成中/ })).toBeVisible()
    expect(within(tray).queryByRole('button', { name: '播放视频' })).not.toBeInTheDocument()

    act(() => {
      socket.deliver({
        type: 'event.generation.changed',
        session_id: CONVERSATION_ID,
        payload: {
          id: runningJob.id,
          kind: 'video',
          operation: 'generate',
          status: 'completed',
          shot_index: 1,
        },
      })
    })

    expect(await within(tray).findByRole('button', { name: '播放视频' })).toBeVisible()
    expect(within(tray).queryByRole('button', { name: /^生成中/ })).not.toBeInTheDocument()
    expect(served).toBe(2)
  })

  it('参考帧的图片任务挂在帧上：先排队，推送后变成有新结果，看过编辑器就清掉', async () => {
    provide()
    const imageJob = makeGenerationJob({
      id: 'c3d4e5f6-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
      createdAt: '2026-09-01T10:05:00Z',
      kind: 'image',
      metadata: { frame: 2, shot: 1 },
      request: { prompt: '换个颜色', referenceImageUrls: [] },
      status: 'pending',
    })
    let imageReads = 0
    server.use(
      http.get('*/api/generations', ({ request }) => {
        if (new URL(request.url).searchParams.get('kind') !== 'image')
          return HttpResponse.json({ items: jobs })
        imageReads += 1
        const finished = {
          ...imageJob,
          outputUrl: 'https://example.com/edited.png',
          status: 'completed',
        }
        return HttpResponse.json({ items: [imageReads === 1 ? imageJob : finished] })
      }),
    )
    const { socket } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    // 角标挂在它那一帧上：舞台切到别的帧就不显示。
    expect(await within(page).findByText('排队中')).toBeVisible()
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toBeVisible()
    expect(within(page).queryByText('排队中')).not.toBeInTheDocument()
    await userEvent.click(within(page).getByRole('button', { name: '上一帧' }))
    expect(within(page).getByText('排队中')).toBeVisible()

    act(() => {
      socket.deliver({
        type: 'event.generation.changed',
        session_id: CONVERSATION_ID,
        payload: {
          id: imageJob.id,
          kind: 'image',
          operation: 'generate',
          status: 'completed',
          metadata: { frame: 2, shot: 1 },
        },
      })
    })

    const view = await within(page).findByRole('button', { name: '有新结果 · 查看' })
    await userEvent.click(view)
    const editor = await screen.findByRole('dialog', { name: '编辑图片 · 镜头组 1 · 帧 @2' })
    // 从角标进来直接落在那条结果上，不是落在标注画布上。
    await waitFor(() =>
      expect(
        within(editor).getByRole('group', { name: '这一帧的图片' }).querySelector('[aria-pressed]'),
      ).toBeTruthy(),
    )
    expect(within(editor).getByRole('img', { name: '图片编辑结果' })).toBeVisible()
    await userEvent.click(within(editor).getByRole('button', { name: '关闭图片编辑' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^编辑图片/ })).not.toBeInTheDocument(),
    )

    expect(within(page).queryByRole('button', { name: '有新结果 · 查看' })).not.toBeInTheDocument()
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toBeVisible()
    // 点开它的角标已经不在了，焦点退回这一帧的编辑入口，不掉到 body。
    await waitFor(() =>
      expect(within(page).getByRole('button', { name: '编辑图片' })).toHaveFocus(),
    )
  })

  it('出片栏里换模型、关音频后出片：请求体照上游形状取当前组内容，分辨率默认 720p，提交后成片区最前面出现在途卡', async () => {
    provide()
    const user = userEvent.setup()
    const [firstShot] = document.shots
    if (firstShot === undefined) throw new Error('测试文档缺第一组')
    const posted: unknown[] = []
    let items = jobs
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items })),
      http.post('*/api/generations/video', async ({ request }) => {
        posted.push(await request.json())
        items = [runningJob, ...jobs]
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const model = within(bar).getByRole<HTMLSelectElement>('combobox', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveValue('vendor-a-seedance-2-5'))
    await user.selectOptions(model, 'wan3.0-video')
    const audio = within(bar).getByRole('button', { name: '生成音频', pressed: true })
    await user.click(audio)
    await user.click(within(bar).getByRole('button', { name: '生成第 1 组' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted).toEqual([
      {
        aspect_ratio: '9:16',
        conversation_id: CONVERSATION_ID,
        generate_audio: false,
        model: 'wan3.0-video',
        reference_image_urls: firstShot.image_urls,
        resolution: '720p',
        seconds: firstShot.seconds,
        shot: firstShot.prompt,
        shot_index: 1,
      },
    ])
    await waitFor(async () => expect(takeTimes(await findTakes())).toHaveLength(2))
    const [newest] = await findTakes()
    expect(within(newest as HTMLElement).getByRole('button', { name: /^生成中/ })).toBeVisible()
    // 出片后设置不回退，下一次出片沿用。
    expect(model).toHaveValue('wan3.0-video')
    expect(audio).toHaveAttribute('aria-pressed', 'false')
  })

  it('切到 1080p 后出片带上 1080p，换模型不改分辨率', async () => {
    provide()
    const user = userEvent.setup()
    const posted: { model?: string; resolution?: string }[] = []
    server.use(
      http.post('*/api/generations/video', async ({ request }) => {
        posted.push((await request.json()) as { model?: string; resolution?: string })
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const resolution = within(bar).getByRole('radiogroup', { name: '分辨率' })
    const hd = within(resolution).getByRole('radio', { name: '1080p' })
    expect(within(resolution).getByRole('radio', { name: '720p' })).toBeChecked()

    await user.click(hd)
    expect(hd).toBeChecked()
    const model = within(bar).getByRole('combobox', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveValue('vendor-a-seedance-2-5'))
    await user.selectOptions(model, 'wan3.0-video')
    expect(hd).toBeChecked()

    await user.click(within(bar).getByRole('button', { name: '生成第 1 组' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ model: 'wan3.0-video', resolution: '1080p' })
  })

  it('改画幅写回分镜、出片带上新画幅；画幅按选中的模型标不支持，但不替用户改也不拦', async () => {
    const files = provide()
    const user = userEvent.setup()
    const posted: { aspect_ratio?: string; model?: string }[] = []
    server.use(
      http.post('*/api/generations/video', async ({ request }) => {
        posted.push((await request.json()) as { aspect_ratio?: string; model?: string })
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })

    const aspect = await screen.findByLabelText<HTMLSelectElement>('画幅')
    const option = (value: string) =>
      within(aspect).getByRole<HTMLOptionElement>('option', { name: new RegExp(`^${value}`) })
    // 默认的 seedance 做得了 21:9，选得动。
    expect(option('21:9')).not.toBeDisabled()
    await user.selectOptions(aspect, '21:9')
    await waitFor(() => expect(files.writes).toHaveLength(1))
    expect(files.snapshot().aspect_ratio).toBe('21:9')

    // 换成做不了 21:9 的万相：模型照选不误，画幅那一项标上不支持，出片栏里提醒但不禁用。
    const model = screen.getByRole<HTMLSelectElement>('combobox', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveValue('vendor-a-seedance-2-5'))
    const wan = within(model).getByRole<HTMLOptionElement>('option', { name: 'wan3.0-video' })
    expect(wan).toBeEnabled()
    await user.selectOptions(model, wan)
    expect(option('21:9')).toBeDisabled()
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    expect(
      await within(bar).findByRole('alert', { name: 'wan3.0-video 做不了 21:9' }),
    ).toBeVisible()

    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })
    expect(generate).not.toHaveAttribute('aria-disabled')
    await user.click(generate)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ aspect_ratio: '21:9', model: 'wan3.0-video' })
  })

  it('服务端拒收出片时在出片按钮旁提示原话，不弹全局提示、不刷新记录', async () => {
    provide()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: jobs })
      }),
      http.post('*/api/generations/video', () =>
        HttpResponse.json({ detail: '视频生成仅支持模型 vendor-a-seedance-2-5' }, { status: 422 }),
      ),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const generate = screen.getByRole('button', { name: '生成第 1 组' })
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))
    const readsBefore = reads

    await userEvent.click(generate)

    // 提示留在底部出片栏、挨着出片按钮；全局 toast 弹在视口底部会压住聊天输入区。
    // 存盘状态那一格出错时也是 alert，按文案取，别挑到别人的。
    const toolbar = screen.getByRole('group', { name: '出片工具栏' })
    expect(await within(toolbar).findByRole('alert', { name: /视频生成仅支持模型/ })).toBeVisible()
    expect(toolbar).toContainElement(generate)
    const toasts = screen.queryByRole('region', { name: /Notifications/ })
    expect(toasts === null ? null : within(toasts).queryByText(/视频生成仅支持模型/)).toBeNull()
    expect(reads).toBe(readsBefore)
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))
  })

  it('视频模型清单读不到时说明原因，不能出片', async () => {
    provide()
    server.use(
      http.get('*/api/generations/video-models', () =>
        HttpResponse.json({ detail: '配置没加载' }, { status: 503 }),
      ),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const model = screen.getByRole('combobox', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveDisplayValue('视频模型读不到'))
    expect(model).toBeDisabled()
    const generate = screen.getByRole('button', { name: '生成第 1 组' })
    expect(generate).toHaveAttribute('aria-disabled', 'true')

    // 置灰的按钮仍能聚焦，聚焦就说出原因。
    act(() => generate.focus())
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
    expect(generate).toHaveAccessibleDescription()
  })

  it('刷新文件后保留所选镜头，失效的图片选择使用该镜头当前引用', async () => {
    provide()
    const { queryClient, router } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    // 点第二镜里的 @2：地址里记下第 2 帧，刷新后这一帧不再属于第二镜。
    await userEvent.click(
      within(segmentOf(page, '镜头 2')).getByRole('button', { name: '看第 2 帧' }),
    )
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 2 }),
    )
    const latest: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: shot.image_urls.map((url, index) =>
                index === 1 ? 'https://example.com/new.png' : url,
              ),
              prompt: {
                ...shot.prompt,
                timeline: shot.prompt.timeline.map((item, index) =>
                  index === 1
                    ? { ...item, prompt: '第二镜改用第一张图 @Image1。', image_indexes: [1] }
                    : item,
                ),
              },
            }
          : shot,
      ),
    }
    provide(latest, 2)
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(CONVERSATION_ID, PATH),
      })
    })
    expect(await within(page).findByRole('textbox', { name: '镜头 2 的描述' })).toBeVisible()
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      'https://example.com/one.png',
    )
    expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 2 })
  })

  it('小数时间段的时间胶囊显示 16–21.9s，不暴露浮点计算尾差', async () => {
    const fractional: ShotsDocument = {
      ...document,
      shots: document.shots
        .filter((shot) => shot.index === 1)
        .map((shot) => ({
          ...shot,
          seconds: 22,
          prompt: {
            ...shot.prompt,
            timeline: [
              { timestamps: [0, 16], prompt: '开场 @Image1。', image_indexes: [1] },
              // agent 算出来的秒数可能带浮点尾差，照样写进文件。
              { timestamps: [16, 16 + 5.9], prompt: '收尾 @Image2。', image_indexes: [2] },
            ],
          },
        })),
    }
    provide(fractional)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(segmentOf(page, '镜头 2')).getByText('16–21.9s')).toBeVisible()
  })

  it('文件内容无效时明确显示读取错误', async () => {
    provide('{ invalid JSON')
    await renderReader()
    expect(await screen.findByText('文件格式不对，读不出镜头组')).toBeVisible()
    expect(screen.queryByRole('region', { name: /镜头组 \d/ })).not.toBeInTheDocument()
  })

  it('编辑当前镜头更新派生引用，删除全部引用后仍可编辑、撤销，其他字段保持原值', async () => {
    const files = provide()
    await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
    const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
    await replaceText(editor, '新的无图正文。')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '新的无图正文。',
    )
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    const saved = files.snapshot()
    expect(saved.shots[0]?.prompt.timeline[1]).toEqual({
      timestamps: [3.25, 5],
      prompt: '新的无图正文。',
      image_indexes: [],
    })
    expect(saved.shots[0]?.prompt.global_settings).toBe(document.shots[0]?.prompt.global_settings)
    expect(saved.shots[0]?.prompt.timeline[0]).toEqual(document.shots[0]?.prompt.timeline[0])
    expect(saved.shots[0]?.image_urls).toEqual(document.shots[0]?.image_urls)
    expect(saved.shots[1]).toEqual(document.shots[1])
    editor.focus()
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '共用同一帧继续动作',
    )
  })

  it('非法引用保留在当前编辑器供修正，不保存、不跳镜也不创建无效图片', async () => {
    const files = provide(emptyDocument)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const editor = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    await replaceText(editor, '暂时输入 @Image9。')
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '本组没有图片',
    )
    expect(files.writes).toEqual([])
    expect(editor).toHaveTextContent('暂时输入 @9。')
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    expect(
      within(page).getByRole('button', { name: '看第 9 帧' }).querySelector('img'),
    ).not.toHaveAttribute('src')
    await replaceText(editor, '已修正的正文。')
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(files.snapshot().shots[0]?.prompt.timeline[0]?.prompt).toBe('已修正的正文。')
  })

  it('顶栏复制拷走整组全文：读的是刚改完的全局设定与原始标记；段内复制只拷这一段', async () => {
    const user = userEvent.setup()
    const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const files = provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await user.click(within(segmentOf(page, '镜头 1')).getByRole('button', { name: '复制镜头 1' }))
    expect(copied).toHaveBeenLastCalledWith(document.shots[0]?.prompt.timeline[0]?.prompt)
    const settings = '  新设定 @Image01。\n\n保留换行。  '
    await replaceText(within(page).getByRole('textbox', { name: '全局设定' }), settings)
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(files.snapshot().shots[0]?.prompt.global_settings).toBe(settings)
    expect(files.snapshot().shots[0]?.prompt.timeline).toEqual(document.shots[0]?.prompt.timeline)
    await user.click(screen.getByRole('button', { name: '复制完整提示词' }))
    expect(copied).toHaveBeenLastCalledWith(
      settings +
        '\n\n[0–2.5秒｜镜头1]   模特走出门厅 @Image2，再看向鞋面 @Image1。\n' +
        '\n[3.25–5秒｜镜头2] 共用同一帧继续动作 @Image2，再次看向 @Image1。\n' +
        '[5–6秒｜镜头3] 这里保留旁白，没有图片引用。\n' +
        '不要生成字幕，不要生成背景音乐。',
    )
  })

  it('文案列逐段编辑镜头正文，各段互不干扰且引用编号随正文重算', async () => {
    const files = provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await replaceText(
      within(page).getByRole('textbox', { name: '镜头 2 的描述' }),
      '改后的第二镜 @Image1。',
    )
    await replaceText(
      within(page).getByRole('textbox', { name: '镜头 3 的描述' }),
      '改后的第三镜。',
    )
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    const saved = files.snapshot().shots[0]
    expect(saved?.prompt.timeline[1]).toEqual({
      image_indexes: [1],
      prompt: '改后的第二镜 @Image1。',
      timestamps: [3.25, 5],
    })
    expect(saved?.prompt.timeline[2]?.prompt).toBe('改后的第三镜。')
    expect(saved?.prompt.timeline[0]).toEqual(document.shots[0]?.prompt.timeline[0])
    expect(saved?.prompt.global_settings).toBe(document.shots[0]?.prompt.global_settings)
    // 改别的段不会重建这一段的编辑器，正文留在原处。
    expect(within(page).getByRole('textbox', { name: '镜头 2 的描述' })).toHaveTextContent(
      '改后的第二镜 @1。',
    )
  })

  it('关联本组已有图片只插入引用，不追加地址，编号顺序由正文重新计算', async () => {
    const files = provide()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    const picker = await screen.findByRole('dialog', { name: '添加图片' })
    await userEvent.click(within(picker).getByRole('button', { name: '关联第 3 张图片' }))
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    const saved = files.snapshot().shots[0]
    expect(saved?.image_urls).toEqual(document.shots[0]?.image_urls)
    expect(saved?.prompt.timeline[0]).toEqual({
      timestamps: [0, 2.5],
      prompt: document.shots[0]?.prompt.timeline[0]?.prompt + '@Image3',
      image_indexes: [2, 1, 3],
    })
    expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toHaveAttribute(
      'src',
      'https://example.com/unassigned.png',
    )
  })

  it('无图镜头首次上传期间仍能编辑，完成后在最新选区插入新编号并一起保存', async () => {
    const files = provide(emptyDocument)
    const release = delayedUpload()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    expect(await within(page).findByRole('status', { name: /^上传中 \d+%$/ })).toBeVisible()
    const editor = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
    await replaceText(editor, '上传时更新的正文。')
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    await act(async () => {
      release()
    })
    await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(1), {
      timeout: 3000,
    })
    const saved = files.snapshot().shots[0]
    expect(saved?.prompt.timeline[0]).toEqual({
      timestamps: [0, 3],
      prompt: '上传时更新的正文。@Image1',
      image_indexes: [1],
    })
    expect(saved?.prompt.timeline[1]).toEqual(emptyDocument.shots[0]?.prompt.timeline[1])
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      saved?.image_urls[0],
    )
  })

  it.each(['镜头', '镜头组', '图片'])(
    '新增上传期间切换%s 后，迟到结果不回填也不保存',
    async (target) => {
      const files = provide()
      const release = delayedUpload()
      let registered = 0
      server.events.on('response:mocked', ({ request }) => {
        if (request.method === 'POST' && request.url.endsWith('/confirm')) registered += 1
      })
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
      await within(page).findByRole('status')
      if (target === '镜头组') await openShot(2)
      else if (target === '镜头')
        await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
      else await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
      await act(async () => {
        release()
      })
      await waitFor(() => expect(registered).toBe(1))
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(files.writes).toEqual([])
      expect(files.snapshot()).toEqual(document)
    },
  )

  it.each(['新增', '替换'])('%s上传期间切换镜头组，上传失败仍然提示且不保存', async (mode) => {
    const files = provide()
    const release = delayedUpload(503)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    if (mode === '新增') {
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    } else await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    await within(page).findByRole('status')
    await openShot(2)
    await act(async () => {
      release()
    })
    expect(await screen.findByText('上传失败（503）')).toBeVisible()
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
    expect(files.writes).toEqual([])
    expect(files.snapshot()).toEqual(document)
  })

  it('替换共享编号只改该地址，保存失败保留新图草稿，重试不重新上传', async () => {
    const files = provide()
    files.failSave('服务暂时不可用')
    let uploads = 0
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.includes('/uploads/sign')) uploads += 1
    })
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    const retry = await screen.findByRole('button', { name: '重试保存' }, { timeout: 3000 })
    expect(screen.getByText('已上传，分镜未保存')).toBeVisible()
    const replacement = within(page)
      .getByRole('img', { name: '镜头组 1 第 2 帧' })
      .getAttribute('src')
    expect(replacement).toContain('/mock-oss/')
    expect(files.snapshot()).toEqual(document)
    files.failSave(undefined)
    await userEvent.click(retry)
    await screen.findByText('已保存', undefined, { timeout: 3000 })
    expect(uploads).toBe(1)
    expect(files.snapshot().shots[0]?.image_urls).toEqual([
      'https://example.com/one.png',
      replacement,
      'https://example.com/unassigned.png',
    ])
    expect(files.snapshot().shots[0]?.prompt).toEqual(document.shots[0]?.prompt)
    await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      replacement,
    )
    files.failSave('后续正文暂时无法保存')
    const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
    editor.focus()
    pasteTextIntoComposer(editor, '后续文字。')
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it('新增上传后保存失败，提示图片已上传、分镜未保存', async () => {
    const files = provide()
    files.failSave('服务暂时不可用')
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    await screen.findByRole('button', { name: '重试保存' }, { timeout: 3000 })
    expect(screen.getByText('已上传，分镜未保存')).toBeVisible()
    expect(files.snapshot()).toEqual(document)
  })

  it('帧计数弹层里的共用说明按本组编号统计，不把相同 URL 的另一编号算进来', async () => {
    const shared: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: [
                'https://example.com/one.png',
                'https://example.com/two.png',
                'https://example.com/two.png',
              ],
              prompt: {
                ...shot.prompt,
                timeline: shot.prompt.timeline.map((item, index) =>
                  index === 2
                    ? { ...item, prompt: '第三镜只用另一编号 @Image3。', image_indexes: [3] }
                    : item,
                ),
              },
            }
          : shot,
      ),
    }
    provide(shared)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: /查看本组全部图片/ }))
    const gallery = await screen.findByRole('dialog', { name: '本组全部图片' })
    expect(within(gallery).getByRole('button', { name: '第 2 帧' })).toHaveAccessibleDescription(
      '@2 · 镜头 1、镜头 2 共用',
    )
    expect(within(gallery).getByRole('button', { name: '第 3 帧' })).toHaveAccessibleDescription(
      '@3 · 镜头 3',
    )
  })

  it('无图镜头组的舞台留空，仍给添加图片的入口', async () => {
    provide(emptyDocument)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).queryByRole('img')).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: '添加图片' })).not.toHaveAttribute(
      'aria-disabled',
    )
  })

  it('关联已有图片保存失败不会误报为上传成功', async () => {
    const files = provide()
    files.failSave('保存失败')
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
    await userEvent.click(screen.getByRole('button', { name: '关联第 3 张图片' }))
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '没存下',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it.each(['新增', '替换'])('%s上传失败保留原文件和图片，不安排分镜保存', async (mode) => {
    const files = provide()
    server.use(http.put('*/mock-oss/:uploadId', () => new HttpResponse(null, { status: 503 })))
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    if (mode === '新增') {
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
    } else await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    if (mode === '新增') {
      // 新增失败留在舞台上：错误图标加重试，原因在提示里。
      const retry = await within(page).findByRole('button', { name: '上传失败，点击重试' })
      act(() => retry.focus())
      expect(await screen.findByRole('tooltip')).toHaveTextContent('上传失败（503）')
    } else expect(await screen.findByText('上传失败（503）')).toBeVisible()
    expect(files.writes).toEqual([])
    expect(files.snapshot()).toEqual(document)
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/two.png',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it('替换上传期间服务器换掉目标地址，迟到上传不覆盖服务器新图', async () => {
    const files = provide()
    const release = delayedUpload()
    let registered = 0
    server.events.on('response:mocked', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/confirm')) registered += 1
    })
    const { queryClient } = await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    await within(page).findByRole('status')
    const latest: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: shot.image_urls.map((url, index) =>
                index === 1 ? 'https://example.com/server.png' : url,
              ),
            }
          : shot,
      ),
    }
    const remote = provide(latest, 2)
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(CONVERSATION_ID, PATH),
      })
    })
    await waitFor(() =>
      expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
        'src',
        'https://example.com/server.png',
      ),
    )
    await act(async () => {
      release()
    })
    await waitFor(() => expect(registered).toBe(1))
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
    expect(files.writes).toEqual([])
    expect(remote.writes).toEqual([])
    expect(remote.snapshot()).toEqual(latest)
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
      'src',
      'https://example.com/server.png',
    )
  })

  describe('帧计数弹层', () => {
    it('列出本组全部图片：点图切画面并按规则落到段上，每张都能开大图', async () => {
      provide()
      const { router } = await renderReader('/?shot=1&content=scene:2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const openGallery = async () => {
        await userEvent.click(within(page).getByRole('button', { name: /查看本组全部图片/ }))
        return screen.findByRole('dialog', { name: '本组全部图片' })
      }
      expect(
        within(page).getByRole('button', { name: '第 1 / 2 帧，查看本组全部图片' }),
      ).toBeVisible()

      // 没被任何段引用的 @3 也在这里：只换画面，不高亮任何段。
      let gallery = await openGallery()
      expect(within(gallery).getAllByRole('button', { name: /^第 \d 帧$/ })).toHaveLength(3)
      expect(within(gallery).getByRole('button', { name: '第 2 帧' })).toHaveAttribute(
        'aria-current',
        'true',
      )
      await userEvent.click(within(gallery).getByRole('button', { name: '第 3 帧' }))
      await waitFor(() =>
        expect(router.state.location.search).toEqual({
          shot: 1,
          content: 'unreferenced',
          frame: 3,
        }),
      )
      expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toBeVisible()
      for (const segment of within(page).getAllByRole('group', { name: /^(全局设定|镜头 \d)$/ }))
        expect(segment).toHaveAttribute('aria-current', 'false')

      // 从未引用点回 @1：到第一个引用它的段。
      gallery = await openGallery()
      await userEvent.click(within(gallery).getByRole('button', { name: '第 1 帧' }))
      await waitFor(() =>
        expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 }),
      )
      expect(segmentOf(page, '镜头 1')).toHaveAttribute('aria-current', 'true')

      // 当前段引用的就留在当前段。
      await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
      gallery = await openGallery()
      await userEvent.click(within(gallery).getByRole('button', { name: '第 1 帧' }))
      await waitFor(() =>
        expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 1 }),
      )

      gallery = await openGallery()
      await userEvent.click(within(gallery).getByRole('button', { name: '查看第 3 帧大图' }))
      const lightbox = await screen.findByRole('dialog', { name: '镜头组 1 第 3 帧' })
      expect(within(lightbox).getByRole('img')).toHaveAttribute(
        'src',
        'https://example.com/unassigned.png',
      )
    })

    it('图片任务有新结果的帧在弹层格子上标出来，计数按钮也亮', async () => {
      provide()
      const finished = makeGenerationJob({
        id: 'd4e5f6a7-8b9c-4d0e-9f1a-2b3c4d5e6f70',
        createdAt: '2026-09-01T10:05:00Z',
        kind: 'image',
        metadata: { frame: 3, shot: 1 },
        outputUrl: 'https://example.com/edited.png',
        request: { prompt: '换个颜色', referenceImageUrls: [] },
        status: 'completed',
      })
      server.use(
        http.get('*/api/generations', ({ request }) =>
          HttpResponse.json({
            items: new URL(request.url).searchParams.get('kind') === 'image' ? [finished] : jobs,
          }),
        ),
      )
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const counter = await within(page).findByRole('button', {
        name: '第 1 / 2 帧，查看本组全部图片，有新结果',
      })
      await userEvent.click(counter)
      const gallery = await screen.findByRole('dialog', { name: '本组全部图片' })
      expect(within(gallery).getByRole('button', { name: '第 3 帧，有新结果' })).toBeVisible()
      expect(within(gallery).getByRole('button', { name: '第 1 帧' })).toBeVisible()
    })
  })

  describe('往当前段添加图片：拖放、粘贴与重试', () => {
    const fileTransfer = (files: File[]) => ({
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, webkitGetAsEntry: () => null })),
      types: ['Files'],
    })
    const dropOnStage = (page: HTMLElement) => {
      const target = within(page).getByRole('group', { name: '当前帧图片' })
      fireEvent.dragEnter(target, { dataTransfer: fileTransfer([imageFile()]) })
      fireEvent.drop(target, { dataTransfer: fileTransfer([imageFile()]) })
    }
    const countSigns = () => {
      const counter = { signs: 0 }
      server.events.on('request:start', ({ request }) => {
        if (request.method === 'POST' && request.url.includes('/uploads/sign')) counter.signs += 1
      })
      return counter
    }

    it('拖到舞台上显示松开添加，落下后新图加进当前段、不替换当前帧', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:1&frame=2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const target = within(page).getByRole('group', { name: '当前帧图片' })
      fireEvent.dragEnter(target, { dataTransfer: fileTransfer([imageFile()]) })
      const hint = within(page).getByText('松开添加')
      expect(hint).toBeVisible()
      // 定稿要的是玻璃压白，不是拖动态压暗；jsdom 不算样式，只能认 token 工具类。
      expect(hint.closest('.storyboard-drop')).toHaveClass('bg-glass-surface')
      fireEvent.drop(target, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).queryByText('松开添加')).not.toBeInTheDocument()

      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      const saved = files.snapshot().shots[0]
      expect(saved?.image_urls.slice(0, 3)).toEqual(document.shots[0]?.image_urls)
      expect(saved?.prompt.timeline[0]?.image_indexes).toEqual([2, 1, 4])
      expect(saved?.prompt.timeline[1]).toEqual(document.shots[0]?.prompt.timeline[1])
      expect(within(page).getByRole('img', { name: '镜头组 1 第 4 帧' })).toHaveAttribute(
        'src',
        saved?.image_urls[3],
      )
    })

    it('在正文里粘贴图片，插到光标处；粘贴文字照旧进编辑器', async () => {
      const files = provide(emptyDocument)
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const editor = within(page).getByRole('textbox', { name: '镜头 1 的描述' })
      await replaceText(editor, '粘贴前的正文。')
      expect(editor).toHaveTextContent('粘贴前的正文。')

      pasteFilesIntoComposer(editor, [imageFile()])
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(1), {
        timeout: 3000,
      })
      expect(files.snapshot().shots[0]?.prompt.timeline[0]).toEqual({
        timestamps: [0, 3],
        prompt: '粘贴前的正文。@Image1',
        image_indexes: [1],
      })
      expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toBeVisible()
    })

    const fullDocument: ShotsDocument = {
      ...document,
      shots: document.shots.map((shot) =>
        shot.index === 1
          ? {
              ...shot,
              image_urls: Array.from(
                { length: 30 },
                (_, index) => shot.image_urls[index] ?? `https://example.com/${index + 1}.png`,
              ),
            }
          : shot,
      ),
    }

    it.each([
      { channel: '拖放', lock: '选中未引用的图', reason: '先选一段文案' },
      { channel: '粘贴', lock: '选中未引用的图', reason: '先选一段文案' },
      { channel: '拖放', lock: '达到 30 张', reason: '每组最多使用 30 张参考图' },
      { channel: '粘贴', lock: '达到 30 张', reason: '每组最多使用 30 张参考图' },
      { channel: '拖放', lock: '只读', reason: '当前不能编辑分镜' },
      { channel: '粘贴', lock: '只读', reason: '当前不能编辑分镜' },
      { channel: '拖放', lock: '正在上传', reason: '正在上传，请稍候' },
      { channel: '粘贴', lock: '正在上传', reason: '正在上传，请稍候' },
    ])('$lock 时$channel不添加，toast 说明原因', async ({ channel, lock, reason }) => {
      const files = provide(lock === '达到 30 张' ? fullDocument : document)
      const counter = countSigns()
      await renderReader(
        lock === '选中未引用的图' ? '/?shot=1&content=unreferenced' : '/?shot=1&content=scene:1',
        lock === '只读',
      )
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      if (lock === '正在上传') {
        delayedUpload()
        await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
        await userEvent.upload(screen.getByLabelText('选择要上传的图片'), imageFile())
        await within(page).findByRole('status', { name: /^上传中/ })
      }
      const before = counter.signs
      if (channel === '拖放') dropOnStage(page)
      else pasteFilesIntoComposer(page, [imageFile()])

      expect(await screen.findByText(reason)).toBeVisible()
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(before)
      expect(files.writes).toEqual([])
      if (lock !== '达到 30 张' && lock !== '只读')
        expect(within(page).getByRole('button', { name: '添加图片' })).toHaveAttribute(
          'aria-disabled',
          'true',
        )
    })

    it('上传失败后点重试，用同一个文件再传一次并加进当前段', async () => {
      const files = provide()
      // 签名请求带着文件类型：只选过一次 WebP，两次签名都是 WebP，说明重试用的是留下的原文件。
      const signed: string[] = []
      server.events.on('request:start', async ({ request }) => {
        if (request.method === 'POST' && request.url.includes('/uploads/sign'))
          signed.push(((await request.clone().json()) as { contentType: string }).contentType)
      })
      server.use(
        http.put('*/mock-oss/:uploadId', () => new HttpResponse(null, { status: 503 }), {
          once: true,
        }),
      )
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click(within(page).getByRole('button', { name: '添加图片' }))
      await userEvent.upload(
        screen.getByLabelText('选择要上传的图片'),
        new File(['webp bytes'], '新帧.webp', { type: 'image/webp' }),
      )
      const retry = await within(page).findByRole('button', { name: '上传失败，点击重试' })
      expect(files.writes).toEqual([])

      await userEvent.click(retry)
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      expect(signed).toEqual(['image/webp', 'image/webp'])
      expect(files.snapshot().shots[0]?.prompt.timeline[0]?.image_indexes).toEqual([2, 1, 4])
      expect(
        within(page).queryByRole('button', { name: '上传失败，点击重试' }),
      ).not.toBeInTheDocument()
    })
  })

  describe('正文里敲 @ 选图', () => {
    const secondScene = document.shots[0]?.prompt.timeline[1]?.prompt ?? ''
    /** 聚焦镜头 2 的正文（光标在段首），先粘一段字把光标挪到正文中间，再敲 @。 */
    const typeMentionAfter = async (page: HTMLElement, before: string) => {
      const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
      act(() => editor.focus())
      if (before !== '') pasteTextIntoComposer(editor, before)
      await userEvent.keyboard('@')
      return screen.findByRole('listbox', { name: '插入参考图' })
    }

    it('列出本组全部图片与末格「+」；方向键加 Enter 把刚敲的 @ 换成引用，插在光标处，舞台切到那帧，光标留在引用之后', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const menu = await typeMentionAfter(page, '先')
      expect(
        within(menu)
          .getAllByRole('option')
          .map((option) => option.getAttribute('aria-label')),
      ).toEqual(['插入第 1 帧', '插入第 2 帧', '插入第 3 帧', '添加图片'])
      expect(within(menu).getByRole('option', { name: '插入第 1 帧' })).toHaveAttribute(
        'aria-selected',
        'true',
      )

      await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}')
      expect(screen.queryByRole('listbox', { name: '插入参考图' })).not.toBeInTheDocument()
      expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toBeVisible()
      await userEvent.keyboard('又')
      await waitFor(
        () =>
          expect(files.snapshot().shots[0]?.prompt.timeline[1]).toEqual({
            timestamps: [3.25, 5],
            prompt: `先@Image3又${secondScene}`,
            image_indexes: [3, 2, 1],
          }),
        { timeout: 3000 },
      )
    })

    it('点格子同样插入', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const menu = await typeMentionAfter(page, '')
      await userEvent.click(within(menu).getByRole('option', { name: '插入第 1 帧' }))
      await waitFor(
        () =>
          expect(files.snapshot().shots[0]?.prompt.timeline[1]?.prompt).toBe(
            `@Image1${secondScene}`,
          ),
        { timeout: 3000 },
      )
    })

    it('Esc 只关弹层：字面 @ 留在正文里，不插引用', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await typeMentionAfter(page, '先')
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('listbox', { name: '插入参考图' })).not.toBeInTheDocument()
      await waitFor(
        () =>
          expect(files.snapshot().shots[0]?.prompt.timeline[1]).toEqual({
            timestamps: [3.25, 5],
            prompt: `先@${secondScene}`,
            image_indexes: [2, 1],
          }),
        { timeout: 3000 },
      )
    })

    it('末格「+」打开添加图片，关联的图换掉这个 @', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await typeMentionAfter(page, '先')
      await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{Enter}')
      const picker = await screen.findByRole('dialog', { name: '添加图片' })
      await userEvent.click(within(picker).getByRole('button', { name: '关联第 3 张图片' }))
      await waitFor(
        () =>
          expect(files.snapshot().shots[0]?.prompt.timeline[1]?.prompt).toBe(
            `先@Image3${secondScene}`,
          ),
        { timeout: 3000 },
      )
    })

    it('只读时敲 @ 不弹出选图，也不写工作区', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:2', true)
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const editor = within(page).getByRole('textbox', { name: '镜头 2 的描述' })
      act(() => editor.focus())
      await userEvent.keyboard('@')
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(screen.queryByRole('listbox', { name: '插入参考图' })).not.toBeInTheDocument()
      expect(files.writes).toEqual([])
    })
  })
})

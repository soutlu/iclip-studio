import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION } from '@/shared/auth'
import { USER_QUERY_KEY } from '@/shared/auth/session'
import { Toaster, toast } from '@/shared/ui/toast'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { workspaceQueryKeys, type ArtifactRendererProps } from '@/shared/workbench'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { openAddImage } from '@/testing/storyboard'
import type { ShotsDocument } from '../shot-document'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { StoryboardReader } from './storyboard-reader'
import { sessionEnvelope } from '@/testing/ws'

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

const renderReader = async (initialPath = '/?shot=1&content=scene:1', readOnly = false) => {
  const rendered = await renderWithProviders(
    <>
      <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />
      <Toaster />
    </>,
    {
      initialPath,
    },
  )
  // 正文收不收图片看上传权限：等登录身份读到再操作。
  await waitFor(() => expect(rendered.queryClient.getQueryData(USER_QUERY_KEY)).toBeTruthy())
  return rendered
}

/** 成片区里的卡，新的在前。 */
const findTakes = async () =>
  within(await screen.findByRole('region', { name: '本组成片' })).getAllByRole('listitem')

/** 各张卡的提交时刻，认卡用。 */
const takeTimes = (takes: HTMLElement[]) =>
  takes.map((take) => take.querySelector('time')?.getAttribute('datetime'))

/** 成片区里某张卡本身（整张卡是一个按钮）。 */
const takeCard = (take: HTMLElement) => within(take).getByRole('button')

/** 文案列里的一段：全局设定或「镜头 N」。 */
const segmentOf = (page: HTMLElement, name: string) => within(page).getByRole('group', { name })

/** 舞台左上的当前帧标签：正文编辑器之外写着 `@N` 的文字（编辑器里的 @N 是引用胶囊）。 */
const stageTags = (page: HTMLElement) =>
  within(page)
    .queryAllByText(/^@\d+$/)
    .filter((element) => element.closest('[role="textbox"]') === null)
    .map((element) => element.textContent)

/** 某段的正文编辑器。 */
const editorOf = (page: HTMLElement, name: string) => within(page).getByRole('textbox', { name })

/** 往这段正文里粘贴一张图：落成光标处（没聚焦过就是段首）的附件 chip，传好前不改正文。 */
const pasteImage = (page: HTMLElement, name: string, file = imageFile()) =>
  pasteFilesIntoComposer(editorOf(page, name), [file])

/** 这段正文里某张图的 chip：上传中、失败都在它上面。 */
const findChip = (page: HTMLElement, name: string, file = '新帧.png') =>
  within(editorOf(page, name)).findByText(file)

/** 点开失败的 chip，在失败卡片上按「重试」。jsdom 没有 elementFromPoint，走不通 PM 的 mousedown，只发 click。 */
const retryChip = async (page: HTMLElement, name: string, file = '新帧.png') => {
  fireEvent.click(await findChip(page, name, file))
  const card = await screen.findByRole('dialog', { name: `${file}上传失败` })
  await userEvent.click(within(card).getByRole('button', { name: '重试' }))
}

/** 本机文件的拖放数据。 */
const fileTransfer = (files: File[]) => ({
  files,
  items: files.map((file) => ({ kind: 'file', type: file.type, webkitGetAsEntry: () => null })),
  types: ['Files'],
})

/** 数上传签名请求：发没发起上传看它。 */
const countSigns = () => {
  const counter = { signs: 0 }
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && request.url.includes('/uploads/sign')) counter.signs += 1
  })
  return counter
}

/** 顶栏的组号胶囊，点开是镜头组列表。 */
const groupPill = () => screen.getByRole('button', { name: /展开镜头组列表/ })

/** 从顶栏组号展开镜头组列表，点第 n 组。 */
const openShot = async (index: number) => {
  await userEvent.click(groupPill())
  const list = await screen.findByRole('menu', { name: '镜头组列表' })
  await userEvent.click(
    within(list).getByRole('menuitemradio', { name: new RegExp(`^第 ${index} 组`) }),
  )
}

/** 点开出片栏上的选择器，在弹出的菜单里选中一项。 */
const pickFromMenu = async (
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  name: string,
) => {
  await user.click(trigger)
  await user.click(await screen.findByRole('menuitemradio', { name }))
}

describe('StoryboardReader', () => {
  beforeEach(() => {
    // 往正文里加图要上传权限。
    loginAs(mockAuthUser)
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
    // 时长胶囊写时长，完整区间给读屏。
    expect(first).toHaveTextContent('2.5s，0.0s – 2.5s')
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
    await userEvent.click(within(page).getByRole('button', { name: '上一帧' }))
    expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toBeVisible()
    expect(second).toHaveAttribute('aria-current', 'true')
    await userEvent.click(within(second).getByRole('button', { name: '看第 2 帧' }))
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

  it('帧箭头沿当前内容引用顺序导航、到头的一侧不出现、点了不开原图；↑↓ 切组、换组时默认选中全局设定，编辑器里的方向键不切组', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).queryByRole('button', { name: '上一帧' })).not.toBeInTheDocument()
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: '下一帧' })).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: '上一帧' })).toBeVisible()

    within(page).getByRole('textbox', { name: '镜头 1 的描述' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 1 })

    groupPill().focus()
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(groupPill()).toHaveAccessibleName('镜头组 2 / 2，展开镜头组列表')
    expect(screen.queryByRole('menu', { name: '镜头组列表' })).not.toBeInTheDocument()
    const second = screen.getByRole('region', { name: '镜头组 2' })
    expect(segmentOf(second, '全局设定')).toHaveAttribute('aria-current', 'true')
    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
  })

  it('顶栏上一组、下一组与 ↑↓ 同一条路径切组，到头的一侧禁用，焦点交给组号、↑↓ 照样能切', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const previous = await screen.findByRole('button', { name: '上一组' })
    const next = screen.getByRole('button', { name: '下一组' })
    const all = groupPill()
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    expect(next).not.toHaveAttribute('aria-disabled')

    await userEvent.click(next)
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(all).toHaveAccessibleName('镜头组 2 / 2，展开镜头组列表')
    expect(segmentOf(screen.getByRole('region', { name: '镜头组 2' }), '全局设定')).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(next).toHaveAttribute('aria-disabled', 'true')
    expect(previous).not.toHaveAttribute('aria-disabled')
    expect(all).toHaveFocus()

    await userEvent.keyboard('{ArrowUp}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
    await userEvent.click(next)
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    await userEvent.click(previous)
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    expect(all).toHaveFocus()
    expect(screen.queryByRole('menu', { name: '镜头组列表' })).not.toBeInTheDocument()
  })

  it('舞台左上只标当前帧 @N，跟着切帧、切段变，段里没图就不标；点舞台上的编辑、替换不开原图', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(stageTags(page)).toEqual(['@2'])
    await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
    expect(stageTags(page)).toEqual(['@1'])
    await act(async () => {
      await router.navigate({ href: '/?shot=1&content=unreferenced' })
    })
    expect(stageTags(page)).toEqual(['@3'])

    await userEvent.click(within(page).getByRole('button', { name: '替换图片' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(within(page).getByRole('button', { name: '编辑图片' }))
    expect(await screen.findByRole('dialog', { name: /^编辑图片/ })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '镜头组 1 第 3 帧' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(within(page).getByRole('button', { name: '镜头 3' }))
    expect(stageTags(page)).toEqual([])
  })

  it('焦点在舞台里时 ←/→ 切帧、到头不动，切到头的箭头消失后焦点落回画面；正文与帧计数弹层里的 ←/→ 不切帧', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const at = (frame: number) =>
      waitFor(() =>
        expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame }),
      )
    const open = within(page).getByRole('button', { name: '打开原图' })
    act(() => open.focus())
    await userEvent.keyboard('{ArrowRight}')
    await at(1)
    expect(open).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await at(1)
    await userEvent.keyboard('{ArrowLeft}')
    await at(2)

    act(() => within(page).getByRole('button', { name: '下一帧' }).focus())
    await userEvent.keyboard('{ArrowRight}')
    await at(1)
    expect(within(page).queryByRole('button', { name: '下一帧' })).not.toBeInTheDocument()
    expect(open).toHaveFocus()

    act(() => within(page).getByRole('textbox', { name: '镜头 1 的描述' }).focus())
    await userEvent.keyboard('{ArrowLeft}')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
    await at(1)

    await userEvent.click(within(page).getByRole('button', { name: /查看本组全部图片/ }))
    await screen.findByRole('dialog', { name: '本组全部图片' })
    await userEvent.keyboard('{ArrowLeft}')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)))
    await at(1)
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

  it('文案列照原文展示全局设定与各镜头正文，镜头标出时长与区间，浏览不改地址', async () => {
    provide()
    const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const original = document.shots[0]
    expect(within(page).getByRole('textbox', { name: '全局设定' }).textContent).toBe(
      original?.prompt.global_settings.replaceAll('\n', ''),
    )
    const second = segmentOf(page, '镜头 2')
    expect(second).toHaveTextContent('1.8s，3.3s – 5.0s')
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

  it('顶栏组号展开镜头组列表，标出并聚焦当前组，点一组切过去、列表收起、焦点回到组号，成片区只列当前组', async () => {
    provide()
    const { router } = await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    expect(takeTimes(await findTakes())).toEqual([jobs[0]?.createdAt])
    await userEvent.click(groupPill())
    const list = await screen.findByRole('menu', { name: '镜头组列表' })
    const rows = within(list).getAllByRole('menuitemradio')
    expect(rows).toHaveLength(2)
    const [first, second] = rows
    expect(first).toHaveAccessibleName(/^第 1 组/)
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()
    await waitFor(() => expect(first).toHaveFocus())
    expect(within(list).queryByRole('button', { name: /复制/ })).not.toBeInTheDocument()

    await userEvent.click(within(list).getByRole('menuitemradio', { name: /^第 2 组/ }))
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 2 }))
    expect(list).not.toBeInTheDocument()
    await waitFor(() => expect(groupPill()).toHaveFocus())
    expect(groupPill()).toHaveAccessibleName('镜头组 2 / 2，展开镜头组列表')
    await screen.findByRole('region', { name: '镜头组 2' })
    expect(takeTimes(await findTakes())).toEqual([jobs[1]?.createdAt])
  })

  it('镜头组列表用键盘操作：Enter 展开、方向键在组间移动、Enter 切组；Esc 收起不切组，焦点回到组号', async () => {
    provide()
    const { router } = await renderReader('/?shot=2')
    await screen.findByRole('region', { name: '镜头组 2' })
    groupPill().focus()
    await userEvent.keyboard('{Enter}')
    const list = await screen.findByRole('menu', { name: '镜头组列表' })
    const current = within(list).getByRole('menuitemradio', { name: /^第 2 组/ })
    await waitFor(() => expect(current).toHaveFocus())
    await userEvent.keyboard('{ArrowUp}')
    expect(within(list).getByRole('menuitemradio', { name: /^第 1 组/ })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(list).not.toBeInTheDocument()
    await waitFor(() => expect(groupPill()).toHaveFocus())
    expect(router.state.location.search).toEqual({ shot: 2 })

    await userEvent.keyboard('{Enter}')
    const reopened = await screen.findByRole('menu', { name: '镜头组列表' })
    await waitFor(() =>
      expect(within(reopened).getByRole('menuitemradio', { name: /^第 2 组/ })).toHaveFocus(),
    )
    await userEvent.keyboard('{ArrowUp}{Enter}')
    await waitFor(() => expect(router.state.location.search).toEqual({ shot: 1 }))
    expect(reopened).not.toBeInTheDocument()
    await waitFor(() => expect(groupPill()).toHaveFocus())
  })

  it('接口提交的出片（只有镜号、正文不是结构化 shot）照样列在本组成片区，点卡片在舞台上播、不开灯箱，焦点留在卡上', async () => {
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
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    const card = takeCard(take)

    await userEvent.click(card)

    expect(within(page).getByRole('group', { name: '播放器：生成的视频' })).toBeVisible()
    expect(within(page).getByLabelText('生成的视频', { selector: 'video' })).toHaveAttribute(
      'src',
      'https://example.com/task.mp4',
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(card).toHaveFocus()
    // 只有正文回填不了，照样能下载、能编辑。
    expect(within(page).getByRole('button', { name: '回填提示词' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(within(page).getByRole('button', { name: '编辑视频' })).not.toHaveAttribute(
      'aria-disabled',
    )
    expect(within(page).getByRole('button', { name: '下载视频' })).not.toHaveAttribute(
      'aria-disabled',
    )
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

      const editor = await screen.findByRole('dialog', { name: /^编辑视频/ })
      expect(await within(editor).findByRole('group', { name: '播放控件' })).toBeVisible()
      expect(screen.queryByText(/未找到该视频记录/)).not.toBeInTheDocument()
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
      expect(screen.getByRole('button', { name: '视频模型' })).toHaveTextContent(
        'vendor-a-seedance-2-5',
      ),
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
    // 选中成片照样能看、能下载；回填与编辑视频都不出现。
    await userEvent.click(takeCard(take))
    expect(within(page).getByRole('group', { name: '播放器：生成的视频' })).toBeVisible()
    expect(within(page).getByRole('button', { name: '下载视频' })).not.toHaveAttribute(
      'aria-disabled',
    )
    expect(within(page).queryByRole('button', { name: '回填提示词' })).toBeNull()
    expect(within(page).queryByRole('button', { name: '编辑视频' })).toBeNull()
    expect(files.writes).toEqual([])
  })

  it('选中成片后点回填，把那次出片的镜头组写回当前组并保存', async () => {
    const files = provide()
    server.use(http.get('*/api/generations', () => HttpResponse.json({ items: [editableJob] })))
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const [take] = await findTakes()
    if (take === undefined) throw new Error('成片区缺这条出片')
    await userEvent.click(takeCard(take))
    await userEvent.click(within(page).getByRole('button', { name: '回填提示词' }))
    expect(await screen.findByText('已将历史提示词回填到当前镜头组')).toBeVisible()

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
    await userEvent.click(takeCard(take))
    expect(within(page).getByRole('group', { name: '播放器：生成的视频' })).toBeVisible()
    await userEvent.click(within(page).getByRole('button', { name: '镜头 1' }))
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
    expect(within(tray).getByRole('button', { name: /生成中$/ })).toBeVisible()
    expect(within(tray).queryByRole('button', { name: /的成片$/ })).not.toBeInTheDocument()

    act(() => {
      socket.deliver({
        ...sessionEnvelope(CONVERSATION_ID),
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

    expect(await within(tray).findByRole('button', { name: /的成片$/ })).toBeVisible()
    expect(within(tray).queryByRole('button', { name: /生成中$/ })).not.toBeInTheDocument()
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
        ...sessionEnvelope(CONVERSATION_ID),
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
    const editor = await screen.findByRole('dialog', { name: '编辑图片 镜头组 1 · 帧 @2' })
    // 从角标进来直接落在那条结果上，不是落在标注画布上。
    await waitFor(() =>
      expect(
        within(editor).getByRole('group', { name: '这一帧的图片' }).querySelector('[aria-pressed]'),
      ).toBeTruthy(),
    )
    expect(within(editor).getByRole('slider', { name: '对比分割线' })).toBeVisible()
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
    const model = within(bar).getByRole('button', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveTextContent('vendor-a-seedance-2-5'))
    await pickFromMenu(user, model, 'wan3.0-video')
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
    expect(within(newest as HTMLElement).getByRole('button', { name: /生成中$/ })).toBeVisible()
    // 出片不替人切走：舞台还是原来那帧，新卡只出现在成片区最前面。
    expect(screen.getByRole('img', { name: '镜头组 1 第 2 帧' })).toBeVisible()
    expect(within(newest as HTMLElement).getByRole('button')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    // 出片后设置不回退，下一次出片沿用。
    expect(model).toHaveTextContent('wan3.0-video')
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
    const model = within(bar).getByRole('button', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveTextContent('vendor-a-seedance-2-5'))
    await pickFromMenu(user, model, 'wan3.0-video')
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

    const aspect = await screen.findByRole('button', { name: '画幅' })
    const aspectMenu = async () => {
      await user.click(aspect)
      return screen.findByRole('menu', { name: '画幅' })
    }
    const option = (menu: HTMLElement, value: string) =>
      within(menu).getByRole('menuitemradio', { name: new RegExp(`^${value}`) })
    // 默认的 seedance 做得了 21:9，选得动。
    let menu = await aspectMenu()
    expect(option(menu, '21:9')).not.toHaveAttribute('aria-disabled')
    await user.click(option(menu, '21:9'))
    await waitFor(() => expect(files.writes).toHaveLength(1))
    expect(files.snapshot().aspect_ratio).toBe('21:9')
    expect(aspect).toHaveTextContent('21:9')

    // 换成做不了 21:9 的万相：模型照选不误，画幅那一项标上不支持，出片栏里提醒但不禁用。
    const model = screen.getByRole('button', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveTextContent('vendor-a-seedance-2-5'))
    await user.click(model)
    const wan = await screen.findByRole('menuitemradio', { name: 'wan3.0-video' })
    expect(wan).not.toHaveAttribute('aria-disabled')
    await user.click(wan)
    menu = await aspectMenu()
    expect(option(menu, '21:9')).toHaveAttribute('aria-disabled', 'true')
    expect(option(menu, '21:9')).toHaveAccessibleName(/不支持/)
    expect(option(menu, '21:9')).toBeChecked()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    expect(
      await within(bar).findByRole('alert', { name: 'wan3.0-video 不支持 21:9 画幅' }),
    ).toBeVisible()
    // 画幅按钮自己也标着错，说明指向同一行提醒。
    expect(aspect).toHaveAccessibleDescription('wan3.0-video 不支持 21:9 画幅')

    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })
    expect(generate).not.toHaveAttribute('aria-disabled')
    await user.click(generate)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ aspect_ratio: '21:9', model: 'wan3.0-video' })
  })

  it('画幅不在档位里时照原样显示并勾着它；选择器能只用键盘操作', async () => {
    const files = provide({ ...document, aspect_ratio: '2.39:1' })
    const user = userEvent.setup()
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const aspect = within(bar).getByRole('button', { name: '画幅' })
    expect(aspect).toHaveTextContent('2.39:1')

    act(() => aspect.focus())
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: '画幅' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items[0]).toHaveAccessibleName('2.39:1')
    expect(items[0]).toBeChecked()
    // 方向键移到下一档，回车选中并写回分镜；菜单收起后焦点回到按钮上。
    await user.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(files.writes).toHaveLength(1))
    expect(files.snapshot().aspect_ratio).toBe('1:1')
    expect(aspect).toHaveTextContent('1:1')
    await waitFor(() => expect(aspect).toHaveFocus())

    // Esc 收起菜单，不改值。
    const model = within(bar).getByRole('button', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveTextContent('vendor-a-seedance-2-5'))
    act(() => model.focus())
    await user.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu', { name: '视频模型' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(model).toHaveTextContent('vendor-a-seedance-2-5')
    expect(model).toHaveFocus()
  })

  it('提交出片期间模型与画幅都选不动', async () => {
    provide()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/generations/video', async () => {
        await held
        return HttpResponse.json({ task_id: runningJob.id }, { status: 202 })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const model = within(bar).getByRole('button', { name: '视频模型' })
    const aspect = within(bar).getByRole('button', { name: '画幅' })
    await waitFor(() => expect(model).toBeEnabled())
    expect(aspect).toBeEnabled()

    await userEvent.click(within(bar).getByRole('button', { name: '生成第 1 组' }))
    expect(await within(bar).findByRole('button', { name: '提交中…' })).toBeVisible()
    expect(model).toBeDisabled()
    expect(aspect).toBeDisabled()

    release()
    await waitFor(() => expect(model).toBeEnabled())
    expect(aspect).toBeEnabled()
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
    const model = screen.getByRole('button', { name: '视频模型' })
    await waitFor(() => expect(model).toHaveTextContent('无法读取视频模型'))
    expect(model).toBeDisabled()
    const generate = screen.getByRole('button', { name: '生成第 1 组' })
    expect(generate).toHaveAttribute('aria-disabled', 'true')

    // 原因常显在出片栏的状态行上，不用悬停或聚焦；置灰的按钮仍能聚焦，说明关联到这一行。
    expect(generate).toHaveAccessibleDescription('无法读取视频模型')
    const reason = window.document.getElementById(generate.getAttribute('aria-describedby') ?? '')
    expect(screen.getByRole('group', { name: '出片工具栏' })).toContainElement(reason)
    expect(reason).toBeVisible()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('视频模型清单还在读时不能出片，原因只给读屏、不在出片栏上占一行', async () => {
    provide()
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/generations/video-models', async () => {
        await held
        return HttpResponse.json({
          default: 'vendor-a-seedance-2-5',
          items: ['vendor-a-seedance-2-5'],
        })
      }),
    )
    await renderReader()
    await screen.findByRole('region', { name: '镜头组 1' })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })
    expect(generate).toHaveAttribute('aria-disabled', 'true')
    expect(generate).toHaveAccessibleDescription('正在读取视频模型')

    release()
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))
    expect(generate).not.toHaveAccessibleDescription()
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

  it('小数时间段的时长胶囊显示 5.9s、区间 16.0s – 21.9s，不暴露浮点计算尾差', async () => {
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
    expect(segmentOf(page, '镜头 2')).toHaveTextContent('5.9s，16.0s – 21.9s')
  })

  it('文件内容无效时明确显示读取错误', async () => {
    provide('{ invalid JSON')
    // 读不出镜头组就没有正文编辑器，不用等上传权限。
    await renderWithProviders(
      <StoryboardReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={false} />,
      { initialPath: '/?shot=1&content=scene:1' },
    )
    expect(await screen.findByText('文件格式不正确，无法读取镜头组')).toBeVisible()
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
      '本组暂无图片',
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
    // 段首敲的 @ 换成引用：新引用排在最前，编号顺序跟着正文变。
    const picker = await openAddImage(editorOf(page, '镜头 1 的描述'))
    await userEvent.click(within(picker).getByRole('button', { name: '关联第 3 张图片' }))
    await waitFor(
      () =>
        expect(files.snapshot().shots[0]?.prompt.timeline[0]).toEqual({
          timestamps: [0, 2.5],
          prompt: '@Image3' + document.shots[0]?.prompt.timeline[0]?.prompt,
          image_indexes: [3, 2, 1],
        }),
      { timeout: 3000 },
    )
    const saved = files.snapshot().shots[0]
    expect(saved?.image_urls).toEqual(document.shots[0]?.image_urls)
    expect(within(page).getByRole('img', { name: '镜头组 1 第 3 帧' })).toHaveAttribute(
      'src',
      'https://example.com/unassigned.png',
    )
  })

  it('无图镜头从选择器上传首图：@ 换成上传中的 chip，期间照常编辑，传好换成 @1 与地址一起保存', async () => {
    const files = provide(emptyDocument)
    const release = delayedUpload()
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const editor = editorOf(page, '镜头 1 的描述')
    const picker = await openAddImage(editor)
    await userEvent.upload(within(picker).getByLabelText('选择要上传的图片'), imageFile())
    await findChip(page, '镜头 1 的描述')
    expect(within(editor).getByRole('progressbar', { name: '上传中' })).toBeInTheDocument()
    expect(editor).toHaveTextContent(/^新帧\.png无图镜头一。$/)
    // 光标在 chip 之后：上传期间接着写。
    pasteTextIntoComposer(editor, '上传时补的字，')
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
      prompt: '@Image1上传时补的字，无图镜头一。',
      image_indexes: [1],
    })
    expect(saved?.prompt.timeline[1]).toEqual(emptyDocument.shots[0]?.prompt.timeline[1])
    expect(within(editor).queryByText('新帧.png')).not.toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: '看第 1 帧' })).toBeVisible()
    expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
      'src',
      saved?.image_urls[0],
    )
  })

  it('新增上传期间切换镜头组：整页卸载，chip 随之丢掉，迟到结果不回填也不保存', async () => {
    const files = provide()
    const release = delayedUpload()
    let registered = 0
    server.events.on('response:mocked', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/confirm')) registered += 1
    })
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    pasteImage(page, '镜头 1 的描述')
    await findChip(page, '镜头 1 的描述')
    await openShot(2)
    await act(async () => {
      release()
    })
    await waitFor(() => expect(registered).toBe(1))
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
    expect(files.writes).toEqual([])
    expect(files.snapshot()).toEqual(document)
  })

  it.each(['镜头', '图片'])(
    '新增上传期间切换%s：图归发起的那段，传好照旧落回 chip 所在处',
    async (target) => {
      const files = provide()
      const release = delayedUpload()
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述')
      await findChip(page, '镜头 1 的描述')
      if (target === '镜头')
        await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
      else await userEvent.click(within(page).getByRole('button', { name: '下一帧' }))
      await act(async () => {
        release()
      })
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      expect(files.snapshot().shots[0]?.prompt.timeline[0]?.prompt).toBe(
        `@Image4${document.shots[0]?.prompt.timeline[0]?.prompt ?? ''}`,
      )
      expect(files.snapshot().shots[0]?.prompt.timeline[1]).toEqual(
        document.shots[0]?.prompt.timeline[1],
      )
      if (target === '镜头')
        // 用户已经去了别的段，选区不被拽回来。
        expect(segmentOf(page, '镜头 2')).toHaveAttribute('aria-current', 'true')
      // 还在原来那段：舞台跟到新图。
      else expect(await within(page).findByRole('img', { name: '镜头组 1 第 4 帧' })).toBeVisible()
    },
  )

  it('替换上传期间切换镜头组，上传失败仍然提示且不保存', async () => {
    const files = provide()
    const release = delayedUpload(503)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
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
      '分镜未保存',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it('新增上传后保存失败，提示图片已上传、分镜未保存', async () => {
    const files = provide()
    files.failSave('服务暂时不可用')
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    pasteImage(page, '镜头 1 的描述')
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

  it('无图镜头组的舞台留空，舞台上没有添加入口；添加图片在正文的 @ 选图里', async () => {
    const files = provide(emptyDocument)
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    expect(within(page).queryByRole('img')).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: '打开原图' })).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: '添加图片' })).not.toBeInTheDocument()
    expect(await openAddImage(editorOf(page, '镜头 1 的描述'))).toBeVisible()
    // 敲下的 @ 会存盘：等它落定，别让这次写入漏到下一个用例。
    await waitFor(() => expect(files.writes).toHaveLength(1), { timeout: 3000 })
  })

  it('关联已有图片保存失败不会误报为上传成功', async () => {
    const files = provide()
    files.failSave('保存失败')
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    const picker = await openAddImage(editorOf(page, '镜头 1 的描述'))
    await userEvent.click(within(picker).getByRole('button', { name: '关联第 3 张图片' }))
    expect(await screen.findByRole('alert', undefined, { timeout: 3000 })).toHaveTextContent(
      '分镜未保存',
    )
    expect(screen.queryByText('已上传，分镜未保存')).not.toBeInTheDocument()
  })

  it.each(['新增', '替换'])('%s上传失败保留原文件和图片，不安排分镜保存', async (mode) => {
    const files = provide()
    server.use(http.put('*/mock-oss/:uploadId', () => new HttpResponse(null, { status: 503 })))
    await renderReader()
    const page = await screen.findByRole('region', { name: '镜头组 1' })
    if (mode === '新增') pasteImage(page, '镜头 1 的描述')
    else await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
    if (mode === '新增') {
      // 新增失败留在正文的 chip 上：警示图标，点开失败卡片看原因。
      const editor = editorOf(page, '镜头 1 的描述')
      await within(editor).findByRole('img', { name: '上传失败' })
      fireEvent.click(within(editor).getByText('新帧.png'))
      expect(await screen.findByRole('dialog', { name: '新帧.png上传失败' })).toHaveTextContent(
        '上传失败（503）',
      )
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
      // 弹层只用来看和切帧，没有添加入口。
      expect(within(gallery).queryByRole('button', { name: '添加图片' })).not.toBeInTheDocument()
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

  describe('拖到舞台上替换当前帧', () => {
    it('拖入时显示松开替换，落下后换掉当前帧：地址、帧号与正文引用都不变，不新增', async () => {
      const files = provide()
      const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const target = within(page).getByRole('group', { name: '当前帧图片' })
      fireEvent.dragEnter(target, { dataTransfer: fileTransfer([imageFile()]) })
      const hint = within(page).getByText('松开可替换当前图片')
      expect(hint).toBeVisible()
      // 定稿要的是玻璃压白，不是拖动态压暗；jsdom 不算样式，只能认 token 工具类。
      expect(hint.closest('.storyboard-drop')).toHaveClass('bg-glass-surface')
      fireEvent.drop(target, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).queryByText('松开可替换当前图片')).not.toBeInTheDocument()

      await waitFor(
        () => expect(files.snapshot().shots[0]?.image_urls[1]).toContain('/mock-oss/'),
        { timeout: 3000 },
      )
      const saved = files.snapshot().shots[0]
      expect(saved?.image_urls).toHaveLength(3)
      expect(saved?.image_urls[0]).toBe(document.shots[0]?.image_urls[0])
      expect(saved?.image_urls[2]).toBe(document.shots[0]?.image_urls[2])
      expect(saved?.prompt).toEqual(document.shots[0]?.prompt)
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 2 })
      expect(within(page).getByRole('img', { name: '镜头组 1 第 2 帧' })).toHaveAttribute(
        'src',
        saved?.image_urls[1],
      )
    })

    it('拖到叠在画面上的切帧箭头上照样亮提示，落下换掉当前帧', async () => {
      const files = provide()
      const { router } = await renderReader('/?shot=1&content=scene:1&frame=2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const arrow = within(page).getByRole('button', { name: '下一帧' })
      fireEvent.dragEnter(arrow, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).getByText('松开可替换当前图片')).toBeVisible()
      fireEvent.drop(arrow, { dataTransfer: fileTransfer([imageFile()]) })
      await waitFor(
        () => expect(files.snapshot().shots[0]?.image_urls[1]).toContain('/mock-oss/'),
        { timeout: 3000 },
      )
      expect(files.snapshot().shots[0]?.image_urls).toHaveLength(3)
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1', frame: 2 })
    })

    it('一次拖入多张不替换，提示只能一张', async () => {
      const files = provide()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1&frame=2')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      fireEvent.drop(within(page).getByRole('group', { name: '当前帧图片' }), {
        dataTransfer: fileTransfer([imageFile(), imageFile()]),
      })
      expect(await screen.findByText('每次只能替换一张图片')).toBeVisible()
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])
    })

    it.each(['只读', '正在替换'])('%s时拖入不亮提示、不上传', async (lock) => {
      const files = provide()
      const counter = countSigns()
      if (lock === '正在替换') delayedUpload()
      await renderReader('/?shot=1&content=scene:1&frame=2', lock === '只读')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      if (lock === '正在替换') {
        await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
        await within(page).findByText('正在上传…')
      }
      const before = counter.signs
      const target = within(page).getByRole('group', { name: '当前帧图片' })
      fireEvent.dragEnter(target, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).queryByText('松开可替换当前图片')).not.toBeInTheDocument()
      fireEvent.drop(target, { dataTransfer: fileTransfer([imageFile()]) })
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(before)
      expect(files.writes).toEqual([])
    })
  })

  describe('往段里添加图片：粘贴、拖放与重试', () => {
    it('在舞台上粘贴图片不添加：不上传、不提示、不写入', async () => {
      const files = provide()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const stage = within(page).getByRole('group', { name: '当前帧图片' })
      act(() => within(stage).getByRole('button', { name: '打开原图' }).focus())
      pasteFilesIntoComposer(stage, [imageFile()])
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])
      expect(screen.queryByRole('progressbar', { name: '上传中' })).not.toBeInTheDocument()
      const notifications = screen.getByRole('region', { name: /Notifications/ })
      expect(within(notifications).queryAllByRole('listitem')).toHaveLength(0)
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

    it('达到 30 张时粘贴图片在段里就地提示，不上传、不写入', async () => {
      const files = provide(fullDocument)
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述')
      expect(
        await within(segmentOf(page, '镜头 1')).findByText(
          '每组最多使用 30 张参考图，本次有 1 张未添加',
        ),
      ).toBeVisible()
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])
      expect(within(editorOf(page, '镜头 1 的描述')).queryByText('新帧.png')).toBeNull()
    })

    it('在途的图也占名额：还差 1 张满时一次粘贴两张，只收下 1 张', async () => {
      const almostFull: ShotsDocument = {
        ...fullDocument,
        shots: fullDocument.shots.map((shot) =>
          shot.index === 1 ? { ...shot, image_urls: shot.image_urls.slice(0, 29) } : shot,
        ),
      }
      const files = provide(almostFull)
      const release = delayedUpload()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteFilesIntoComposer(editorOf(page, '镜头 1 的描述'), [
        new File(['a'], '甲.png', { type: 'image/png' }),
        new File(['b'], '乙.png', { type: 'image/png' }),
      ])
      await findChip(page, '镜头 1 的描述', '甲.png')
      expect(
        within(segmentOf(page, '镜头 1')).getByText('每组最多使用 30 张参考图，本次有 1 张未添加'),
      ).toBeVisible()
      // 第一张还在传，再往另一段粘贴也放不下了。
      pasteImage(page, '镜头 2 的描述')
      expect(
        await within(segmentOf(page, '镜头 2')).findByText(
          '每组最多使用 30 张参考图，本次有 1 张未添加',
        ),
      ).toBeVisible()
      expect(counter.signs).toBe(1)
      await act(async () => {
        release()
      })
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(30), {
        timeout: 3000,
      })
    })

    it('只读时在正文里粘贴图片不收：不上传、不写入', async () => {
      const files = provide()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1', true)
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述')
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])
      expect(within(editorOf(page, '镜头 1 的描述')).queryByText('新帧.png')).toBeNull()
    })

    it('没有上传权限时正文不收图片：粘贴不上传，拖到段卡上不亮提示，选择器里不能上传', async () => {
      loginAs(mockAuthUser, {
        permissions: mockAuthUser.permissions.filter((item) => item !== PERMISSION.uploadsWrite),
      })
      const files = provide()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述')
      const segment = segmentOf(page, '镜头 2')
      fireEvent.dragEnter(segment, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(segment).queryByText('松开可添加到镜头 2')).not.toBeInTheDocument()
      fireEvent.drop(segment, { dataTransfer: fileTransfer([imageFile()]) })
      const picker = await openAddImage(editorOf(page, '镜头 1 的描述'))
      expect(within(picker).getByRole('button', { name: '上传图片' })).toBeDisabled()
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(0)
      // 只有敲下的 @ 存了盘。
      expect(files.snapshot().shots[0]?.image_urls).toEqual(document.shots[0]?.image_urls)
    })

    it('可以同时传几张：上传期间再粘贴照样收下，各自传好各自换成引用', async () => {
      const files = provide()
      const release = delayedUpload()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述', new File(['a'], '甲.png', { type: 'image/png' }))
      await findChip(page, '镜头 1 的描述', '甲.png')
      pasteImage(page, '镜头 2 的描述', new File(['b'], '乙.png', { type: 'image/png' }))
      await findChip(page, '镜头 2 的描述', '乙.png')
      expect(within(page).getAllByRole('progressbar', { name: '上传中' })).toHaveLength(2)
      await act(async () => {
        release()
      })
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(5), {
        timeout: 3000,
      })
      const [first, second] = files.snapshot().shots[0]?.prompt.timeline ?? []
      // 编号按传完的先后排：两张各占 4、5 中的一个，引用都落在各自段首的 chip 处。
      expect([first?.image_indexes[0], second?.image_indexes[0]].toSorted()).toEqual([4, 5])
      expect(first?.prompt).toMatch(/^@Image[45] {2}模特走出门厅/)
      expect(second?.prompt).toMatch(/^@Image[45]共用同一帧/)
    })

    it('图传好换成引用后撤销一次回到粘贴前：不留 chip、在途名额还回来；重做回到引用', async () => {
      const nearlyFull: ShotsDocument = {
        ...fullDocument,
        shots: fullDocument.shots.map((shot) =>
          shot.index === 1 ? { ...shot, image_urls: shot.image_urls.slice(0, 28) } : shot,
        ),
      }
      const before = nearlyFull.shots[0]?.prompt.timeline[0]?.prompt ?? ''
      const files = provide(nearlyFull)
      const release = delayedUpload()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const editor = editorOf(page, '镜头 1 的描述')
      const savedPrompt = () => files.snapshot().shots[0]?.prompt.timeline[0]?.prompt
      pasteImage(page, '镜头 1 的描述')
      await findChip(page, '镜头 1 的描述')
      // 撤销历史按 500ms 分组：传得比这慢，落图才和粘贴分在两步里，正是会复活 chip 的那种情形。
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 600)))
      await act(async () => {
        release()
      })
      await waitFor(() => expect(savedPrompt()).toBe(`@Image29${before}`), { timeout: 3000 })

      editor.focus()
      await userEvent.keyboard('{Control>}z{/Control}')
      // 引用撤掉了，原来那个文件名 chip 也不回来。
      expect(within(editor).queryByText('新帧.png')).not.toBeInTheDocument()
      await waitFor(() => expect(savedPrompt()).toBe(before), { timeout: 3000 })
      // 图在落图时已写进本组，撤销只撤正文。
      expect(files.snapshot().shots[0]?.image_urls).toHaveLength(29)

      await userEvent.keyboard('{Control>}y{/Control}')
      await waitFor(() => expect(savedPrompt()).toBe(`@Image29${before}`), { timeout: 3000 })

      // 撤销、重做都没留下在途的图：还差 1 张满时再粘贴一张照样收下。
      pasteImage(page, '镜头 1 的描述', new File(['c'], '丙.png', { type: 'image/png' }))
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(30), {
        timeout: 3000,
      })
      expect(within(segmentOf(page, '镜头 1')).queryByText(/每组最多使用 30 张参考图/)).toBeNull()
    })

    it('上传中撤销掉 chip、传好后再重做：chip 回来照常换成引用，图只追加一次', async () => {
      const files = provide(emptyDocument)
      const release = delayedUpload()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const editor = editorOf(page, '镜头 1 的描述')
      pasteImage(page, '镜头 1 的描述')
      await findChip(page, '镜头 1 的描述')

      editor.focus()
      await userEvent.keyboard('{Control>}z{/Control}')
      expect(within(editor).queryByText('新帧.png')).not.toBeInTheDocument()
      expect(editor).toHaveTextContent(/^无图镜头一。$/)
      await act(async () => {
        release()
      })
      // 撤掉的 chip 传好了也不落图：等过自动保存窗口，本组没有多出图片，也没有写入。
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(files.writes).toEqual([])

      await userEvent.keyboard('{Control>}y{/Control}')
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(1), {
        timeout: 3000,
      })
      expect(files.snapshot().shots[0]?.prompt.timeline[0]).toEqual({
        timestamps: [0, 3],
        prompt: '@Image1无图镜头一。',
        image_indexes: [1],
      })
      expect(within(editor).queryByText('新帧.png')).not.toBeInTheDocument()
      // 只落一次：再等一个保存窗口，本组仍是这一张。
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(files.snapshot().shots[0]?.image_urls).toHaveLength(1)
    })

    it('文件拖到段卡上：亮出「松开可添加到镜头 2」，落在正文以外的地方接到这段末尾', async () => {
      const files = provide()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const segment = segmentOf(page, '镜头 2')
      const heading = within(segment).getByRole('button', { name: '镜头 2' })
      fireEvent.dragEnter(heading, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(segment).getByText('松开可添加到镜头 2')).toBeVisible()
      fireEvent.drop(heading, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(segment).queryByText('松开可添加到镜头 2')).not.toBeInTheDocument()
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      expect(files.snapshot().shots[0]?.prompt.timeline[1]).toEqual({
        timestamps: [3.25, 5],
        prompt: `${document.shots[0]?.prompt.timeline[1]?.prompt ?? ''}@Image4`,
        image_indexes: [2, 1, 4],
      })
    })

    it('拖进来的是文件夹：段里就地提示，不上传', async () => {
      const files = provide()
      const counter = countSigns()
      await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const segment = segmentOf(page, '镜头 2')
      fireEvent.drop(segment, {
        dataTransfer: {
          files: [imageFile()],
          items: [{ kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true }) }],
          types: ['Files'],
        },
      })
      expect(await within(segment).findByText('无法添加文件夹')).toBeVisible()
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])
    })

    it('上传失败后点开 chip 重试，用同一个文件再传一次并加进这段', async () => {
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
      pasteImage(
        page,
        '镜头 1 的描述',
        new File(['webp bytes'], '新帧.webp', { type: 'image/webp' }),
      )
      await within(editorOf(page, '镜头 1 的描述')).findByRole('img', { name: '上传失败' })
      expect(files.writes).toEqual([])

      await retryChip(page, '镜头 1 的描述', '新帧.webp')
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      expect(signed).toEqual(['image/webp', 'image/webp'])
      expect(files.snapshot().shots[0]?.prompt.timeline[0]?.image_indexes).toEqual([4, 2, 1])
      expect(within(editorOf(page, '镜头 1 的描述')).queryByText('新帧.webp')).toBeNull()
    })
  })

  describe('选中成片：舞台播放，舞台工具条换成成片的操作', () => {
    const failedJob = makeGenerationJob({
      id: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
      createdAt: '2026-09-01T10:04:00Z',
      errorMessage: '上游返回了空结果，换个描述再试一次。',
      request: { prompt: '失败的这一版。', shot: historyShot },
      shotIndex: 1,
      status: 'failed',
    })
    const serveTakes = (items: GenerationJob[]) =>
      server.use(http.get('*/api/generations', () => HttpResponse.json({ items })))
    /** 按提交时刻认卡，返回卡本身。 */
    const cardOf = async (job: GenerationJob) => {
      const takes = await findTakes()
      const take = takes.find((item) => takeTimes([item])[0] === job.createdAt)
      if (take === undefined) throw new Error('成片区缺这条出片')
      return { card: takeCard(take), take }
    }
    const player = (page: HTMLElement) =>
      within(page).queryByRole('group', { name: '播放器：生成的视频' })

    it('点成片卡：舞台播放这条视频，舞台右上出现下载、编辑视频、回填；卡上没有别的按钮，文案列撤掉选中', async () => {
      provide()
      serveTakes([editableJob])
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const { card, take } = await cardOf(editableJob)
      expect(within(take).getAllByRole('button')).toEqual([card])
      expect(card).toHaveAttribute('aria-pressed', 'false')

      await userEvent.click(card)

      expect(card).toHaveAttribute('aria-pressed', 'true')
      expect(player(page)).toBeVisible()
      expect(within(page).getByLabelText('生成的视频', { selector: 'video' })).toHaveAttribute(
        'src',
        editableJob.outputUrl,
      )
      expect(within(page).queryByRole('group', { name: '当前帧图片' })).not.toBeInTheDocument()
      expect(within(page).getByRole('button', { name: '下载视频' })).not.toHaveAttribute(
        'aria-disabled',
      )
      for (const name of ['编辑视频', '回填提示词'])
        expect(within(page).getByRole('button', { name })).not.toHaveAttribute('aria-disabled')
      // 帧的操作跟着收起。
      for (const name of ['编辑图片', '替换图片', '上一帧', '下一帧'])
        expect(within(page).queryByRole('button', { name })).not.toBeInTheDocument()
      for (const segment of within(page).getAllByRole('group', { name: /^(全局设定|镜头 \d)$/ }))
        expect(segment).toHaveAttribute('aria-current', 'false')
      expect(within(take).getAllByRole('button')).toEqual([card])
    })

    it('下载：取这条成片的字节交给浏览器保存，并以它的记录 id 上报 video.downloaded', async () => {
      provide()
      serveTakes([editableJob])
      const events: unknown[] = []
      const fetched: string[] = []
      server.use(
        http.post('*/api/tracking/events', async ({ request }) => {
          events.push(await request.json())
          return new HttpResponse(null, { status: 204 })
        }),
        http.get(editableJob.outputUrl ?? '', ({ request }) => {
          fetched.push(request.url)
          return new HttpResponse(new Uint8Array([1, 2, 3]), {
            headers: { 'Content-Type': 'video/mp4' },
          })
        }),
      )
      vi.stubGlobal(
        'URL',
        class extends URL {
          static override createObjectURL = () => 'blob:http://localhost/video'
          static override revokeObjectURL() {}
        },
      )
      const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click((await cardOf(editableJob)).card)

      await userEvent.click(within(page).getByRole('button', { name: '下载视频' }))

      await waitFor(() =>
        expect(events).toEqual([{ jobId: editableJob.id, name: 'video.downloaded' }]),
      )
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
      expect(fetched).toEqual([editableJob.outputUrl])
    })

    it('编辑视频打开这条成片的视频编辑器', async () => {
      provide()
      serveTakes([editableJob])
      const { router } = await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click((await cardOf(editableJob)).card)

      await userEvent.click(within(page).getByRole('button', { name: '编辑视频' }))

      await waitFor(() =>
        expect(router.state.location.search).toMatchObject({ video: editableJob.id }),
      )
      const editor = await screen.findByRole('dialog', { name: /^编辑视频/ })
      expect(await within(editor).findByRole('group', { name: '播放控件' })).toBeVisible()
    })

    it('在途的成片：舞台是骨架加走表，工具条只有 ⓘ 与回填；失败的成片：舞台写出完整原因，下载与编辑置灰说原因', async () => {
      provide()
      serveTakes([runningJob, failedJob])
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })

      await userEvent.click((await cardOf(runningJob)).card)
      expect(within(page).getByRole('status', { name: /^生成中，已用 [\d:]+$/ })).toBeVisible()
      expect(player(page)).not.toBeInTheDocument()
      expect(within(page).queryByRole('button', { name: '下载视频' })).not.toBeInTheDocument()
      expect(within(page).queryByRole('button', { name: '编辑视频' })).not.toBeInTheDocument()
      // 这一条只记了正文，回填置灰。
      expect(within(page).getByRole('button', { name: '回填提示词' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )

      await userEvent.click((await cardOf(failedJob)).card)
      expect(within(page).getByRole('alert')).toHaveTextContent(
        '上游返回了空结果，换个描述再试一次。',
      )
      const download = within(page).getByRole('button', { name: '下载视频' })
      expect(download).toHaveAttribute('aria-disabled', 'true')
      act(() => download.focus())
      expect(await screen.findByRole('tooltip')).toHaveTextContent('生成失败，无法下载视频')
      expect(within(page).getByRole('button', { name: '编辑视频' })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
      // 记了镜头组的失败出片照样能回填。
      expect(within(page).getByRole('button', { name: '回填提示词' })).not.toHaveAttribute(
        'aria-disabled',
      )
    })

    it('点文案段（包括原来选中的那段）、点 @N、切组都回到帧；选中的成片从列表里消失也回到帧', async () => {
      provide()
      serveTakes([editableJob])
      const { queryClient } = await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const select = async () => {
        await userEvent.click((await cardOf(editableJob)).card)
        expect(player(page)).toBeVisible()
      }
      const frameShown = (frame: number) =>
        expect(within(page).getByRole('img', { name: `镜头组 1 第 ${frame} 帧` })).toBeVisible()

      // 地址里选的就是镜头 1：聚焦它的正文照样回到帧，并标回选中。
      await select()
      act(() => editorOf(page, '镜头 1 的描述').focus())
      await waitFor(() => expect(player(page)).not.toBeInTheDocument())
      frameShown(2)
      expect(segmentOf(page, '镜头 1')).toHaveAttribute('aria-current', 'true')

      await select()
      await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
      expect(player(page)).not.toBeInTheDocument()
      expect(segmentOf(page, '镜头 2')).toHaveAttribute('aria-current', 'true')

      await select()
      await userEvent.click(
        within(segmentOf(page, '镜头 1')).getByRole('button', { name: '看第 1 帧' }),
      )
      expect(player(page)).not.toBeInTheDocument()
      frameShown(1)

      await select()
      await openShot(2)
      const second = await screen.findByRole('region', { name: '镜头组 2' })
      expect(within(second).queryByRole('group', { name: '播放器：生成的视频' })).toBeNull()
      await openShot(1)
      const back = await screen.findByRole('region', { name: '镜头组 1' })
      expect(within(back).queryByRole('group', { name: '播放器：生成的视频' })).toBeNull()

      await userEvent.click((await cardOf(editableJob)).card)
      expect(within(back).getByRole('group', { name: '播放器：生成的视频' })).toBeVisible()
      serveTakes([])
      await act(async () => {
        await queryClient.invalidateQueries()
      })
      await waitFor(() =>
        expect(within(back).queryByRole('group', { name: '播放器：生成的视频' })).toBeNull(),
      )
      // 回到帧：舞台换回帧的那一套（这段不引用图，只剩帧计数）。
      expect(within(back).getByRole('button', { name: /查看本组全部图片/ })).toBeVisible()
    })

    it('显示视频时拖到舞台上不替换、不亮提示；回到帧后照常替换', async () => {
      const files = provide()
      serveTakes([editableJob])
      const counter = countSigns()
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click((await cardOf(editableJob)).card)
      const video = within(page).getByRole('group', { name: '播放器：生成的视频' })
      fireEvent.dragEnter(video, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).queryByText('松开可替换当前图片')).not.toBeInTheDocument()
      fireEvent.drop(video, { dataTransfer: fileTransfer([imageFile()]) })
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 900)))
      expect(counter.signs).toBe(0)
      expect(files.writes).toEqual([])

      await userEvent.click(within(page).getByRole('button', { name: '镜头 1' }))
      const frame = within(page).getByRole('group', { name: '当前帧图片' })
      fireEvent.dragEnter(frame, { dataTransfer: fileTransfer([imageFile()]) })
      expect(within(page).getByText('松开可替换当前图片')).toBeVisible()
    })

    it.each(['新增', '替换'])(
      '%s上传期间选中成片：上传完成照常写进草稿，舞台接着放视频',
      async (mode) => {
        const files = provide()
        serveTakes([editableJob])
        const release = delayedUpload()
        // 从镜头 1 的第二个引用（第 1 帧）发起，不是这段的首帧。
        await renderReader('/?shot=1&content=scene:1&frame=1')
        const page = await screen.findByRole('region', { name: '镜头组 1' })
        if (mode === '新增') {
          pasteImage(page, '镜头 1 的描述')
          await findChip(page, '镜头 1 的描述')
        } else {
          await userEvent.upload(within(page).getByLabelText('选择替换图片'), imageFile())
          await within(page).findByRole('status')
        }
        await userEvent.click((await cardOf(editableJob)).card)
        expect(player(page)).toBeVisible()

        await act(async () => {
          release()
        })

        await waitFor(() => expect(files.writes).toHaveLength(1), { timeout: 3000 })
        const saved = files.snapshot().shots[0]
        if (mode === '新增') {
          expect(saved?.image_urls).toHaveLength(4)
          expect(saved?.image_urls[3]).toContain('/mock-oss/')
          // chip 在段首（粘贴时没聚焦过）。
          expect(saved?.prompt.timeline[0]?.image_indexes).toEqual([4, 2, 1])
        } else {
          expect(saved?.image_urls).toHaveLength(3)
          expect(saved?.image_urls[0]).toContain('/mock-oss/')
          expect(saved?.prompt).toEqual(document.shots[0]?.prompt)
          expect(await screen.findByText('已替换第 1 帧')).toBeVisible()
        }
        expect(player(page)).toBeVisible()
        expect(within(page).queryByRole('group', { name: '当前帧图片' })).not.toBeInTheDocument()
      },
    )

    it('新增上传期间选中成片后上传失败：失败留在原段的 chip 上，舞台接着放视频，点开 chip 能重试', async () => {
      const files = provide()
      serveTakes([editableJob])
      const release = delayedUpload(503)
      await renderReader('/?shot=1&content=scene:1&frame=1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      pasteImage(page, '镜头 1 的描述')
      await findChip(page, '镜头 1 的描述')
      await userEvent.click((await cardOf(editableJob)).card)

      await act(async () => {
        release()
      })

      await within(editorOf(page, '镜头 1 的描述')).findByRole('img', { name: '上传失败' })
      expect(player(page)).toBeVisible()
      expect(files.writes).toEqual([])

      server.use(http.put('*/mock-oss/:uploadId', () => new HttpResponse(null, { status: 200 })))
      await retryChip(page, '镜头 1 的描述')
      await waitFor(() => expect(files.snapshot().shots[0]?.image_urls).toHaveLength(4), {
        timeout: 3000,
      })
      expect(files.snapshot().shots[0]?.prompt.timeline[0]?.image_indexes).toEqual([4, 2, 1])
    })

    it('成片的操作是舞台右上的图标按钮，按 Tab 移过去就提示名字；ⓘ 的可访问名与提示里都有分辨率 · 时长 · 时间与模型', async () => {
      const specified = makeGenerationJob({
        id: 'f1c2d3e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        createdAt: '2026-09-01T10:04:00Z',
        durationMs: 6000,
        outputUrl: 'https://example.com/specified.mp4',
        request: { model: 'vendor-a-seedance-2-5', prompt: '带规格的一条。', resolution: '720p' },
        shotIndex: 1,
      })
      provide()
      serveTakes([specified])
      await renderReader()
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      await userEvent.click((await cardOf(specified)).card)

      const download = within(page).getByRole('button', { name: '下载视频' })
      expect(download.textContent).toBe('')
      const info = within(page).getByRole('button', { name: /^成片信息：/ })
      // 图标按钮在按 Tab 移过去时提示名字：从 ⓘ 往后移一格。
      act(() => info.focus())
      await userEvent.tab()
      expect(download).toHaveFocus()
      await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('下载视频'))
      act(() => download.blur())
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())

      expect(info).toHaveAccessibleName(/^成片信息：720p · 0:06 · .+，vendor-a-seedance-2-5$/)
      act(() => info.focus())
      await waitFor(() => {
        const tooltip = screen.getByRole('tooltip')
        expect(tooltip).toHaveTextContent(/720p · 0:06 · /)
        expect(tooltip).toHaveTextContent('vendor-a-seedance-2-5')
      })

      // 触屏没有悬停：点按也打开。
      act(() => info.blur())
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
      await userEvent.click(info)
      expect(await screen.findByRole('tooltip')).toHaveTextContent(/720p · 0:06 · /)
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

  describe('文案列的镜头条、时间轴与摘要', () => {
    it('列头写镜头数与总长；点镜头条的一段选中那一镜并滚到它，只读也一样', async () => {
      provide()
      const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
      const { router } = await renderReader('/?shot=1&content=scene:1', true)
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const script = within(page).getByRole('region', { name: '分镜文案' })
      expect(script).toHaveTextContent('3 个镜头 · 共 6.0s')
      const bar = within(script).getByRole('group', { name: '镜头时间条' })
      // 可访问名：镜头、取整后的时长、一位小数的完整区间。
      expect(
        within(bar)
          .getAllByRole('button')
          .map((segment) => segment.getAttribute('aria-label')),
      ).toEqual([
        '镜头 1，2.5s，0.0s – 2.5s',
        '镜头 2，1.8s，3.3s – 5.0s',
        '镜头 3，1.0s，5.0s – 6.0s',
      ])

      await userEvent.click(within(bar).getByRole('button', { name: '镜头 3，1.0s，5.0s – 6.0s' }))
      await waitFor(() =>
        expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:3' }),
      )
      const third = segmentOf(page, '镜头 3')
      expect(third).toHaveAttribute('aria-current', 'true')
      expect(within(bar).getByRole('button', { name: /^镜头 3，/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
      expect(scroll.mock.contexts).toContain(third.closest('li'))
      expect(within(page).getByRole('textbox', { name: '镜头 3 的描述' })).toHaveAttribute(
        'contenteditable',
        'false',
      )
    })

    it('默认全文；收成摘要后未选中的段收起，全局设定可单独展开，选区不变', async () => {
      provide()
      const { router } = await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const names = ['全局设定', '镜头 1', '镜头 2', '镜头 3']
      const clamped = () =>
        names.map((name) => segmentOf(page, name).getAttribute('data-clamped') === 'true')
      expect(clamped()).toEqual([false, false, false, false])
      expect(within(page).queryByRole('button', { name: '展开' })).toBeNull()

      await userEvent.click(within(page).getByRole('button', { name: '收成摘要' }))
      expect(clamped()).toEqual([true, false, true, true])
      const expand = within(segmentOf(page, '全局设定')).getByRole('button', { name: '展开' })
      expect(expand).toHaveAttribute('aria-expanded', 'false')

      // 展开全局设定只改它自己的显示，不把选区挪到全局设定。
      await userEvent.click(expand)
      expect(within(page).getByRole('button', { name: '收起' })).toHaveAttribute(
        'aria-expanded',
        'true',
      )
      expect(clamped()).toEqual([false, false, true, true])
      expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:1' })

      // 选中的镜头总是全文。
      await userEvent.click(within(page).getByRole('button', { name: '镜头 2' }))
      await waitFor(() => expect(segmentOf(page, '镜头 2')).toHaveAttribute('aria-current', 'true'))
      expect(clamped()).toEqual([false, true, false, true])

      await userEvent.click(within(page).getByRole('button', { name: '显示全文' }))
      expect(clamped()).toEqual([false, false, false, false])
      expect(within(page).queryByRole('button', { name: /^(展开|收起)$/ })).toBeNull()
    })

    it('标题行的引用帧缩略图按正文顺序排，点一张选中这一镜和这一帧', async () => {
      provide()
      const { router } = await renderReader('/?shot=1&content=scene:1')
      const page = await screen.findByRole('region', { name: '镜头组 1' })
      const second = segmentOf(page, '镜头 2')
      expect(
        within(second)
          .getAllByRole('button', { name: /^在舞台查看 @\d+$/ })
          .map((thumb) => thumb.getAttribute('aria-label')),
      ).toEqual(['在舞台查看 @2', '在舞台查看 @1'])

      await userEvent.click(within(second).getByRole('button', { name: '在舞台查看 @1' }))
      await waitFor(() =>
        expect(router.state.location.search).toEqual({ shot: 1, content: 'scene:2', frame: 1 }),
      )
      expect(second).toHaveAttribute('aria-current', 'true')
      expect(within(page).getByRole('img', { name: '镜头组 1 第 1 帧' })).toBeVisible()
      // 没有引用帧的镜头不排缩略图。
      expect(
        within(segmentOf(page, '镜头 3')).queryByRole('button', { name: /^在舞台查看/ }),
      ).toBeNull()
    })
  })
})

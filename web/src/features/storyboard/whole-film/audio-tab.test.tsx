import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { pasteTextIntoComposer } from '@/testing/editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockConversation } from '@/testing/mocks/conversations'
import { seedMockFilm } from '@/testing/mocks/film'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { audio } from '@/testing/whole-film'
import { DRAG_THRESHOLD } from '../editing/timeline-drag'
import type { GenerationJob } from '../storyboard.api'
import { AudioTab, GenerateMusic } from './audio-tab'
import type { FilmBlock } from './composition/film'

const durations = vi.hoisted(() => new Map<string, number>())

// 上传的音频记录上没有时长，从文件里读：这里的文件只有时长、没有声音
vi.mock('mediabunny', async () => {
  const { createMediaReaderMock } = await import('@/testing/media-reader')
  class AudioSampleSink {
    samples = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    })
  }
  const files = new Map(
    [...durations].map(([url, duration]) => [url, { keyframes: [], duration }] as const),
  )
  return {
    ...createMediaReaderMock(files, (url) =>
      Promise.resolve(
        durations.has(url)
          ? { canDecode: () => Promise.resolve(true), getNumberOfChannels: () => 1 }
          : null,
      ),
    ),
    AudioSampleSink,
  }
})

const GUITAR_URL = 'https://media.test/audio/guitar.m4a'
const NIGHT_URL = 'https://media.test/audio/night.m4a'
const UPLOAD_URL = 'https://media.test/audio/upload.mp3'
durations.set(UPLOAD_URL, 12.4)

const musicJob = (overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({ kind: 'audio', request: { prompt: '轻快电子节奏' }, ...overrides })

const guitar = musicJob({
  id: '11111111-1111-4111-8111-111111111111',
  request: { prompt: '轻快原声吉他' },
  outputUrl: GUITAR_URL,
  durationMs: 30_000,
})
const night = musicJob({
  id: '22222222-2222-4222-8222-222222222222',
  request: { prompt: '城市夜景氛围' },
  outputUrl: NIGHT_URL,
  durationMs: 168_000,
})

const openTab = async (records: GenerationJob[], blocks: FilmBlock[] = []) => {
  const conversation = addMockConversation('音频页签')
  server.use(http.get('*/api/generations', () => HttpResponse.json({ items: records })))
  const props = {
    onAdd: vi.fn(),
    onCarry: vi.fn(),
    onDrop: vi.fn(),
    onReveal: vi.fn(),
    onNotice: vi.fn(),
  }
  await renderWithProviders(
    <AudioTab blocks={blocks} conversationId={conversation.id} {...props} />,
  )
  if (records.length > 0) await screen.findByRole('list', { name: '音频' })
  return { ...props, conversation }
}

const list = () => screen.getByRole('list', { name: '音频' })
const rowOf = (title: string) =>
  within(list())
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(title) !== null) ??
  (() => {
    throw new Error(`列表里没有「${title}」`)
  })()
const rowButton = (title: string | RegExp) => within(list()).getByRole('button', { name: title })

describe('音频栏 · 列表', () => {
  it('列出生成的和上传的音频：试听键、名字、时长；按名字搜，没有结果时说明一句', async () => {
    const user = userEvent.setup()
    await openTab([guitar, night])
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2)
    expect(within(rowOf('轻快原声吉他')).getByText('00:30')).toBeInTheDocument()
    expect(within(rowOf('城市夜景氛围')).getByText('02:48')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '试听：轻快原声吉他' })).toBeInTheDocument()
    expect(screen.queryByText(/已使用/)).toBeNull()

    const search = screen.getByRole('searchbox', { name: '搜索音频' })
    expect(search).toHaveAttribute('placeholder', '搜索音频')
    await user.type(search, '夜景')
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list()).getByText('城市夜景氛围')).toBeInTheDocument()
    await user.type(search, '钢琴')
    expect(screen.queryByRole('list', { name: '音频' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('暂无符合条件的音频，请换个关键词')
  })

  it('这段对话还没有音频：说明怎么加', async () => {
    await openTab([])
    expect(await screen.findByRole('status')).toHaveTextContent(
      '暂无音频，请点「生成音乐」或「导入音频」',
    )
  })

  it.each([
    ['pending', '排队中', '音乐还没生成完，无法加入成片'],
    ['submitting', '生成中', '音乐还没生成完，无法加入成片'],
    ['submitted', '生成中', '音乐还没生成完，无法加入成片'],
    ['failed', '生成失败', '音乐生成失败，无法加入成片；请重新生成'],
  ] as const)('%s 显示「%s」，不能试听，按 Enter、右键都加不进成片', async (status, label, why) => {
    const user = userEvent.setup()
    const { onAdd, onNotice } = await openTab([musicJob({ status })])
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '试听：轻快电子节奏' })).toBeNull()

    act(() => rowButton('轻快电子节奏').focus())
    await user.keyboard('{Enter}')
    fireEvent.contextMenu(rowButton('轻快电子节奏'))
    await user.click(await screen.findByRole('menuitem', { name: '加到播放头' }))
    expect(onNotice.mock.calls).toEqual([[why], [why]])
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('上传的音频记录上没有时长：从文件里读出来显示，加进成片也按它', async () => {
    const user = userEvent.setup()
    const uploaded = makeGenerationJob({
      kind: 'audio',
      operation: 'upload',
      outputUrl: UPLOAD_URL,
      request: {},
    })
    const { onAdd } = await openTab([uploaded])
    const [title] = within(list()).getAllByText(/^上传的音乐 · /)
    expect(await within(list()).findByText('00:12')).toBeInTheDocument()
    act(() => rowButton(title?.textContent ?? '').focus())
    await user.keyboard('{Enter}')
    expect(onAdd).toHaveBeenCalledWith({
      label: title?.textContent,
      jobId: uploaded.id,
      src: UPLOAD_URL,
      mediaStart: 0,
      duration: 12_400,
    })
  })
})

describe('音频栏 · 试听', () => {
  it('点试听键播放，再点暂停；点另一条时前一条停下，同一时间只播一条', async () => {
    const user = userEvent.setup()
    const played: string[] = []
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      played.push(this.getAttribute('src') ?? '')
      return Promise.resolve()
    })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { onAdd, onReveal } = await openTab([guitar, night])

    await user.click(screen.getByRole('button', { name: '试听：轻快原声吉他' }))
    expect(played).toEqual([GUITAR_URL])
    expect(screen.getByRole('button', { name: '暂停试听：轻快原声吉他' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '试听：城市夜景氛围' }))
    expect(played).toEqual([GUITAR_URL, NIGHT_URL])
    expect(screen.getAllByRole('button', { name: /^暂停试听：/ })).toEqual([
      screen.getByRole('button', { name: '暂停试听：城市夜景氛围' }),
    ])

    await user.click(screen.getByRole('button', { name: '暂停试听：城市夜景氛围' }))
    expect(pause).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByRole('button', { name: /^暂停试听：/ })).toEqual([])
    expect(onAdd).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
  })
})

describe('音频栏 · 已使用', () => {
  it('成片里用着的那条标「已使用」，点这一行选中它最早的那个块；没用到的点了什么也不做', async () => {
    const user = userEvent.setup()
    const blocks = [
      audio({ id: 'late', jobId: guitar.id, start: 8000 }),
      audio({ id: 'early', jobId: guitar.id, start: 1000, track: 1 }),
    ]
    const { onReveal, onAdd } = await openTab([guitar, night], blocks)
    expect(within(rowOf('轻快原声吉他')).getByText('00:30 · 已使用')).toBeInTheDocument()
    expect(within(rowOf('城市夜景氛围')).queryByText(/已使用/)).toBeNull()

    await user.click(rowButton('城市夜景氛围'))
    expect(onReveal).not.toHaveBeenCalled()
    await user.click(rowButton('轻快原声吉他，已使用'))
    expect(onReveal).toHaveBeenCalledExactlyOnceWith('early')
    expect(onAdd).not.toHaveBeenCalled()
  })
})

describe('音频栏 · 加进成片', () => {
  const whole = {
    label: '轻快原声吉他',
    jobId: guitar.id,
    src: GUITAR_URL,
    mediaStart: 0,
    duration: 30_000,
  }

  it('右键只有「加到播放头」，选它加入整条音频', async () => {
    const user = userEvent.setup()
    const { onAdd } = await openTab([guitar])
    fireEvent.contextMenu(rowButton('轻快原声吉他'))
    const menu = await screen.findByRole('menu', { name: '轻快原声吉他' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['加到播放头'])
    await user.click(within(menu).getByRole('menuitem', { name: '加到播放头' }))
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(whole)
  })

  it('焦点在一行上按 Enter 也是加到播放头', async () => {
    const user = userEvent.setup()
    const { onAdd, onReveal } = await openTab([guitar])
    const row = rowButton('轻快原声吉他')
    expect(row).toHaveAttribute('aria-keyshortcuts', 'Enter')
    act(() => row.focus())
    await user.keyboard('{Enter}')
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(whole)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('按住一行拖出去：移动时报告指针位置，松手时交给时间线；松手后不算点了这一行', async () => {
    const { onCarry, onDrop, onReveal } = await openTab([guitar], [audio({ jobId: guitar.id })])
    const row = rowButton('轻快原声吉他，已使用')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 10 + DRAG_THRESHOLD, clientY: 10 })
    expect(onCarry).not.toHaveBeenCalled()
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 200, clientY: 400 })
    expect(onCarry).toHaveBeenLastCalledWith(whole, { clientX: 200, clientY: 400 })
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 210, clientY: 420 })
    fireEvent.click(row)
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(whole, { clientX: 210, clientY: 420 })
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('拖到一半按 Esc：这次拖动取消，松手不落进成片', async () => {
    const user = userEvent.setup()
    const { onCarry, onDrop } = await openTab([guitar])
    const row = rowButton('轻快原声吉他')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 200, clientY: 400 })
    await user.keyboard('{Escape}')
    expect(onCarry).toHaveBeenLastCalledWith(whole, null)
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 210, clientY: 420 })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('还没生成完的拖不出去', async () => {
    const { onCarry, onDrop } = await openTab([musicJob({ status: 'submitted' })])
    const row = rowButton('轻快电子节奏')
    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 200, clientY: 400 })
    fireEvent.pointerUp(row, { pointerId: 1, clientX: 210, clientY: 420 })
    expect(onCarry).not.toHaveBeenCalled()
    expect(onDrop).not.toHaveBeenCalled()
  })
})

describe('音频栏 · 导入', () => {
  const confirmsInto = (records: GenerationJob[]) => {
    const confirms: unknown[] = []
    server.use(
      http.post('*/api/uploads/:uploadId/confirm', async ({ params, request }) => {
        confirms.push(await request.clone().json())
        records.push(
          makeGenerationJob({
            id: String(params['uploadId']),
            kind: 'audio',
            operation: 'upload',
            outputUrl: UPLOAD_URL,
            request: {},
          }),
        )
        return undefined
      }),
    )
    return confirms
  }
  const wav = () => new File(['wav'], '配乐.wav', { type: 'audio/wav' })

  it('点「导入音频」选文件：传到这段对话下，列表里多一条', async () => {
    const user = userEvent.setup()
    const records = [guitar]
    const confirms = confirmsInto(records)
    const { conversation } = await openTab(records)
    expect(screen.getByLabelText('选择音频文件')).toHaveAttribute(
      'accept',
      expect.stringContaining('audio/mpeg'),
    )
    await user.upload(screen.getByLabelText('选择音频文件'), wav())
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(2))
    expect(confirms).toEqual([{ conversationId: conversation.id }])
    expect(screen.getByRole('button', { name: '导入音频' })).toBeEnabled()
  })

  it('文件拖到音频栏上也导入', async () => {
    const records = [guitar]
    const confirms = confirmsInto(records)
    const { conversation } = await openTab(records)
    fireEvent.drop(list(), {
      dataTransfer: {
        types: ['Files'],
        files: [wav()],
        items: [{ kind: 'file', type: 'audio/wav' }],
      },
    })
    await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(2))
    expect(confirms).toEqual([{ conversationId: conversation.id }])
  })
})

const recordMusicBodies = () => {
  const bodies: unknown[] = []
  server.use(
    http.post('*/api/generations/music', async ({ request }) => {
      bodies.push(await request.clone().json())
      return undefined
    }),
  )
  return bodies
}

describe('音频栏 · 生成音乐', () => {
  it('点「生成音乐」填描述提交到这段对话，收起后新的一条出现在列表里', async () => {
    const user = userEvent.setup()
    const records: GenerationJob[] = []
    const bodies = recordMusicBodies()
    const conversation = addMockConversation('音频页签')
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: records })),
      http.post('*/api/generations/music', () => {
        records.unshift(musicJob({ status: 'submitted', request: { prompt: '轻快的原声吉他' } }))
        return undefined
      }),
    )
    await renderWithProviders(
      <AudioTab
        blocks={[]}
        conversationId={conversation.id}
        onAdd={vi.fn()}
        onCarry={vi.fn()}
        onDrop={vi.fn()}
        onNotice={vi.fn()}
        onReveal={vi.fn()}
      />,
    )
    await screen.findByRole('status')
    await user.click(screen.getByRole('button', { name: '生成音乐' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })
    expect(popover).toHaveAccessibleDescription(
      '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐',
    )
    const submit = within(popover).getByRole('button', { name: '生成音乐' })
    expect(submit).toBeDisabled()
    pasteTextIntoComposer(
      within(popover).getByRole('textbox', { name: '音乐描述' }),
      '轻快的原声吉他',
    )
    await waitFor(() => expect(submit).toBeEnabled())
    expect(popover).toHaveAccessibleDescription('生成后出现在「音频」页签的列表里')
    await user.click(submit)

    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(bodies).toEqual([
      { conversationId: conversation.id, prompt: '轻快的原声吉他', taskId: null },
    ])
    expect(await screen.findByRole('img', { name: '生成中' })).toBeInTheDocument()
    expect(within(list()).getByText('轻快的原声吉他')).toBeInTheDocument()
  })

  it('失败的那条说明原因；重新生成沿用原描述', async () => {
    const user = userEvent.setup()
    const bodies = recordMusicBodies()
    const { conversation, onAdd } = await openTab([
      musicJob({ status: 'failed', errorMessage: '音频生成服务暂不可用' }),
    ])
    await user.click(screen.getByRole('button', { name: '查看失败原因：轻快电子节奏' }))
    const details = await screen.findByRole('dialog', { name: '失败原因：轻快电子节奏' })
    expect(within(details).getByText('音频生成服务暂不可用')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '重新生成：轻快电子节奏' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })
    expect(within(popover).getByRole('textbox', { name: '音乐描述' })).toHaveTextContent(
      '轻快电子节奏',
    )
    const submit = within(popover).getByRole('button', { name: '生成音乐' })
    await waitFor(() => expect(submit).toBeEnabled())
    expect(popover).toHaveAccessibleDescription('已填入上次的描述，可直接修改')
    await user.click(submit)
    await waitFor(() =>
      expect(bodies).toEqual([
        { conversationId: conversation.id, prompt: '轻快电子节奏', taskId: null },
      ]),
    )
    expect(onAdd).not.toHaveBeenCalled()
  })
})

const openGenerate = async (conversationId: string) => {
  const user = userEvent.setup()
  await renderWithProviders(
    <GenerateMusic conversationId={conversationId} onNotice={vi.fn()}>
      <button type="button">打开</button>
    </GenerateMusic>,
  )
  await user.click(screen.getByRole('button', { name: '打开' }))
  const popover = await screen.findByRole('dialog', { name: '生成音乐' })
  return {
    user,
    popover,
    editor: within(popover).getByRole('textbox', { name: '音乐描述' }),
    submit: within(popover).getByRole('button', { name: '生成音乐' }),
  }
}

describe('生成音乐的输入框', () => {
  it('在描述里按回车直接生成', async () => {
    const conversation = addMockConversation('成片配乐')
    const bodies = recordMusicBodies()
    const { user, popover, editor, submit } = await openGenerate(conversation.id)

    pasteTextIntoComposer(editor, '轻快的原声吉他')
    await waitFor(() => expect(submit).toBeEnabled())
    act(() => editor.focus())
    await user.keyboard('{Enter}')

    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(bodies).toEqual([
      { conversationId: conversation.id, prompt: '轻快的原声吉他', taskId: null },
    ])
  })

  it('工程文件写了配乐时预填它，原样提交', async () => {
    const conversation = addMockConversation('成片配乐')
    seedMockFilm(conversation.id, { musicDescription: '纯音乐，极简氛围钢琴小品' })
    const bodies = recordMusicBodies()
    const { user, popover, editor, submit } = await openGenerate(conversation.id)

    await waitFor(() => expect(editor).toHaveTextContent('纯音乐，极简氛围钢琴小品'))
    await waitFor(() => expect(submit).toBeEnabled())
    expect(popover).toHaveAccessibleDescription('已填入工程文件里的配乐描述，可直接修改')
    await user.click(submit)

    await waitFor(() =>
      expect(bodies).toEqual([
        { conversationId: conversation.id, prompt: '纯音乐，极简氛围钢琴小品', taskId: null },
      ]),
    )
  })

  it('描述超过 3000 字时不可提交，也不截断已输入的内容', async () => {
    const conversation = addMockConversation('成片配乐')
    const bodies = recordMusicBodies()
    const { user, popover, editor, submit } = await openGenerate(conversation.id)

    pasteTextIntoComposer(editor, '钢'.repeat(3001))
    await waitFor(() =>
      expect(popover).toHaveAccessibleDescription(
        '描述超过 3000 字，无法生成；请删减到 3000 字以内',
      ),
    )
    expect(submit).toBeDisabled()
    expect(editor.textContent).toHaveLength(3001)
    act(() => editor.focus())
    await user.keyboard('{Enter}')
    expect(popover).toBeInTheDocument()
    expect(bodies).toEqual([])
  })

  it('关闭后再打开，已输入的文字还在', async () => {
    const conversation = addMockConversation('成片配乐')
    const { user, popover, editor } = await openGenerate(conversation.id)

    pasteTextIntoComposer(editor, '轻快的原声吉他')
    await waitFor(() => expect(editor).toHaveTextContent('轻快的原声吉他'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(popover).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '打开' }))
    const reopened = await screen.findByRole('dialog', { name: '生成音乐' })
    expect(within(reopened).getByRole('textbox', { name: '音乐描述' })).toHaveTextContent(
      '轻快的原声吉他',
    )
  })

  const openInDialog = async (conversationId: string) => {
    const user = userEvent.setup()
    await renderWithProviders(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined} aria-label="成片编辑器">
          <div>
            <GenerateMusic conversationId={conversationId} onNotice={vi.fn()}>
              <button type="button">打开</button>
            </GenerateMusic>
          </div>
        </DialogSurface>
      </DialogRoot>,
    )
    await user.click(screen.getByRole('button', { name: '打开' }))
    return screen.findByRole('dialog', { name: '生成音乐' })
  }

  it('挂在成片弹窗里、焦点落在 body 时工程文件配乐才到，预填后浮层仍开着', async () => {
    const conversation = addMockConversation('成片配乐')
    seedMockFilm(conversation.id, { musicDescription: '纯音乐，极简氛围钢琴小品' })
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('*/api/conversations/:conversationId/film', async () => {
        await released
        return undefined
      }),
    )
    const popover = await openInDialog(conversation.id)

    act(() => (document.activeElement as HTMLElement).blur())
    release()
    await waitFor(() =>
      expect(within(popover).getByRole('textbox', { name: '音乐描述' })).toHaveTextContent(
        '纯音乐，极简氛围钢琴小品',
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(popover).toBeInTheDocument()
    expect(popover).toHaveAccessibleDescription('已填入工程文件里的配乐描述，可直接修改')
  })

  it('挂在成片弹窗里、焦点落在 body 时点提交，浮层一直开到提交完成', async () => {
    const conversation = addMockConversation('成片配乐')
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/generations/music', async () => {
        await released
        return undefined
      }),
    )
    const popover = await openInDialog(conversation.id)
    pasteTextIntoComposer(
      within(popover).getByRole('textbox', { name: '音乐描述' }),
      '轻快的原声吉他',
    )
    const submit = within(popover).getByRole('button', { name: '生成音乐' })
    await waitFor(() => expect(submit).toBeEnabled())

    act(() => (document.activeElement as HTMLElement).blur())
    fireEvent.click(submit)
    expect(await within(popover).findByRole('button', { name: '正在提交' })).toBeDisabled()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(popover).toBeInTheDocument()

    release()
    await waitFor(() => expect(popover).not.toBeInTheDocument())
  })
})

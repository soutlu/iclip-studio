import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { pasteTextIntoComposer } from '@/testing/editor'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockConversation } from '@/testing/mocks/conversations'
import { seedMockFilm } from '@/testing/mocks/film'
import { server } from '@/testing/mocks/server'
import { DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { renderWithProviders } from '@/testing/render'
import { contextOf, draftOf } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { GenerateMusic, MusicPanel } from './music-panel'

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

describe('生成音乐浮层', () => {
  it('点触发按钮弹出；填好描述点「生成音乐」提交到这段对话，提交后收起', async () => {
    const conversation = addMockConversation('成片配乐')
    const bodies = recordMusicBodies()
    const { user, popover, editor, submit } = await openGenerate(conversation.id)

    pasteTextIntoComposer(editor, '轻快的原声吉他')
    await waitFor(() => expect(submit).toBeEnabled())
    expect(popover).toHaveAccessibleDescription('生成后出现在左侧「音乐」列表')
    await user.click(submit)

    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(bodies).toEqual([
      { conversationId: conversation.id, prompt: '轻快的原声吉他', taskId: null },
    ])
  })

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

  it('没写描述时按钮不可用，灰字写原因', async () => {
    const conversation = addMockConversation('成片配乐')
    const { popover, submit } = await openGenerate(conversation.id)

    await waitFor(() =>
      expect(popover).toHaveAccessibleDescription(
        '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐',
      ),
    )
    expect(submit).toBeDisabled()
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

  it('浮层挂在触发按钮的父元素里，不落到 body 上', async () => {
    const user = userEvent.setup()
    const conversation = addMockConversation('成片配乐')
    await renderWithProviders(
      <div data-testid="宿主">
        <GenerateMusic conversationId={conversation.id} onNotice={vi.fn()}>
          <button type="button">打开</button>
        </GenerateMusic>
      </div>,
    )

    await user.click(screen.getByRole('button', { name: '打开' }))
    expect(
      await within(screen.getByTestId('宿主')).findByRole('dialog', { name: '生成音乐' }),
    ).toBeVisible()
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
    const user = userEvent.setup()
    await renderWithProviders(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined} aria-label="成片编辑器">
          <div>
            <GenerateMusic conversationId={conversation.id} onNotice={vi.fn()}>
              <button type="button">打开</button>
            </GenerateMusic>
          </div>
        </DialogSurface>
      </DialogRoot>,
    )
    await user.click(screen.getByRole('button', { name: '打开' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })

    // 预填把占位文字换掉会移除节点；焦点此时在 body
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
    const user = userEvent.setup()
    await renderWithProviders(
      <DialogRoot open>
        <DialogSurface aria-describedby={undefined} aria-label="成片编辑器">
          <div>
            <GenerateMusic conversationId={conversation.id} onNotice={vi.fn()}>
              <button type="button">打开</button>
            </GenerateMusic>
          </div>
        </DialogSurface>
      </DialogRoot>,
    )
    await user.click(screen.getByRole('button', { name: '打开' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })
    pasteTextIntoComposer(
      within(popover).getByRole('textbox', { name: '音乐描述' }),
      '轻快的原声吉他',
    )
    const submit = within(popover).getByRole('button', { name: '生成音乐' })
    await waitFor(() => expect(submit).toBeEnabled())

    // Safari 与 Firefox-mac 点按钮不聚焦：焦点留在 body，提交钮换成转圈会移除图标节点
    act(() => (document.activeElement as HTMLElement).blur())
    fireEvent.click(submit)
    expect(await within(popover).findByRole('button', { name: '正在提交' })).toBeDisabled()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(popover).toBeInTheDocument()

    release()
    await waitFor(() => expect(popover).not.toBeInTheDocument())
  })
})

const openMusic = async (records: GenerationJob[]) => {
  const conversation = addMockConversation('音乐状态')
  server.use(http.get('*/api/generations', () => HttpResponse.json({ items: records })))
  const apply = vi.fn(() => true)
  const onNotice = vi.fn()
  await renderWithProviders(
    <MusicPanel
      apply={apply}
      context={contextOf(
        {},
        Object.fromEntries(records.map((job) => [job.id, { durationMs: 30_000 }])),
      )}
      conversationId={conversation.id}
      draft={draftOf([])}
      onNotice={onNotice}
    />,
  )
  await screen.findByRole('list', { name: '这段对话的音乐' })
  return { apply, conversation, onNotice }
}

const musicJob = (overrides: Partial<GenerationJob> = {}) =>
  makeGenerationJob({
    kind: 'audio',
    request: { prompt: '轻快电子节奏' },
    ...overrides,
  })

describe('音乐素材', () => {
  it.each([
    ['pending', '排队中'],
    ['submitting', '生成中'],
    ['submitted', '生成中'],
    ['failed', '生成失败'],
  ] as const)('%s 显示对应状态，完成前不能试听或选用', async (status, label) => {
    const user = userEvent.setup()
    const { apply } = await openMusic([musicJob({ status })])
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '试听：轻快电子节奏' })).not.toBeInTheDocument()
    const select = screen.getByRole('button', { name: '选用：轻快电子节奏' })
    expect(select).toHaveAttribute('aria-disabled', 'true')
    await user.click(select)
    expect(apply).not.toHaveBeenCalled()
  })

  it('试听只播放音频，选用条目才替换配乐并停止试听', async () => {
    const user = userEvent.setup()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const job = musicJob({ outputUrl: 'https://example.com/music.wav', durationMs: 30_000 })
    const { apply } = await openMusic([job])

    await user.click(screen.getByRole('button', { name: '试听：轻快电子节奏' }))
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '暂停试听：轻快电子节奏' })).toBeInTheDocument()
    expect(apply).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '选用：轻快电子节奏' }))
    expect(apply).toHaveBeenCalledWith({
      ok: true,
      draft: draftOf([], { music: { jobId: job.id, offset: 0, volume: 1 } }),
    })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '试听：轻快电子节奏' })).toBeInTheDocument()
  })

  it('失败详情说明原因，重新生成沿用原描述且不选用失败记录', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        bodies.push(await request.clone().json())
        return undefined
      }),
    )
    const { apply, conversation } = await openMusic([
      musicJob({ status: 'failed', errorMessage: '音频生成服务暂不可用' }),
    ])
    await user.click(screen.getByRole('button', { name: '查看音乐详情：轻快电子节奏' }))
    const details = await screen.findByRole('dialog', { name: '音乐详情：轻快电子节奏' })
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
    expect(apply).not.toHaveBeenCalled()
  })

  it.each(['面板空白', '音乐列表'] as const)('文件拖到%s 均上传并刷新音乐列表', async (target) => {
    const records = [musicJob({ status: 'pending' })]
    const confirms: unknown[] = []
    server.use(
      http.post('*/api/uploads/:uploadId/confirm', async ({ params, request }) => {
        confirms.push(await request.clone().json())
        records.push(
          musicJob({
            id: String(params['uploadId']),
            operation: 'upload',
            outputUrl: 'https://example.com/upload.wav',
            request: {},
          }),
        )
        return undefined
      }),
    )
    const { conversation } = await openMusic(records)
    const dropTarget =
      target === '面板空白'
        ? screen.getByRole('region', { name: '音乐素材' })
        : screen.getByRole('list', { name: '这段对话的音乐' })
    fireEvent.drop(dropTarget, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['wav'], '配乐.wav', { type: 'audio/wav' })],
        items: [{ kind: 'file', type: 'audio/wav' }],
      },
    })
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))
    expect(confirms).toEqual([{ conversationId: conversation.id }])
    expect(screen.getByRole('button', { name: '添加音频' })).toBeEnabled()
  })
})

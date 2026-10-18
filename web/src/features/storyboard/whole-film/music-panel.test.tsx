import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockConversation } from '@/testing/mocks/conversations'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { contextOf, draftOf } from '@/testing/whole-film'
import type { GenerationJob } from '../storyboard.api'
import { GenerateMusic, MusicPanel } from './music-panel'

describe('生成音乐浮层', () => {
  it('点触发按钮向上弹出；填好描述提交到这段对话，提交后收起', async () => {
    const user = userEvent.setup()
    const conversation = addMockConversation('整片配乐')
    const bodies: unknown[] = []
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        bodies.push(await request.clone().json())
        return undefined
      }),
    )
    await renderWithProviders(
      <GenerateMusic conversationId={conversation.id} onNotice={vi.fn()}>
        <button type="button">打开</button>
      </GenerateMusic>,
    )

    await user.click(screen.getByRole('button', { name: '打开' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })
    await user.type(screen.getByLabelText('音乐描述'), '轻快的原声吉他')
    const submit = screen.getByRole('button', { name: '生成' })
    await waitFor(() => expect(submit).not.toHaveAttribute('aria-disabled'))
    await user.click(submit)

    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(bodies).toEqual([
      { conversationId: conversation.id, prompt: '轻快的原声吉他', taskId: null },
    ])
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
    expect(screen.getByLabelText('音乐描述')).toHaveValue('轻快电子节奏')
    const submit = screen.getByRole('button', { name: '生成' })
    await waitFor(() => expect(submit).not.toHaveAttribute('aria-disabled'))
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

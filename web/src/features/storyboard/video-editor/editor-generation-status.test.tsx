import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import type { PendingEdit } from './edit-chain'
import { EditorGenerationStatus } from './editor-generation-status'

const failedJob: GenerationJob = makeGenerationJob({
  id: 'failed-job',
  status: 'failed',
  errorMessage: '上游服务暂时不可用',
  rootJobId: 'root',
})

/** 这次编辑的编辑段；状态只看它，阶段词由各用例覆盖。 */
const segment: PendingEdit['video'] = {
  ...makeGenerationJob({ id: 'edit-1', status: 'submitting', rootJobId: 'root' }),
  sourceJobId: 'root',
  rangeStartMs: 0,
  rangeEndMs: 3000,
}

const edit = (changes: Partial<PendingEdit>): PendingEdit => ({
  key: 'edit-1',
  label: 'V2',
  base: {
    key: 'root',
    jobId: 'root',
    label: 'V1',
    mediaUrl: 'https://example.com/original.mp4',
    createdAt: failedJob.createdAt,
    edit: undefined,
  },
  stage: 'queued',
  range: { start: 0, end: 3 },
  prompt: undefined,
  error: undefined,
  video: segment,
  composite: undefined,
  preview: undefined,
  ...changes,
})

describe('EditorGenerationStatus', () => {
  it.each([
    { stage: 'queued', current: '排队提交，当前阶段', completed: 0 },
    { stage: 'generating', current: '视频生成，当前阶段', completed: 1 },
  ] as const)('$stage 按真实阶段标记进度', async ({ stage, current, completed }) => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage })} />)
    const status = screen.getByRole('status', { name: '视频编辑进度' })
    const steps = within(status).getByRole('list', { name: '生成阶段' })
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3)
    expect(within(steps).getByRole('listitem', { name: current })).toHaveAttribute(
      'aria-current',
      'step',
    )
    expect(within(steps).queryAllByRole('listitem', { name: /已完成/ })).toHaveLength(completed)
    expect(within(status).queryByRole('button')).not.toBeInTheDocument()
    expect(within(status).queryByRole('link')).not.toBeInTheDocument()
  })

  it.each(['ready', 'composing'] as const)('%s 不将预览或合成误报为成片完成', async (stage) => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage })} />)
    const status = screen.getByRole('status', { name: '视频编辑进度' })
    expect(status).toHaveTextContent(stage === 'ready' ? '待预览' : '正在合成成片')
    expect(within(status).getAllByRole('listitem', { name: /已完成/ })).toHaveLength(2)
    expect(within(status).getByRole('listitem', { name: '结果预览，当前阶段' })).toHaveAttribute(
      'aria-current',
      'step',
    )
    expect(
      within(status).queryByRole('listitem', { name: '结果预览，已完成' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    { clipStage: 'fetching', text: '正在取素材' },
    { clipStage: 'processing', text: '正在编码成片' },
    { clipStage: 'uploading', text: '正在上传成片' },
  ] as const)('合成显示后端报的加工阶段：$text', async ({ clipStage, text }) => {
    const running: GenerationJob = { ...failedJob, status: 'submitting', clipStage }
    await renderWithProviders(
      <EditorGenerationStatus edit={edit({ stage: 'composing', composite: running })} />,
    )

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent(text)
  })

  it.each([
    { status: 'pending', text: '排队等待中' },
    { status: 'submitting', text: '正在提交给模型' },
  ] as const)('编辑段还没交给模型时如实说在哪：$text', async ({ status, text }) => {
    await renderWithProviders(
      <EditorGenerationStatus edit={edit({ stage: 'queued', video: { ...segment, status } })} />,
    )

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent(text)
  })

  it('合成还在本系统排队时说清是在等', async () => {
    const queued: GenerationJob = { ...failedJob, status: 'pending' }
    await renderWithProviders(
      <EditorGenerationStatus edit={edit({ stage: 'composing', composite: queued })} />,
    )

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent('等待合成')
  })

  it('合成没有阶段可读时回落到原文案', async () => {
    await renderWithProviders(<EditorGenerationStatus edit={edit({ stage: 'composing' })} />)

    expect(screen.getByRole('status', { name: '视频编辑进度' })).toHaveTextContent('正在合成成片')
  })

  it.each([
    { failedAt: 'video', failedStep: '视频生成，失败', completed: 1 },
    { failedAt: 'composite', failedStep: '结果预览，失败', completed: 2 },
  ] as const)(
    '$failedAt 失败时保留错误并停止该阶段',
    async ({ failedAt, failedStep, completed }) => {
      await renderWithProviders(
        <EditorGenerationStatus
          edit={edit({
            stage: 'failed',
            [failedAt]: failedJob,
            error: failedJob.errorMessage ?? undefined,
          })}
        />,
      )
      const status = screen.getByRole('status', { name: '视频编辑进度' })
      expect(status).toHaveTextContent('上游服务暂时不可用')
      expect(within(status).getByRole('listitem', { name: failedStep })).toHaveAttribute(
        'aria-current',
        'step',
      )
      expect(within(status).queryAllByRole('listitem', { name: /已完成/ })).toHaveLength(completed)
      expect(within(status).queryByRole('listitem', { name: /当前阶段/ })).not.toBeInTheDocument()
    },
  )
})

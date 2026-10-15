import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { selectedGroup } from './clip-selection'
import { clipItem, keyframeSegments, parseStoredDraft, serializeDraft, type Draft } from './draft'
import { isEditSegment } from './edit-chain'
import { draftStorageKey, useEditDraft } from './use-edit-draft'

const version = {
  jobId: 'base',
  label: 'V1',
  mediaUrl: 'https://oss.example/base.mp4',
  sourceJobId: undefined,
}
const segments = keyframeSegments('base', { keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })
const key = draftStorageKey('conversation', 'base')
const stored = () => parseStoredDraft(window.localStorage.getItem(key) ?? '')
const edit = (overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({
    id: 'edit',
    sourceJobId: 'base',
    rootJobId: 'base',
    rangeStartMs: 1000,
    rangeEndMs: 3000,
    status: 'completed',
    outputUrl: 'https://oss.example/edit.mp4',
    durationMs: 2500,
    ...overrides,
  })
const renderDraft = (initialJobs: GenerationJob[]) => {
  const onComposed = vi.fn()
  const onNotice = vi.fn()
  const onStorageFailure = vi.fn()
  const rendered = renderHook(
    ({ jobs }: { jobs: GenerationJob[] }) =>
      useEditDraft({
        conversationId: 'conversation',
        version,
        versions: [version],
        segments,
        jobs,
        edits: jobs.filter(isEditSegment),
        outcomeOf: (id) => {
          const job = jobs.find((item) => item.id === id)
          if (job?.status === 'completed' && job.durationMs !== null)
            return { kind: 'done', duration: job.durationMs / 1000 }
          if (job?.status === 'failed') return { kind: 'failed', message: '生成失败' }
          return job === undefined ? undefined : { kind: 'running' }
        },
        onComposed,
        onNotice,
        onStorageFailure,
      }),
    { initialProps: { jobs: initialJobs } },
  )
  return { ...rendered, onComposed, onNotice }
}

beforeEach(() => window.localStorage.clear())

describe('剪辑版本选择的保存', () => {
  it('新提交保留原片选区，生成完成只增加候选，不替换当前素材', () => {
    const view = renderDraft([])
    const selected = segments.slice(1, 3).map((segment) => segment.id)
    act(() => view.result.current?.select(selected))
    act(() => view.result.current?.submitted())

    const grouped = clipItem({ sourceJobId: 'base', start: 1, end: 3 })
    expect(view.result.current?.selection).toEqual([grouped.id])
    expect(stored()?.draft[1]).toEqual(grouped)
    view.rerender({ jobs: [edit({ status: 'submitted', outputUrl: null, durationMs: null })] })
    view.rerender({ jobs: [edit()] })
    expect(stored()?.draft[1]).toEqual(grouped)
    expect(view.result.current?.selection).toEqual([grouped.id])
    expect(view.result.current?.changed).toBe(false)
  })

  it('初次无存储时组织原片区间；选回 V1 后仍明确保存，重新打开保持选择', () => {
    const view = renderDraft([edit()])
    expect(stored()?.draft[1]).toEqual(clipItem({ sourceJobId: 'base', start: 1, end: 3 }))
    const result = clipItem({ sourceJobId: 'edit', start: 0, end: 2.5 })
    act(() =>
      view.result.current?.apply({
        draft: [...segments.slice(0, 1), result, ...segments.slice(3)],
        selection: [result.id],
      }),
    )
    act(() => view.result.current?.apply({ draft: segments, selection: [] }))
    expect(stored()?.draft).toEqual(segments)
    view.unmount()

    const reopened = renderDraft([edit()])
    expect(stored()?.draft).toEqual(segments)
    expect(reopened.result.current?.changed).toBe(false)
  })

  it('混合来源提交后保留多段选区，新候选仍归属整个基底范围且不自动采用', () => {
    const view = renderDraft([edit()])
    const result = clipItem({ sourceJobId: 'edit', start: 0, end: 2.5 })
    const next = segments[3]
    if (next === undefined) throw new Error('缺少相邻片段')
    const draft = [...segments.slice(0, 1), result, ...segments.slice(3)]
    const selection = [result.id, next.id]
    act(() => view.result.current?.apply({ draft, selection }))
    act(() => view.result.current?.submitted())
    expect(view.result.current?.draft).toEqual(draft)
    expect(view.result.current?.selection).toEqual(selection)

    const wider = edit({ id: 'wider', rangeEndMs: 4000, durationMs: 3500 })
    view.rerender({ jobs: [edit(), wider] })
    expect(stored()?.draft).toEqual(draft)
    expect(selectedGroup(draft, selection, 'base', [edit(), wider])).toMatchObject({
      start: 1,
      end: 4,
      edits: [wider],
    })
    expect(view.result.current?.selection).toEqual(selection)
  })

  it('合成成功只清等待，保留片段版本、选区与可撤销的剪辑', () => {
    const pending = makeGenerationJob({
      id: 'composite',
      operation: 'compose',
      sourceJobId: 'base',
      status: 'submitted',
    })
    const view = renderDraft([edit(), pending])
    const result = clipItem({ sourceJobId: 'edit', start: 0, end: 2.5 })
    const draft = [...segments.slice(0, 1), result, ...segments.slice(3)]
    act(() => view.result.current?.apply({ draft, selection: [result.id] }))
    act(() => view.result.current?.composing(pending.id))
    expect(stored()?.composite).toBe('composite')

    view.rerender({
      jobs: [
        edit(),
        { ...pending, status: 'completed', outputUrl: 'https://oss.example/composite.mp4' },
      ],
    })
    expect(stored()).toEqual({ draft, composite: undefined })
    expect(view.result.current?.selection).toEqual([result.id])
    expect(view.result.current?.canUndo).toBe(true)
    expect(view.onComposed).toHaveBeenCalledExactlyOnceWith('composite')
  })

  it('原有占位可以恢复，不丢弃已经提交的编辑工作', () => {
    const first = edit()
    const child = edit({
      id: 'child',
      sourceJobId: 'base',
      rangeStartMs: 1000,
      rangeEndMs: 3000,
      status: 'submitted',
      outputUrl: null,
      durationMs: null,
    })
    const previous = clipItem({ sourceJobId: first.id, start: 0, end: 2.5 })
    const draft: Draft = [
      ...segments.slice(0, 1),
      { kind: 'pending', id: 'pending@child', editJobId: 'child', replaced: [previous] },
      ...segments.slice(3),
    ]
    window.localStorage.setItem(key, serializeDraft({ draft, composite: undefined }))
    const view = renderDraft([first, child])
    expect(stored()?.draft).toEqual(draft)
    view.rerender({ jobs: [first, { ...child, status: 'completed', durationMs: 3000 }] })
    expect(stored()?.draft[1]).toEqual(clipItem({ sourceJobId: 'child', start: 0, end: 3 }))
    view.unmount()

    const reopened = renderDraft([first, { ...child, status: 'completed', durationMs: 3000 }])
    expect(stored()?.draft[1]).toEqual(clipItem({ sourceJobId: 'child', start: 0, end: 3 }))
    expect(reopened.onNotice).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { materialCatalog, materialName } from './film-materials'

const take = (id: string, minute: number, shotIndex: number | null = 2) =>
  makeGenerationJob({
    id,
    outputUrl: `https://example.com/${id}.mp4`,
    finishedAt: `2026-10-15T10:${String(minute).padStart(2, '0')}:00Z`,
    shotIndex,
    durationMs: 8000,
  })
const edit = (id: string, minute: number, rootJobId: string, sourceJobId = rootJobId) => ({
  ...take(id, minute),
  operation: 'compose' as const,
  rootJobId,
  sourceJobId,
})

describe('整片素材目录', () => {
  it('同镜头组的独立生成各有一轨，编辑后再编辑仍属于同一原作', () => {
    const groups = groupConversationVideos([
      edit('A-edit2', 4, 'A', 'A-edit1'),
      take('B', 1),
      edit('B-edit1', 3, 'B'),
      take('A', 0),
      edit('A-edit1', 2, 'A'),
    ])
    const catalog = materialCatalog(groups)
    expect(catalog.groups[0]?.takes.map((item) => [item.id, item.label])).toEqual([
      ['A', '生成 A'],
      ['B', '生成 B'],
    ])
    expect(
      catalog.groups[0]?.takes.map((item) => item.versions.map((version) => version.jobId)),
    ).toEqual([
      ['A', 'A-edit1', 'A-edit2'],
      ['B', 'B-edit1'],
    ])
    expect(catalog.groups[0]?.takes[0]?.versions.map((item) => item.version)).toEqual([
      '原片',
      'V1',
      'V2',
    ])
    const edited = catalog.byJob.get('A-edit2')
    expect(edited).toMatchObject({ takeId: 'A', knownDuration: 8 })
    expect(edited === undefined ? undefined : materialName(edited)).toBe('镜头组 2 · 生成 A · V2')
    // 对话的全局版本组保持完成时间顺序，局部分轨不改其公共合同。
    expect(groups[0]?.videos.map((item) => item.id)).toEqual([
      'A',
      'B',
      'A-edit1',
      'B-edit1',
      'A-edit2',
    ])
  })

  it('原作不可读时仍以明确的 rootJobId 归轨，不猜素材时长', () => {
    const catalog = materialCatalog(
      groupConversationVideos([{ ...edit('edited', 1, 'missing-root'), durationMs: null }]),
    )
    expect(catalog.groups[0]?.takes[0]).toMatchObject({
      id: 'missing-root',
      versions: [{ jobId: 'edited', version: 'V1', knownDuration: undefined }],
    })
  })
})

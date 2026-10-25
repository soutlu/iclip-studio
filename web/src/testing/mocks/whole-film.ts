/** 成片草稿与导出的 mock：每段对话一份草稿，形状与版本号规矩同后端（合同 §6「成片草稿」「成片导出」）。
 * 只查文档的形状与版本号，不核对引用的记录；整份保存，版本对不上是 409。 */

import { http, HttpResponse } from 'msw'
import type { WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { zWholeFilmDraftIn, zWholeFilmExportIn } from '@/shared/api/generated/zod.gen'
import { withPivots } from '@/features/storyboard/whole-film/composition/build'

type StoredDraft = { revision: number; document: WholeFilmDocument; updatedAt: string }

const drafts = new Map<string, StoredDraft>()

/**
 * 导出的 mock：每段对话记最近一次导出，读最近一次时按读的次数往前走，
 * 排队（前面 1 个、0 个）→ 渲染（还没有进度、40%、80%）→ 上传 → 完成，下载地址长期有效，同后端。
 */
type MockExport = {
  id: string
  sourceJobIds: string[]
  reads: number
  cancelled: boolean
}

const latestExports = new Map<string, MockExport>()

const EXPORT_STEPS = [
  { status: 'queued', progress: null, queuePosition: 1 },
  { status: 'queued', progress: null, queuePosition: 0 },
  { status: 'rendering', progress: null, queuePosition: null },
  { status: 'rendering', progress: 0.4, queuePosition: null },
  { status: 'rendering', progress: 0.8, queuePosition: null },
  { status: 'uploading', progress: null, queuePosition: null },
] as const

export const STALE_DRAFT_DETAIL = '成片草稿已经有更新的一版，重新读取后再改'
export const STALE_EXPORT_DETAIL = '成片草稿已经有更新的一版，重新读取后再导出'

export const resetMockWholeFilm = () => {
  drafts.clear()
  latestExports.clear()
}

const exportOut = (found: MockExport) => {
  const base = {
    id: found.id,
    sourceJobIds: found.sourceJobIds,
    error: null,
    downloadUrl: null,
  }
  if (found.cancelled) return { ...base, status: 'cancelled', progress: null, queuePosition: null }
  const step = EXPORT_STEPS[found.reads]
  found.reads += 1
  if (step !== undefined) return { ...base, ...step }
  return {
    ...base,
    status: 'done',
    progress: 1,
    queuePosition: null,
    downloadUrl: `/mock-exports/${found.id}.mp4`,
  }
}

/** 一次没取消的导出（按导出 id 找），高清版的 mock 把它当成片记录；没有为 undefined。 */
export const findMockWholeFilmExport = (
  exportId: string,
): { sourceJobIds: readonly string[]; downloadUrl: string } | undefined => {
  const found = [...latestExports.values()].find((item) => item.id === exportId && !item.cancelled)
  return found === undefined
    ? undefined
    : { downloadUrl: `/mock-exports/${found.id}.mp4`, sourceJobIds: found.sourceJobIds }
}

/** 这段对话现存的草稿；还没存过是 undefined。 */
export const mockWholeFilmDraft = (conversationId: string): StoredDraft | undefined =>
  drafts.get(conversationId)

/** 直接放一份草稿（版本号加一），模拟别处已经存过。 */
export const putMockWholeFilmDraft = (conversationId: string, document: WholeFilmDocument) => {
  const revision = (drafts.get(conversationId)?.revision ?? 0) + 1
  const stored = { revision, document, updatedAt: new Date().toISOString() }
  drafts.set(conversationId, stored)
  return stored
}

export const wholeFilmHandlers = [
  http.get('*/api/conversations/:conversationId/whole-film/draft', ({ params }) => {
    const stored = drafts.get(String(params['conversationId']))
    return HttpResponse.json(stored ?? { revision: 0, document: null, updatedAt: null })
  }),

  http.put('*/api/conversations/:conversationId/whole-film/draft', async ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const parsed = zWholeFilmDraftIn.safeParse(await request.json())
    if (!parsed.success) return HttpResponse.json({ detail: 'document: 形状不对' }, { status: 422 })
    const current = drafts.get(conversationId)?.revision ?? 0
    if (parsed.data.revision !== current)
      return HttpResponse.json({ detail: STALE_DRAFT_DETAIL }, { status: 409 })
    // 同后端存下、发回的形状：没写的转轴是 null
    const stored = putMockWholeFilmDraft(conversationId, withPivots(parsed.data.document))
    return HttpResponse.json({ revision: stored.revision, updatedAt: stored.updatedAt })
  }),

  http.post(
    '*/api/conversations/:conversationId/whole-film/exports',
    async ({ params, request }) => {
      const conversationId = String(params['conversationId'])
      const parsed = zWholeFilmExportIn.safeParse(await request.json())
      if (!parsed.success)
        return HttpResponse.json({ detail: 'revision: 形状不对' }, { status: 422 })
      const stored = drafts.get(conversationId)
      if (parsed.data.revision !== (stored?.revision ?? 0))
        return HttpResponse.json({ detail: STALE_EXPORT_DETAIL }, { status: 409 })
      const sourceJobIds = [
        ...new Set(
          (stored?.document.layer0 ?? []).flatMap((clip) =>
            clip.type === 'video' ? [clip.sourceJobId] : [],
          ),
        ),
      ]
      if (sourceJobIds.length === 0)
        return HttpResponse.json({ detail: '画面轨里还没有视频，无法导出' }, { status: 422 })
      const exportId = crypto.randomUUID()
      latestExports.set(conversationId, {
        id: exportId,
        sourceJobIds,
        reads: 0,
        cancelled: false,
      })
      return HttpResponse.json({ exportId, sourceJobIds }, { status: 202 })
    },
  ),

  http.get('*/api/conversations/:conversationId/whole-film/exports/latest', ({ params }) => {
    const found = latestExports.get(String(params['conversationId']))
    return HttpResponse.json({ export: found === undefined ? null : exportOut(found) })
  }),

  http.delete('*/api/conversations/:conversationId/whole-film/exports/:exportId', ({ params }) => {
    const found = latestExports.get(String(params['conversationId']))
    if (found?.id !== String(params['exportId']))
      return HttpResponse.json({ detail: '成片导出不存在' }, { status: 404 })
    // 已经完成的也答 204、状态不变
    if (found.reads <= EXPORT_STEPS.length) found.cancelled = true
    return new HttpResponse(null, { status: 204 })
  }),

  // 导出完成后的下载：按附件给一小段字节
  http.get('*/mock-exports/:name', () =>
    HttpResponse.arrayBuffer(new Uint8Array([0, 0, 0, 24]).buffer, {
      headers: {
        'Content-Disposition': 'attachment; filename="whole-film.mp4"',
        'Content-Type': 'video/mp4',
      },
    }),
  ),
]

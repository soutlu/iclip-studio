/** 整片草稿与导出的 mock：每段对话一份草稿，形状与版本号规矩同后端（合同 §6「整片草稿」「整片导出」）。
 * 只查文档的形状与版本号，不核对引用的记录；整份保存，版本对不上是 409。 */

import { http, HttpResponse } from 'msw'
import type { WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { zWholeFilmDraftIn, zWholeFilmExportIn } from '@/shared/api/generated/zod.gen'

type StoredDraft = { revision: number; document: WholeFilmDocument; updatedAt: string }

const drafts = new Map<string, StoredDraft>()

/**
 * 导出的 mock：按读的次数往前走，排队（前面 1 个、0 个）→ 渲染 40%、80% → 上传 → 完成。
 * 每次读都签一个新的下载地址，同后端。
 */
type MockExport = {
  conversationId: string
  sourceJobIds: string[]
  reads: number
  cancelled: boolean
}

const exportJobs = new Map<string, MockExport>()

const EXPORT_STEPS = [
  { status: 'queued', progress: 0, queuePosition: 1 },
  { status: 'queued', progress: 0, queuePosition: 0 },
  { status: 'rendering', progress: 0.4, queuePosition: null },
  { status: 'rendering', progress: 0.8, queuePosition: null },
  { status: 'uploading', progress: 1, queuePosition: null },
] as const

export const STALE_DRAFT_DETAIL = '整片草稿已经有更新的一版，重新读取后再改'
export const STALE_EXPORT_DETAIL = '整片草稿已经有更新的一版，重新读取后再导出'
export const EXPORT_GONE_DETAIL = '导出已中断，请重新导出'

export const resetMockWholeFilm = () => {
  drafts.clear()
  exportJobs.clear()
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
    const stored = putMockWholeFilmDraft(conversationId, parsed.data.document)
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
      exportJobs.set(exportId, { conversationId, sourceJobIds, reads: 0, cancelled: false })
      return HttpResponse.json({ exportId, sourceJobIds }, { status: 202 })
    },
  ),

  http.get('*/api/conversations/:conversationId/whole-film/exports/:exportId', ({ params }) => {
    const found = exportJobs.get(String(params['exportId']))
    if (found === undefined || found.conversationId !== String(params['conversationId']))
      return HttpResponse.json({ detail: EXPORT_GONE_DETAIL }, { status: 404 })
    const base = { error: null, downloadUrl: null, expiresAt: null }
    if (found.cancelled)
      return HttpResponse.json({ ...base, status: 'cancelled', progress: 0, queuePosition: null })
    const step = EXPORT_STEPS[found.reads]
    found.reads += 1
    if (step !== undefined) return HttpResponse.json({ ...base, ...step })
    return HttpResponse.json({
      ...base,
      status: 'done',
      progress: 1,
      queuePosition: null,
      downloadUrl: `/mock-exports/${String(params['exportId'])}.mp4?signed=${found.reads}`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
  }),

  http.delete('*/api/conversations/:conversationId/whole-film/exports/:exportId', ({ params }) => {
    const found = exportJobs.get(String(params['exportId']))
    if (found === undefined || found.conversationId !== String(params['conversationId']))
      return HttpResponse.json({ detail: EXPORT_GONE_DETAIL }, { status: 404 })
    found.cancelled = true
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

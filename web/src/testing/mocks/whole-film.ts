import { http, HttpResponse } from 'msw'
import type { WholeFilmDocument } from '@/shared/api/generated/types.gen'
import { zWholeFilmDraftIn, zWholeFilmExportIn } from '@/shared/api/generated/zod.gen'

type StoredDraft = { revision: number; document: WholeFilmDocument; updatedAt: string }

const drafts = new Map<string, StoredDraft>()

type MockExport = {
  id: string
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

export const findMockWholeFilmExport = (exportId: string): { downloadUrl: string } | undefined => {
  const found = [...latestExports.values()].find((item) => item.id === exportId && !item.cancelled)
  return found === undefined ? undefined : { downloadUrl: `/mock-exports/${found.id}.mp4` }
}

export const mockWholeFilmDraft = (conversationId: string): StoredDraft | undefined =>
  drafts.get(conversationId)

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
      if (!stored?.document.layer0.some((clip) => clip.type === 'video'))
        return HttpResponse.json({ detail: '画面轨里还没有视频，无法导出' }, { status: 422 })
      const exportId = crypto.randomUUID()
      latestExports.set(conversationId, { id: exportId, reads: 0, cancelled: false })
      return HttpResponse.json({ exportId }, { status: 202 })
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
    if (found.reads <= EXPORT_STEPS.length) found.cancelled = true
    return new HttpResponse(null, { status: 204 })
  }),

  http.get('*/mock-exports/:name', () =>
    HttpResponse.arrayBuffer(new Uint8Array([0, 0, 0, 24]).buffer, {
      headers: {
        'Content-Disposition': 'attachment; filename="whole-film.mp4"',
        'Content-Type': 'video/mp4',
      },
    }),
  ),
]

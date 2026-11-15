import { http, HttpResponse } from 'msw'
import { mockPreviewOrigin, mockPreviewToken } from './preview-token'
import { mockWorkspaceFile, putMockWorkspaceFile } from './workspace'

/** final-cut 的主文件在工作区里的路径。 */
const PROJECT_MAIN_PATH = 'final-cut/index.html'

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

export const resetMockWholeFilm = () => {
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

/** 工程主文件现在的内容和版本；还没有工程时是 undefined。 */
export const mockProjectMain = (conversationId: string) =>
  mockWorkspaceFile(conversationId, PROJECT_MAIN_PATH)

/** 把工程主文件写成 `html`（没有就建），答复写进去的内容和版本。 */
export const putMockProjectMain = (conversationId: string, html: string) => ({
  content: html,
  version: putMockWorkspaceFile(conversationId, PROJECT_MAIN_PATH, html),
})

const PREVIEW_TOKEN_TTL_MS = 3600_000

export const wholeFilmHandlers = [
  // 预览页在另一个主机名上，应用页的 MSW 管不到它：它取应用来源、取工程文件走 mock 开发服务器的中间件
  http.post('*/api/conversations/:conversationId/final-cut/preview', ({ request }) => {
    const appOrigin = new URL(request.url).origin
    return HttpResponse.json({
      origin: mockPreviewOrigin(appOrigin),
      token: mockPreviewToken(appOrigin),
      expiresAt: new Date(Date.now() + PREVIEW_TOKEN_TTL_MS).toISOString(),
    })
  }),

  http.post('*/api/conversations/:conversationId/whole-film/exports', ({ params }) => {
    const conversationId = String(params['conversationId'])
    if (mockProjectMain(conversationId) === undefined)
      return HttpResponse.json({ detail: 'final-cut 暂无内容，无法导出' }, { status: 422 })
    const exportId = crypto.randomUUID()
    latestExports.set(conversationId, { id: exportId, reads: 0, cancelled: false })
    return HttpResponse.json({ exportId }, { status: 202 })
  }),

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

/** 高清版（超分）的 mock：读各档、提交一档与读一条超分记录，规矩照 contract/conventions.md「高清版」。
 *
 * 来源可以是任一对话里的成片、资料库成片素材里的一版、资料库里的整片或刚导出的整片；按来源出片时的分辨率列比它清晰的档。
 * 提交后经 pending → submitted 再落定，每跳一格照常发 event.generation.changed（不挂对话）。
 * 1080p 总是做成；720p 总是没做成，用来演示失败的提示条、红点与重试。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import { zVideoEnhanceIn, type zGenerationOut } from '@/shared/api/generated/zod.gen'
import { findMockLibraryVersion, mockLibraryWholeFilms } from './library'
import { findMockWholeFilmExport } from './whole-film'
import { announceMockGeneration, findMockTake } from './workspace'

type EnhanceRecord = z.output<typeof zGenerationOut>
type Resolution = z.output<typeof zVideoEnhanceIn>['resolution']

/** 运行配置的档，从高到低。 */
const TIERS: readonly Resolution[] = ['1080p', '720p']

const SHORT_SIDE: Record<string, number> = { '480p': 480, '720p': 720, '1080p': 1080 }

const SUBMITTED_AFTER_MS = 1_000
const SETTLED_AFTER_MS = 6_000

/** mock 里没做成的那一档。 */
const FAILING_TIER: Resolution = '720p'

type MockSource = {
  id: string
  kind: 'video' | 'whole_film'
  /** 出片时的分辨率；推不出为 null，列全部档。 */
  resolution: string | null
  shotIndex: number | null
  url: string
  durationMs: number | null
  downloadedJobIds: readonly string[]
}

const resolutionOf = (request: Record<string, unknown> | null): string | null => {
  const value = request?.['resolution']
  return typeof value === 'string' ? value : null
}

const videoSource = (id: string): MockSource | undefined => {
  const take = findMockTake(id)
  if (take !== undefined && take.outputUrl !== null) {
    return {
      downloadedJobIds: [id],
      durationMs: take.durationMs,
      id,
      kind: 'video',
      resolution: resolutionOf(take.request),
      shotIndex: take.shotIndex,
      url: take.outputUrl,
    }
  }
  const found = findMockLibraryVersion(id)
  if (found === undefined) return undefined
  return {
    downloadedJobIds: [id],
    durationMs: found.version.durationMs,
    id,
    kind: 'video',
    resolution: found.version.take.resolution ?? null,
    shotIndex: found.shotIndex,
    url: found.version.outputUrl,
  }
}

/** 整片按画面轨第一条成片定清晰度。 */
const filmSource = (id: string, url: string, sourceJobIds: readonly string[]): MockSource => ({
  downloadedJobIds: sourceJobIds,
  durationMs: null,
  id,
  kind: 'whole_film',
  resolution:
    sourceJobIds[0] === undefined ? null : (videoSource(sourceJobIds[0])?.resolution ?? null),
  shotIndex: null,
  url,
})

const sourceOf = (id: string): MockSource | undefined => {
  const video = videoSource(id)
  if (video !== undefined) return video
  const film = mockLibraryWholeFilms()
    .flatMap((card) => card.versions)
    .find((version) => version.jobId === id)
  if (film !== undefined) return filmSource(id, film.outputUrl, film.sourceJobIds)
  const exported = findMockWholeFilmExport(id)
  return exported === undefined
    ? undefined
    : filmSource(id, exported.downloadUrl, exported.sourceJobIds)
}

const offeredTiers = (source: MockSource): Resolution[] => {
  const own = source.resolution === null ? undefined : SHORT_SIDE[source.resolution]
  return own === undefined ? [...TIERS] : TIERS.filter((tier) => (SHORT_SIDE[tier] ?? 0) > own)
}

/** 刚受理的一条超分记录。 */
const recordOf = (source: MockSource, resolution: Resolution): EnhanceRecord => ({
  clipStage: null,
  createdAt: new Date().toISOString(),
  durationMs: null,
  errorMessage: null,
  finishedAt: null,
  id: crypto.randomUUID(),
  kind: source.kind,
  metadata: null,
  operation: 'enhance',
  outputUrl: null,
  rangeEndMs: null,
  rangeStartMs: null,
  request: { fps: null, model: 'mock-enhance', resolution, user_name: null, video_url: source.url },
  rootJobId: null,
  sentences: null,
  shotIndex: source.shotIndex,
  sourceJobId: source.id,
  sourceUrl: source.url,
  status: 'pending',
  taskId: null,
  watermarkOutputUrl: null,
})

/** 按建立先后存；同一来源同一档取最后一条。 */
let records: EnhanceRecord[] = []
const timers = new Set<ReturnType<typeof setTimeout>>()

export const resetMockEnhancements = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  records = []
}

const latestOf = (sourceId: string, resolution: Resolution) =>
  records.findLast(
    (record) => record.sourceJobId === sourceId && resolutionOf(record.request) === resolution,
  )

const later = (ms: number, step: () => void) => {
  const timer = setTimeout(() => {
    timers.delete(timer)
    step()
  }, ms)
  timers.add(timer)
}

const accept = (source: MockSource, resolution: Resolution): EnhanceRecord => {
  const created = recordOf(source, resolution)
  records.push(created)
  announceMockGeneration(null, created)
  later(SUBMITTED_AFTER_MS, () => {
    created.status = 'submitted'
    announceMockGeneration(null, created)
  })
  later(SETTLED_AFTER_MS, () => {
    const finishedAt = new Date().toISOString()
    // 地址、时长与完成时刻一起落，同出片。
    Object.assign(
      created,
      resolution === FAILING_TIER
        ? { errorMessage: '超分服务没有给出结果', finishedAt, status: 'failed' }
        : {
            durationMs: source.durationMs,
            finishedAt,
            outputUrl: source.url,
            status: 'completed',
            watermarkOutputUrl: source.url,
          },
    )
    announceMockGeneration(null, created)
  })
  return created
}

const notFound = () => HttpResponse.json({ detail: '没有这条记录' }, { status: 404 })

export const enhancementHandlers = [
  http.get('*/api/generations/:jobId/enhancements', ({ params }) => {
    const source = sourceOf(String(params['jobId']))
    if (source === undefined) return notFound()
    return HttpResponse.json({
      downloadedJobIds: source.downloadedJobIds,
      tiers: offeredTiers(source).map((resolution) => ({
        job: latestOf(source.id, resolution) ?? null,
        resolution,
      })),
    })
  }),

  http.post('*/api/generations/video-enhancements', async ({ request }) => {
    const parsed = zVideoEnhanceIn.safeParse(await request.json())
    if (!parsed.success) return HttpResponse.json({ detail: '请求形状不对' }, { status: 422 })
    const { resolution, sourceJobId } = parsed.data
    const source = sourceOf(sourceJobId)
    if (source === undefined) return notFound()
    if (!offeredTiers(source).includes(resolution))
      return HttpResponse.json({ detail: `这条视频不能再提到 ${resolution}` }, { status: 422 })
    const existing = latestOf(sourceJobId, resolution)
    const generation =
      existing !== undefined && existing.status !== 'failed' ? existing : accept(source, resolution)
    return HttpResponse.json({ generation }, { status: 202 })
  }),

  // 只认超分记录；排在其他 /generations/... 的 GET 之后，不抢它们。
  http.get('*/api/generations/:jobId', ({ params }) => {
    const found = records.find((record) => record.id === params['jobId'])
    return found === undefined ? notFound() : HttpResponse.json({ generation: found })
  }),
]

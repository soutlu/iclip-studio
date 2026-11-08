import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zHitCaseIn,
  zHitCaseOut,
  zHitCaseStateOut,
  zHitCaseTagsIn,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser } from './auth-user'
import { authorsOf, findMockLibraryCardOf, mockLibraryVideos } from './library'
import {
  findMockTagId,
  isMockAiTag,
  isMockTagValue,
  mockTagId,
  mockTagMatcher,
} from './library-tags'
import { pageBy } from './paging'

type HitCase = z.output<typeof zHitCaseOut>
type HitCaseState = z.output<typeof zHitCaseStateOut>
type Ineligible = NonNullable<HitCaseState['ineligibleReason']>

type Row = {
  jobId: string
  tagIds: string[]
  tagStatus: HitCase['tagStatus']
  tagError: HitCase['tagError']
  addedAt: string
  addedBy: string | null
  tagQueuedAt: number | null
}

const MINUTE_MS = 60_000
const TAG_PENDING_MS = 1000
const TAG_SETTLE_MS = 2500

const DEMO_AI_TAGS = ['跑鞋', '户外/公园散步', '动态场景跟拍'] as const

const NO_TREATMENT_TITLES = new Set(['跑鞋质感大片'])

const INELIGIBLE_MESSAGES: Record<Ineligible, string> = {
  no_conversation: '这条素材片不在任何对话里，没有新片执行方案，无法加入爆款素材库',
  no_treatment: '所在对话没有新片执行方案，无法加入爆款素材库',
  not_material: '这条视频不是成片素材里的素材片，无法加入爆款素材库',
}

const rows = new Map<string, Row>()

const ineligibleOf = (jobId: string): Ineligible | null => {
  const found = findMockLibraryCardOf(jobId)
  if (found === undefined) return 'not_material'
  if (found.video.conversationId === null) return 'no_conversation'
  if (found.video.title !== null && NO_TREATMENT_TITLES.has(found.video.title))
    return 'no_treatment'
  return null
}

export const addMockHitCase = (jobId: string, overrides: Partial<Omit<Row, 'jobId'>> = {}) => {
  const row: Row = {
    addedAt: new Date().toISOString(),
    addedBy: mockAuthUser.username,
    jobId,
    tagError: null,
    tagIds: [],
    tagQueuedAt: null,
    tagStatus: 'completed',
    ...overrides,
  }
  rows.set(jobId, row)
  return row
}

const faceJobOf = (title: string): string => {
  const video = mockLibraryVideos().find((candidate) => candidate.title === title)
  if (video === undefined) throw new Error(`成片素材 mock 里没有「${title}」`)
  return video.face.jobId
}

const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS).toISOString()

const seedDemo = () => {
  addMockHitCase(faceJobOf('春夏凉鞋合集'), {
    addedAt: ago(30),
    addedBy: 'Nora.Ho',
    tagIds: ['TikTok', '平底凉鞋', '居家/日常放松', '动态上身展示'].map(mockTagId),
  })
  addMockHitCase(faceJobOf('童鞋海边亲子'), {
    addedAt: ago(10),
    tagIds: [mockTagId('AMZ')],
    tagStatus: 'running',
  })
  addMockHitCase(faceJobOf('滑板女孩 · 厚底靴街拍'), {
    addedAt: ago(60),
    addedBy: 'Maya.Cheng',
    tagError: 'timeout',
    tagIds: [mockTagId('INS')],
    tagStatus: 'failed',
  })
}

export const resetMockHitCases = (seed?: readonly (Partial<Row> & { jobId: string })[]) => {
  rows.clear()
  if (seed === undefined) seedDemo()
  else for (const { jobId, ...overrides } of seed) addMockHitCase(jobId, overrides)
}

const advance = (row: Row, now: number) => {
  if (row.tagQueuedAt === null) return
  const elapsed = now - row.tagQueuedAt
  if (elapsed < TAG_PENDING_MS) row.tagStatus = 'pending'
  else if (elapsed < TAG_SETTLE_MS) row.tagStatus = 'running'
  else
    Object.assign(row, {
      tagError: null,
      tagIds: [
        ...row.tagIds.filter((id) => !isMockAiTag(id)),
        ...DEMO_AI_TAGS.flatMap((name) => findMockTagId(name) ?? []),
      ],
      tagQueuedAt: null,
      tagStatus: 'completed',
    } satisfies Partial<Row>)
}

const live = (): Row[] => {
  const now = Date.now()
  for (const row of rows.values()) advance(row, now)
  return [...rows.values()]
}

const find = (jobId: unknown): Row | undefined => live().find((row) => row.jobId === jobId)

export const mockHitCaseTagSets = (): string[][] => live().map((row) => row.tagIds)

export const forgetMockHitCaseTags = (ids: ReadonlySet<string>) => {
  for (const row of rows.values()) row.tagIds = row.tagIds.filter((id) => !ids.has(id))
}

const itemOf = (row: Row): HitCase | null => {
  const found = findMockLibraryCardOf(row.jobId)
  if (found === undefined) return null
  const { take, ...face } = found.version
  return {
    addedAt: row.addedAt,
    cardId: found.video.id,
    face,
    jobId: row.jobId,
    tagError: row.tagError,
    tagIds: [...row.tagIds],
    tagStatus: row.tagStatus,
    take,
    title: found.video.title,
  }
}

const stateOf = (jobId: string): HitCaseState => {
  const reason = ineligibleOf(jobId)
  const row = find(jobId)
  return {
    eligible: reason === null,
    entry:
      row === undefined
        ? null
        : {
            addedAt: row.addedAt,
            addedBy: row.addedBy,
            tagError: row.tagError,
            tagIds: [...row.tagIds],
            tagStatus: row.tagStatus,
          },
    ineligibleReason: reason,
    jobId,
  }
}

const isBusy = (row: Row) => row.tagStatus === 'pending' || row.tagStatus === 'running'

const NOT_FOUND = () => HttpResponse.json({ detail: '没有这条视频' }, { status: 404 })
const NOT_ADDED = () => HttpResponse.json({ detail: '这条素材片不在爆款素材库里' }, { status: 404 })
const BAD_TAG = () => HttpResponse.json({ detail: [{ msg: '没有这个标签' }] }, { status: 422 })
const BUSY = () => HttpResponse.json({ detail: '正在打标，打完再试' }, { status: 409 })

const exists = (jobId: string) => findMockLibraryCardOf(jobId) !== undefined

export const hitCaseHandlers = (viewer: () => string) => [
  http.get('*/api/library/hit-cases', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('cursor')
    const userName = query.get('userName')
    const since = query.get('since')
    const until = query.get('until')
    const tagMatch = mockTagMatcher(query.getAll('tags'))
    if (tagMatch === null) return BAD_TAG()
    const all = live()
      .filter((row) => tagMatch(row.tagIds))
      .flatMap((row) => itemOf(row) ?? [])
      .filter(
        (item) =>
          (userName === null || item.face.userName === userName) &&
          (since === null || Date.parse(item.addedAt) >= Date.parse(since)) &&
          (until === null || Date.parse(item.addedAt) < Date.parse(until)),
      )
    const page = pageBy(
      all,
      (item) => [item.addedAt, item.jobId],
      cursor,
      Number(query.get('limit') ?? 20),
    )
    return HttpResponse.json({ ...page, total: cursor === null ? all.length : null })
  }),

  http.get('*/api/library/hit-cases/authors', () =>
    HttpResponse.json({
      items: authorsOf(live().flatMap((row) => itemOf(row)?.face ?? [])),
    }),
  ),

  http.get('*/api/library/hit-cases/:jobId', ({ params }) => {
    const jobId = String(params['jobId'])
    return exists(jobId) ? HttpResponse.json(stateOf(jobId)) : NOT_FOUND()
  }),

  http.put('*/api/library/hit-cases/:jobId', async ({ params, request }) => {
    const jobId = String(params['jobId'])
    if (!exists(jobId)) return NOT_FOUND()
    const reason = ineligibleOf(jobId)
    if (reason !== null)
      return HttpResponse.json({ detail: INELIGIBLE_MESSAGES[reason] }, { status: 422 })
    if (find(jobId) !== undefined) return HttpResponse.json(stateOf(jobId))
    const { tagIds = [] } = (await request.json()) as z.input<typeof zHitCaseIn>
    if (!tagIds.every(isMockTagValue)) return BAD_TAG()
    addMockHitCase(jobId, {
      addedBy: viewer(),
      tagIds: [...new Set(tagIds)],
      tagQueuedAt: Date.now(),
      tagStatus: 'pending',
    })
    return HttpResponse.json(stateOf(jobId))
  }),

  http.put('*/api/library/hit-cases/:jobId/tags', async ({ params, request }) => {
    const jobId = String(params['jobId'])
    const row = find(jobId)
    if (row === undefined) return NOT_ADDED()
    const { tagIds } = (await request.json()) as z.input<typeof zHitCaseTagsIn>
    if (!tagIds.every(isMockTagValue)) return BAD_TAG()
    if (isBusy(row)) return BUSY()
    row.tagIds = [...new Set(tagIds)]
    return HttpResponse.json(stateOf(jobId))
  }),

  http.post('*/api/library/hit-cases/:jobId/tagging', ({ params }) => {
    const jobId = String(params['jobId'])
    const row = find(jobId)
    if (row === undefined) return NOT_ADDED()
    if (isBusy(row)) return BUSY()
    Object.assign(row, { tagQueuedAt: Date.now(), tagStatus: 'pending' } satisfies Partial<Row>)
    return HttpResponse.json(stateOf(jobId))
  }),

  http.delete('*/api/library/hit-cases/:jobId', ({ params }) => {
    rows.delete(String(params['jobId']))
    return new HttpResponse(null, { status: 204 })
  }),
]

resetMockHitCases()

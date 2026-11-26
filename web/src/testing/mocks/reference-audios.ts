import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zReferenceAudioCreateIn,
  zReferenceAudioUpdateIn,
} from '@/shared/api/generated/zod.gen'
import { AUDIO_KINDS, type ReferenceAudio } from '@/shared/api/reference-audios'
import { MOCK_MUSIC_URL } from './audio'
import { pageByCreated } from './paging'
import { mockConfirmedUpload } from './uploads'

type Row = Omit<ReferenceAudio, 'canEdit'> & { removed: boolean }

/** 测试音频（6 秒）的地址：音色、音效用它，试听、预览里都读得到。 */
export const MOCK_SAMPLE_AUDIO_URL = 'http://localhost/mock-audio/sample.mp3'

/** 上传的音频入库时量出来的时长：和测试音频一样 6 秒。 */
const MEASURED_MS = 6_000

/** 没填属性、没量过波形的一条。 */
const NO_TRAITS = {
  age: null,
  bpm: null,
  gender: null,
  genre: null,
  mood: null,
  peaks: null,
  scenarios: [],
  sfxCategory: null,
} satisfies Partial<Row>

const rows: Row[] = []
let seq = 0

const idOf = (n: number) => `a0d10000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** 往参考音频库里放一条，答复它的编号；没给的项取 tester 的一条 6 秒、无语种的音色。能不能改按读的人算。 */
export const addMockReferenceAudio = ({
  canEdit: _canEdit,
  ...overrides
}: Partial<ReferenceAudio> = {}): string => {
  seq += 1
  const createdAt = new Date(Date.UTC(2026, 9, 1, 8, seq)).toISOString()
  const row: Row = {
    ...NO_TRAITS,
    audioKind: 'voice',
    createdAt,
    description: null,
    durationMs: MEASURED_MS,
    id: idOf(seq),
    locale: null,
    removed: false,
    sourceJobId: null,
    title: `音色 ${String(seq)}`,
    transcript: null,
    updatedAt: createdAt,
    uploadId: null,
    url: MOCK_SAMPLE_AUDIO_URL,
    userName: 'tester',
    ...overrides,
  }
  rows.push(row)
  return row.id
}

const seedDemo = () => {
  addMockReferenceAudio({
    description: '适合口播讲解',
    title: '温柔女声',
    transcript: '今天给大家看一双很舒服的拖鞋。',
  })
  addMockReferenceAudio({ locale: 'en', title: 'Emma', userName: '小林' })
  addMockReferenceAudio({ locale: 'de', title: 'Klaus', userName: '小林' })
  addMockReferenceAudio({
    audioKind: 'bgm',
    description: '轻快，适合开箱',
    durationMs: 30_000,
    title: '轻快原声吉他',
    url: `${MOCK_MUSIC_URL}?library=guitar`,
  })
  addMockReferenceAudio({
    audioKind: 'bgm',
    durationMs: 30_000,
    title: '城市夜景氛围',
    url: `${MOCK_MUSIC_URL}?library=night`,
    userName: '小林',
  })
  addMockReferenceAudio({ audioKind: 'sfx', title: '翻页声', userName: '小林' })
}

/** 换成 `seed` 里的几条；不给时是演示用的几条（各语种的音色、配乐、音效都有）。 */
export const resetMockReferenceAudios = (seed?: readonly Partial<ReferenceAudio>[]) => {
  rows.length = 0
  seq = 0
  if (seed === undefined) seedDemo()
  else for (const overrides of seed) addMockReferenceAudio(overrides)
}

const publicOf = (row: Row, viewer: string): ReferenceAudio => {
  const { removed: _removed, ...audio } = row
  return { ...audio, canEdit: row.userName === viewer }
}

const live = () => rows.filter((row) => !row.removed)

const find = (id: unknown) => live().find((row) => row.id === id)

const NOT_FOUND = () => HttpResponse.json({ detail: '资料库里没有这条参考音频' }, { status: 404 })

const matches = (row: Row, query: URLSearchParams) => {
  const kind = query.get('audioKind')
  const locale = query.get('locale')
  const userName = query.get('userName')
  const keyword = query.get('q')
  return (
    (kind === null || row.audioKind === kind) &&
    (locale === null || row.locale === locale) &&
    (userName === null || row.userName === userName) &&
    (keyword === null ||
      [row.title, row.description, row.transcript].some((text) => text?.includes(keyword)))
  )
}

export const referenceAudioHandlers = (viewer: () => string) => [
  http.get('*/api/references/audios', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('cursor')
    const all = live().filter((row) => matches(row, query))
    const page = pageByCreated(all, cursor, Number(query.get('limit') ?? 20))
    return HttpResponse.json({
      canUpload: true,
      items: page.items.map((row) => publicOf(row, viewer())),
      nextCursor: page.nextCursor,
      total: cursor === null ? all.length : null,
    })
  }),

  http.get('*/api/references/audios/filters', () => {
    const all = live()
    const owners = new Map<string, number>()
    for (const row of all)
      if (row.userName !== null) owners.set(row.userName, (owners.get(row.userName) ?? 0) + 1)
    return HttpResponse.json({
      audioKinds: AUDIO_KINDS.map((audioKind) => ({
        audioKind,
        count: all.filter((row) => row.audioKind === audioKind).length,
      })),
      owners: [...owners].map(([userName, count]) => ({ count, userName })),
    })
  }),

  http.post('*/api/references/audios', async ({ request }) => {
    const body = (await request.json()) as z.input<typeof zReferenceAudioCreateIn>
    const upload = body.uploadId == null ? undefined : mockConfirmedUpload(body.uploadId)
    if (upload === undefined || !upload.contentType.startsWith('audio/'))
      return HttpResponse.json({ detail: '没有这次音频上传' }, { status: 404 })
    if (body.audioKind !== 'voice' && body.transcript != null)
      return HttpResponse.json({ detail: '只有音色（voice）能填台词 transcript' }, { status: 422 })
    const now = new Date().toISOString()
    seq += 1
    const row: Row = {
      ...NO_TRAITS,
      audioKind: body.audioKind,
      createdAt: now,
      description: body.description ?? null,
      durationMs: MEASURED_MS,
      id: idOf(1000 + seq),
      locale: body.locale ?? null,
      removed: false,
      sourceJobId: null,
      title: body.title,
      transcript: body.transcript ?? null,
      updatedAt: now,
      uploadId: body.uploadId ?? null,
      url: upload.url,
      userName: viewer(),
    }
    rows.push(row)
    return HttpResponse.json(publicOf(row, viewer()), { status: 201 })
  }),

  http.get('*/api/references/audios/:id', ({ params }) => {
    const row = find(params['id'])
    return row === undefined ? NOT_FOUND() : HttpResponse.json(publicOf(row, viewer()))
  }),

  http.patch('*/api/references/audios/:id', async ({ params, request }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主或治理者能改' }, { status: 403 })
    const body = (await request.json()) as z.input<typeof zReferenceAudioUpdateIn>
    if (body.title === null)
      return HttpResponse.json({ detail: [{ msg: '标题不能清空' }] }, { status: 422 })
    const next = { ...row }
    if (body.title !== undefined) next.title = body.title
    if (body.description !== undefined) next.description = body.description
    if (body.locale !== undefined) next.locale = body.locale
    if (body.transcript !== undefined) next.transcript = body.transcript
    if (next.audioKind !== 'voice' && next.transcript !== null)
      return HttpResponse.json({ detail: '只有音色（voice）能填台词 transcript' }, { status: 422 })
    Object.assign(row, next, { updatedAt: new Date().toISOString() })
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.delete('*/api/references/audios/:id', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主或治理者能移除' }, { status: 403 })
    row.removed = true
    return new HttpResponse(null, { status: 204 })
  }),
]

resetMockReferenceAudios()

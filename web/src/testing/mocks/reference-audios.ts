import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zReferenceAudioCreateIn,
  zReferenceAudioUpdateIn,
} from '@/shared/api/generated/zod.gen'
import { AUDIO_KINDS, type AudioKind, type ReferenceAudio } from '@/shared/api/reference-audios'
import { MOCK_MUSIC_URL } from './audio'
import { pageByCreated } from './paging'
import { mockConfirmedUpload } from './uploads'

type Row = Omit<ReferenceAudio, 'canEdit'> & { removed: boolean }

/** 测试音频（6 秒）的地址：音色、音效用它，试听、预览里都读得到。 */
export const MOCK_SAMPLE_AUDIO_URL = 'http://localhost/mock-audio/sample.mp3'

/** 上传的音频入库时量出来的时长：和测试音频一样 6 秒。 */
const MEASURED_MS = 6_000

const PEAK_BUCKETS = 120

/** 按种子和包络造一组确定的波形峰值（0～1，3 位小数）：同一种子每次一样。 */
const demoPeaks = (seed: number, envelope: (at: number) => number) => {
  let state = seed
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  return Array.from({ length: PEAK_BUCKETS }, (_, index) => {
    const level = envelope(index / (PEAK_BUCKETS - 1)) * (0.35 + 0.65 * next())
    return Math.round(Math.min(1, level) * 1000) / 1000
  })
}

// 人声一句一句起伏；配乐整段铺满、中段起高潮；音效开头一下、往后衰减
const speech = (at: number) => 0.25 + 0.75 * Math.abs(Math.sin(at * Math.PI * 7))
const music = (at: number) => 0.45 + 0.4 * Math.sin(at * Math.PI)
const transient = (at: number) => Math.max(0.05, Math.exp(-at * 5))

/** 新入库的音频量出来的波形：固定一组。 */
const MEASURED_PEAKS = demoPeaks(7, speech)

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
    age: 'young',
    description: '温柔亲和的女声，适合口播讲解',
    gender: 'female',
    peaks: demoPeaks(11, speech),
    scenarios: ['social', 'explainers'],
    title: '温柔女声',
    transcript: '今天给大家看一双很舒服的拖鞋。',
  })
  addMockReferenceAudio({
    age: 'young',
    description: '明朗轻快的美式女声，起调自然，适合开箱与教程',
    gender: 'female',
    locale: 'en',
    peaks: demoPeaks(23, speech),
    scenarios: ['tutorials', 'social'],
    title: 'Emma',
    userName: '小林',
  })
  addMockReferenceAudio({
    age: 'middle',
    description: '沉稳精准的德语男声，字正腔圆，适配科技短片',
    gender: 'male',
    locale: 'de',
    peaks: demoPeaks(37, speech),
    scenarios: ['documentaries', 'commercials'],
    title: 'Klaus',
    userName: '小林',
  })
  addMockReferenceAudio({
    audioKind: 'bgm',
    bpm: 96,
    description: '指弹原声吉他，中频留白克制，与人声叠加不打架',
    durationMs: 30_000,
    genre: 'acoustic',
    mood: 'warm',
    peaks: demoPeaks(41, music),
    title: '轻快原声吉他',
    url: `${MOCK_MUSIC_URL}?library=guitar`,
  })
  addMockReferenceAudio({
    audioKind: 'bgm',
    bpm: 122,
    description: '利落的现代鼓点与合成贝斯，卡点清晰，适合城市夜景',
    durationMs: 30_000,
    genre: 'electronic',
    mood: 'relaxed',
    peaks: demoPeaks(53, music),
    title: '城市夜景氛围',
    url: `${MOCK_MUSIC_URL}?library=night`,
    userName: '小林',
  })
  addMockReferenceAudio({
    audioKind: 'sfx',
    description: '干脆的纸张翻页，适合图文切换',
    peaks: demoPeaks(67, transient),
    sfxCategory: 'transition',
    title: '翻页声',
    userName: '小林',
  })
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

const tempoOf = (bpm: number | null) =>
  bpm === null ? null : bpm < 90 ? 'slow' : bpm > 120 ? 'fast' : 'medium'

/** 同一参数（可重复）任一命中，没给就不筛。 */
const anyOf = (query: URLSearchParams, key: string, actual: readonly (string | null)[]) => {
  const wanted = query.getAll(key)
  return wanted.length === 0 || wanted.some((each) => actual.includes(each))
}

const matches = (row: Row, query: URLSearchParams) => {
  const kind = query.get('audioKind')
  const userName = query.get('userName')
  const keyword = query.get('q')
  return (
    (kind === null || row.audioKind === kind) &&
    anyOf(query, 'locale', [row.locale ?? 'none']) &&
    anyOf(query, 'gender', [row.gender]) &&
    anyOf(query, 'age', [row.age]) &&
    anyOf(query, 'scenario', row.scenarios) &&
    anyOf(query, 'mood', [row.mood]) &&
    anyOf(query, 'genre', [row.genre]) &&
    anyOf(query, 'tempo', [tempoOf(row.bpm)]) &&
    anyOf(query, 'sfxCategory', [row.sfxCategory]) &&
    (userName === null || row.userName === userName) &&
    (keyword === null ||
      [row.title, row.description, row.transcript].some((text) => text?.includes(keyword)))
  )
}

/** 各项属性（连同台词、语种）属于哪个子类：跨子类填了答 422。 */
const TRAIT_KIND = {
  age: 'voice',
  bpm: 'bgm',
  gender: 'voice',
  genre: 'bgm',
  locale: 'voice',
  mood: 'bgm',
  scenarios: 'voice',
  sfxCategory: 'sfx',
  transcript: 'voice',
} as const satisfies Record<string, AudioKind>

const strayTrait = (kind: AudioKind, fields: object) => {
  const values = new Map<string, unknown>(Object.entries(fields))
  return Object.entries(TRAIT_KIND).find(([key, owner]) => {
    const value = values.get(key)
    return owner !== kind && value != null && !(Array.isArray(value) && value.length === 0)
  })?.[0]
}

const STRAY = (key: string) =>
  HttpResponse.json({ detail: `这一子类不能填 ${key}` }, { status: 422 })

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
    const stray = strayTrait(body.audioKind, body)
    if (stray !== undefined) return STRAY(stray)
    const now = new Date().toISOString()
    seq += 1
    const row: Row = {
      age: body.age ?? null,
      audioKind: body.audioKind,
      bpm: body.bpm ?? null,
      createdAt: now,
      description: body.description ?? null,
      durationMs: MEASURED_MS,
      gender: body.gender ?? null,
      genre: body.genre ?? null,
      id: idOf(1000 + seq),
      locale: body.locale ?? null,
      mood: body.mood ?? null,
      peaks: MEASURED_PEAKS,
      removed: false,
      scenarios: body.scenarios ?? [],
      sfxCategory: body.sfxCategory ?? null,
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
    if (body.gender !== undefined) next.gender = body.gender
    if (body.age !== undefined) next.age = body.age
    if (body.scenarios !== undefined) next.scenarios = body.scenarios ?? []
    if (body.mood !== undefined) next.mood = body.mood
    if (body.genre !== undefined) next.genre = body.genre
    if (body.bpm !== undefined) next.bpm = body.bpm
    if (body.sfxCategory !== undefined) next.sfxCategory = body.sfxCategory
    const stray = strayTrait(next.audioKind, next)
    if (stray !== undefined) return STRAY(stray)
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

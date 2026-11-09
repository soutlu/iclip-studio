import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zReferenceFiltersOut,
  zReferenceTagsIn,
  zReferenceUpdateIn,
  zReferenceVideoOut,
} from '@/shared/api/generated/zod.gen'
// ?no-inline 阻止 Vite 将小体积媒体资源内联为 data URI。
import sampleWideUrl from '../fixtures/sample-video-wide.mp4?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.mp4?no-inline'
import { mockAuthUser } from './auth-user'
import {
  findMockTagId,
  isMockAiTag,
  isMockTagValue,
  mockTagId,
  mockTagMatcher,
} from './library-tags'
import { pageBy } from './paging'
import { mockConfirmedUpload } from './uploads'

type Reference = z.output<typeof zReferenceVideoOut>
type TestVideo = NonNullable<Reference['testVideo']>
type Filters = z.output<typeof zReferenceFiltersOut>

const tagIdsOf = (...names: string[]) => names.map(mockTagId)

const DEMO_AI_TAGS = ['拖鞋', '居家/日常放松', '标准开箱流程'] as const

const DEMO_DOCUMENT = `# 出场元素

| 类型 | 名字 | 辨识特征 | 首次出现 |
| :--- | :--- | :--- | :--- |
| 人物 | 金色短发女生 | 二十岁出头的白人女性。齐下巴的金色波波头，淡妆。身材纤细。上身一件宽大的宝蓝色 1 号球衣，里面叠一件白色长袖，下身深色阔腿牛仔裤，脖子上围一条黑色高领。 | 0.0 |
| 产品 | 厚底毛口拖鞋 | 一双浅卡其色麂皮厚底拖鞋。鞋口一圈米白色卷毛，鞋底约四厘米厚，侧面压着一条细缝线。 | 2.4 |
| 场景 | 滑板公园 | 城市里一座露天滑板公园。地面是涂满涂鸦的水泥碗池，围着铁丝网，网外是一排棕榈树。 | 0.0 |

# 时间线

## 0.0-6.8 · 场景引入

### 镜 01 · 0.0-2.4

**镜头语言**：开场，手持，平视全景，缓慢推近
**画面**：金色短发女生站在涂鸦墙前，右手扶着竖起的滑板，左手插在裤兜里。她把滑板往身前一放，抬头看向镜头。
**BGM**：一首中速的电子流行乐，女声用英文演唱
**音效**：\`1.2 滑板轮子落地的咔哒声\`
**包装**：无
**关键帧**：0.4

### 镜 02 · 2.4-6.8

**镜头语言**：硬切，低机位，固定，脚部特写
**画面**：她的右脚踩上滑板，厚底毛口拖鞋正对镜头，鞋口的卷毛被风吹得轻轻抖动。她用脚尖把滑板往前推了半圈。
**BGM**：同上
**音效**：无
**包装**：\`3.0-5.5 画面右下角的白色小字：「Cozy all day」，淡入淡出\`
**关键帧**：2.9

# 整片分析

## 想达到什么

看完记得这双拖鞋能穿出门，也能踩滑板。

## 故事和节奏

先给人，再给脚。前半段慢，换到脚部特写后切得快。
`

const LONG_DOCUMENT = `${DEMO_DOCUMENT}
## 备注

${'这一段是很长的中文说明没有任何空格用来检查拆解正文在窄屏和宽屏下都能正常折行不会把右栏撑破也不会出现横向滚动条'.repeat(4)}

| 类型 | 名字 | 辨识特征 |
| :--- | :--- | :--- |
| 产品 | 加长款超厚底麂皮毛口一脚蹬拖鞋（秋冬限定配色·燕麦奶茶色·鞋口加宽版） | ${'鞋面是燕麦色麂皮，鞋口一圈加厚的米白色卷毛，'.repeat(3)} |
`

const HOUR_MS = 60 * 60_000

const PENDING_MS = 1500
const SETTLE_MS = 4000

const TAG_PENDING_MS = 1000
const TAG_SETTLE_MS = 2500

const TEST_SETTLE_MS = 5000

type Row = Reference & {
  removed: boolean
  contentKey: string | null
  queuedAt: number | null
  tagQueuedAt: number | null
  testQueuedAt: number | null
}

const rows: Row[] = []
let seq = 0

const idOf = (n: number) => `5ef00000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const addMockReference = (overrides: Partial<Reference> = {}): Reference => {
  seq += 1
  const at = new Date(Date.now() - seq * 60_000).toISOString()
  const row: Row = {
    breakdownStatus: 'completed',
    canEdit: true,
    contentKey: null,
    createdAt: at,
    document: DEMO_DOCUMENT,
    errorCode: null,
    id: idOf(seq),
    queuedAt: null,
    removed: false,
    tagError: null,
    tagIds: [],
    tagQueuedAt: null,
    tagStatus: overrides.document === null ? null : 'completed',
    testQueuedAt: null,
    testVideo: null,
    updatedAt: at,
    userName: mockAuthUser.username,
    version: 1,
    videoUrl: sampleVideoUrl,
    ...overrides,
  }
  rows.push(row)
  return publicOf(row, row.userName ?? '')
}

const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString()

const demoTestVideo = (overrides: Partial<TestVideo>): TestVideo => ({
  createdAt: ago(1),
  errorMessage: null,
  stale: false,
  status: 'completed',
  url: null,
  ...overrides,
})

const seedDemo = () => {
  const me = mockAuthUser.username
  const demo: Partial<Reference>[] = [
    { breakdownStatus: 'pending', createdAt: ago(0.005), document: null, userName: me },
    { breakdownStatus: 'running', createdAt: ago(0.02), document: null, userName: me },
    {
      breakdownStatus: 'failed',
      createdAt: ago(0.13),
      document: null,
      errorCode: 'video_unreadable',
      userName: me,
      videoUrl: sampleWideUrl,
    },
    {
      createdAt: ago(0.2),
      tagIds: tagIdsOf('TikTok', '短靴', '卫衣', '裤子', '户外/公园散步', '动态上身展示'),
      userName: me,
    },
    {
      createdAt: ago(2),
      tagIds: tagIdsOf('拖鞋', '居家/日常放松', '标准开箱流程', '360°全景展示'),
      testVideo: demoTestVideo({ url: sampleVideoUrl }),
      userName: 'Maya.Cheng',
    },
    {
      breakdownStatus: 'failed',
      createdAt: ago(5),
      errorCode: 'model_call_failed',
      tagIds: tagIdsOf('拖鞋', '开箱测评型'),
      testVideo: demoTestVideo({ createdAt: ago(42 / 3600), status: 'running' }),
      userName: me,
    },
    {
      createdAt: ago(26),
      tagIds: tagIdsOf('AMZ', '短靴'),
      tagStatus: 'running',
      userName: 'Sara.Hong',
      videoUrl: sampleWideUrl,
    },
    {
      createdAt: ago(30),
      tagIds: tagIdsOf('拖鞋', '图文幻灯片'),
      userName: 'Nora.Ho',
    },
    {
      createdAt: ago(50),
      tagError: 'model_call_failed',
      tagIds: tagIdsOf('DTC'),
      tagStatus: 'failed',
      testVideo: demoTestVideo({ url: sampleWideUrl }),
      userName: me,
      videoUrl: sampleWideUrl,
    },
    {
      createdAt: ago(75),
      tagIds: tagIdsOf('板鞋', 'T恤', '通勤/长时间站立', '专家评测解说'),
      userName: 'Maya.Cheng',
    },
    {
      createdAt: ago(100),
      document: LONG_DOCUMENT,
      tagIds: tagIdsOf(
        'INS',
        'ADS',
        '穆勒鞋',
        '凉拖鞋',
        '平底鞋',
        '乐福鞋',
        '雪地靴',
        '外套',
        '居家/日常放松',
        '动态场景跟拍',
        '多场景快速切换',
        '痛点解决方案',
      ),
      testVideo: demoTestVideo({ stale: true, url: sampleVideoUrl }),
      userName: me,
    },
    { createdAt: ago(120), tagIds: [], tagStatus: 'pending', userName: 'Sara.Hong' },
    {
      createdAt: ago(170),
      tagIds: tagIdsOf('拖鞋', '产品展示型'),
      testVideo: demoTestVideo({
        errorMessage: '视频时长 45 秒，超出模型支持的时长',
        status: 'failed',
      }),
      userName: me,
    },
  ]
  for (const overrides of demo)
    addMockReference({ updatedAt: overrides.createdAt ?? ago(0), ...overrides })
}

export const resetMockReferences = (seed?: readonly Partial<Reference>[]) => {
  rows.length = 0
  seq = 0
  if (seed === undefined) seedDemo()
  else for (const overrides of seed) addMockReference(overrides)
}

const markTestStale = (row: Row) => {
  if (row.testVideo !== null) row.testVideo = { ...row.testVideo, stale: true }
}

const advance = (row: Row, now: number) => {
  if (
    row.testQueuedAt !== null &&
    row.testVideo !== null &&
    now - row.testQueuedAt >= TEST_SETTLE_MS
  ) {
    row.testVideo = { ...row.testVideo, status: 'completed', url: row.videoUrl }
    row.testQueuedAt = null
  }
  if (row.queuedAt !== null) {
    const elapsed = now - row.queuedAt
    if (elapsed < PENDING_MS) row.breakdownStatus = 'pending'
    else if (elapsed < SETTLE_MS) row.breakdownStatus = 'running'
    else {
      Object.assign(row, {
        breakdownStatus: 'completed',
        document: DEMO_DOCUMENT,
        errorCode: null,
        queuedAt: null,
        tagQueuedAt: row.queuedAt + SETTLE_MS,
        tagStatus: 'pending',
        updatedAt: new Date(now).toISOString(),
        version: row.version + 1,
      } satisfies Partial<Row>)
      markTestStale(row)
    }
  }
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
  for (const row of rows) advance(row, now)
  return rows.filter((row) => !row.removed)
}

const publicOf = (row: Row, viewer: string): Reference => {
  const {
    removed: _removed,
    contentKey: _contentKey,
    queuedAt: _queuedAt,
    tagQueuedAt: _tagQueuedAt,
    testQueuedAt: _testQueuedAt,
    ...reference
  } = row
  return { ...reference, canEdit: row.userName === viewer, tagIds: [...row.tagIds] }
}

const find = (id: unknown) => live().find((row) => row.id === id)

export const mockReferenceTagSets = (): string[][] => live().map((row) => row.tagIds)

export const forgetMockReferenceTags = (ids: ReadonlySet<string>) => {
  for (const row of rows) row.tagIds = row.tagIds.filter((id) => !ids.has(id))
}

const NOT_FOUND = () => HttpResponse.json({ detail: '资料库里没有这条参考视频' }, { status: 404 })

const NOT_FILE_BYTES = new Set(['', 'undefined', '[object File]'])

const fingerprint = (body: ArrayBuffer): string | null => {
  if (NOT_FILE_BYTES.has(new TextDecoder().decode(body))) return null
  let hash = 0x811c9dc5
  for (const byte of new Uint8Array(body)) hash = Math.imul(hash ^ byte, 0x01000193)
  return `${body.byteLength}:${(hash >>> 0).toString(16)}`
}

const matches = (
  row: Row,
  query: URLSearchParams,
  tagMatch: (tagIds: readonly string[]) => boolean,
): boolean => {
  const userName = query.get('userName')
  const since = query.get('since')
  const until = query.get('until')
  const q = query.get('q')?.trim().toLowerCase()
  const at = Date.parse(row.createdAt)
  return (
    tagMatch(row.tagIds) &&
    (userName === null || row.userName === userName) &&
    (since === null || at >= Date.parse(since)) &&
    (until === null || at < Date.parse(until)) &&
    (q === undefined || q === '' || (row.document ?? '').toLowerCase().includes(q))
  )
}

const filtersOf = (all: readonly Row[]): Filters => {
  const ownerCounts = new Map<string, number>()
  for (const row of all) {
    if (row.userName !== null)
      ownerCounts.set(row.userName, (ownerCounts.get(row.userName) ?? 0) + 1)
  }
  return {
    owners: [...ownerCounts]
      .map(([userName, count]) => ({ count, userName }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName)),
  }
}

const isBusy = (row: Row) => row.breakdownStatus === 'pending' || row.breakdownStatus === 'running'
const isTagBusy = (row: Row) => row.tagStatus === 'pending' || row.tagStatus === 'running'

export const referenceHandlers = (viewer: () => string) => [
  http.get('*/api/references', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('cursor')
    const tagMatch = mockTagMatcher(query.getAll('tags'))
    if (tagMatch === null)
      return HttpResponse.json({ detail: [{ msg: '没有这个标签' }] }, { status: 422 })
    const all = live().filter((row) => matches(row, query, tagMatch))
    const page = pageBy(
      all,
      (row) => [row.createdAt, row.id],
      cursor,
      Number(query.get('limit') ?? 20),
    )
    return HttpResponse.json({
      canUpload: true,
      items: page.items.map((row) => {
        const { document: _document, testVideo: _testVideo, ...item } = publicOf(row, viewer())
        return item
      }),
      nextCursor: page.nextCursor,
      total: cursor === null ? all.length : null,
    })
  }),

  http.get('*/api/references/filters', () => HttpResponse.json(filtersOf(live()))),

  http.post('*/api/references', async ({ request }) => {
    const { uploadId } = (await request.json()) as { uploadId: string }
    const upload = mockConfirmedUpload(uploadId)
    if (upload === undefined || !upload.contentType.startsWith('video/'))
      return HttpResponse.json({ detail: '没有这次视频上传' }, { status: 404 })
    const contentKey = upload.body === undefined ? null : fingerprint(upload.body)
    const existing = rows.find((row) => contentKey !== null && row.contentKey === contentKey)
    if (existing !== undefined) {
      existing.removed = false
      return HttpResponse.json(publicOf(existing, viewer()), { status: 200 })
    }
    const now = new Date().toISOString()
    seq += 1
    const row: Row = {
      breakdownStatus: 'pending',
      canEdit: true,
      contentKey,
      createdAt: now,
      document: null,
      errorCode: null,
      id: idOf(1000 + seq),
      queuedAt: Date.now(),
      removed: false,
      tagError: null,
      tagIds: [],
      tagQueuedAt: null,
      tagStatus: null,
      testQueuedAt: null,
      testVideo: null,
      updatedAt: now,
      userName: viewer(),
      version: 1,
      videoUrl: upload.url,
    }
    rows.push(row)
    return HttpResponse.json(publicOf(row, viewer()), { status: 201 })
  }),

  http.get('*/api/references/:id', ({ params }) => {
    const row = find(params['id'])
    return row === undefined ? NOT_FOUND() : HttpResponse.json(publicOf(row, viewer()))
  }),

  http.patch('*/api/references/:id', async ({ params, request }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能改' }, { status: 403 })
    const body = (await request.json()) as z.input<typeof zReferenceUpdateIn>
    if (body.document.trim() === '')
      return HttpResponse.json({ detail: [{ msg: '拆解不能为空' }] }, { status: 422 })
    if (body.version !== row.version || isBusy(row))
      return HttpResponse.json({ detail: '这条参考视频已经变了' }, { status: 409 })
    if (body.document !== row.document) markTestStale(row)
    Object.assign(row, {
      document: body.document,
      updatedAt: new Date().toISOString(),
      version: row.version + 1,
    } satisfies Partial<Row>)
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.put('*/api/references/:id/tags', async ({ params, request }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能改标签' }, { status: 403 })
    const { tagIds } = (await request.json()) as z.input<typeof zReferenceTagsIn>
    if (!tagIds.every(isMockTagValue))
      return HttpResponse.json({ detail: [{ msg: '没有这个标签' }] }, { status: 422 })
    if (isTagBusy(row)) return HttpResponse.json({ detail: '正在打标' }, { status: 409 })
    row.tagIds = [...new Set(tagIds)]
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.post('*/api/references/:id/tagging', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能重新打标' }, { status: 403 })
    if (isBusy(row) || row.document === null)
      return HttpResponse.json({ detail: '拆解尚未完成，无法重新打标' }, { status: 409 })
    if (isTagBusy(row)) return HttpResponse.json({ detail: '正在打标' }, { status: 409 })
    Object.assign(row, { tagQueuedAt: Date.now(), tagStatus: 'pending' } satisfies Partial<Row>)
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.post('*/api/references/:id/breakdowns', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能重拆' }, { status: 403 })
    if (isBusy(row)) return HttpResponse.json({ detail: '正在拆解' }, { status: 409 })
    Object.assign(row, { breakdownStatus: 'pending', queuedAt: Date.now() } satisfies Partial<Row>)
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.post('*/api/references/:id/test-generations', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (!publicOf(row, viewer()).canEdit)
      return HttpResponse.json(
        { detail: '只有它的属主或治理者能试生成这条参考视频' },
        { status: 403 },
      )
    if (isBusy(row) || row.document === null)
      return HttpResponse.json({ detail: '拆解尚未完成' }, { status: 409 })
    if (row.testVideo?.status === 'running')
      return HttpResponse.json({ detail: '上一次试生成尚未结束' }, { status: 409 })
    row.testQueuedAt = Date.now()
    row.testVideo = {
      createdAt: new Date().toISOString(),
      errorMessage: null,
      stale: false,
      status: 'running',
      url: null,
    }
    return HttpResponse.json(publicOf(row, viewer()))
  }),

  http.delete('*/api/references/:id', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能移除' }, { status: 403 })
    row.removed = true
    return new HttpResponse(null, { status: 204 })
  }),
]

resetMockReferences()

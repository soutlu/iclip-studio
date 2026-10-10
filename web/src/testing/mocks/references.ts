/** 参考视频的 mock：内存里的一张表，筛选、翻页、改、重拆与移除照合同 §14 做。
 *
 * 上传建的行和重拆的行按时间往前走：先排队，过一会儿拆解中，再过一会儿拆完（带演示拆解与标签），
 * dev:mock 下轮询看得见状态变化。同一份文件内容再传一次交回原来那一行（200）。
 * 演示行覆盖各种状态：拆完的、没标签的、排队与拆解中的、没拆成的（有无上一次拆解）、别人的。
 * 单测要断言具体内容就先 `resetMockReferences([])` 再用 `addMockReference` 放自己的行。 */

import { http, HttpResponse } from 'msw'
import type { z } from 'zod'
import type {
  zReferenceFiltersOut,
  zReferenceUpdateIn,
  zReferenceVideoOut,
} from '@/shared/api/generated/zod.gen'
// no-inline：地址要进 <video src>，不能被构建内联成 data URI。
import sampleWideUrl from '../fixtures/sample-video-wide.mp4?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.mp4?no-inline'
import { mockAuthUser } from './auth-user'
import { pageBy } from './paging'
import { mockConfirmedUpload } from './uploads'

type Reference = z.output<typeof zReferenceVideoOut>
type VideoType = Reference['videoTypes'][number]
type Category = Reference['categories'][number]
type Filters = z.output<typeof zReferenceFiltersOut>

/** 片子类型的名称与判断说明，按合同清单的先后。 */
const VIDEO_TYPES: readonly { value: VideoType; label: string; rule: string }[] = [
  { label: '直播切片', rule: '画面来自直播间，主播在直播布景前讲', value: 'live_clip' },
  { label: '图文混剪', rule: '由图片、零散素材拼成，或是动画、三维渲染', value: 'slideshow' },
  { label: '剧情', rule: '有角色和情节，人物之间的互动推着故事往前走', value: 'drama' },
  { label: '开箱测评', rule: '拆包装上手，或在片中做测试、对比', value: 'review' },
  { label: '口播', rule: '有人对着镜头讲，说话占了大部分时长', value: 'talking_head' },
  { label: '上身展示', rule: '模特穿上或戴上产品，展示上身效果', value: 'try_on' },
  { label: '场景种草', rule: '人物在生活场景里自然地使用产品，不对着镜头讲解', value: 'lifestyle' },
  { label: '产品展示', rule: '产品本身是主体，拍特写、细节、功能', value: 'product_showcase' },
]

/** 品类清单的先后：条数相同时按它排。只列演示里会出现的几个，其余排在后面。 */
const CATEGORY_ORDER: readonly Category[] = [
  '平底鞋',
  '乐福鞋',
  '穆勒鞋',
  '拖鞋',
  '短靴',
  '凉拖鞋',
  '板鞋',
  '雪地靴',
  'T恤',
  '卫衣',
  '外套',
  '裤子',
]

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

/** 中文长内容：一段很长、不带空格的说明，验折行。 */
const LONG_DOCUMENT = `${DEMO_DOCUMENT}
## 备注

${'这一段是很长的中文说明没有任何空格用来检查拆解正文在窄屏和宽屏下都能正常折行不会把右栏撑破也不会出现横向滚动条'.repeat(4)}

| 类型 | 名字 | 辨识特征 |
| :--- | :--- | :--- |
| 产品 | 加长款超厚底麂皮毛口一脚蹬拖鞋（秋冬限定配色·燕麦奶茶色·鞋口加宽版） | ${'鞋面是燕麦色麂皮，鞋口一圈加厚的米白色卷毛，'.repeat(3)} |
`

const HOUR_MS = 60 * 60_000

/** 上传或重拆之后多久进拆解中、多久拆完。 */
const PENDING_MS = 1500
const SETTLE_MS = 4000

type Row = Reference & {
  removed: boolean
  /** 上传字节的指纹；同样的内容再传一次认出是同一条。演示行没有。 */
  contentKey: string | null
  /** 后台拆解的进度：什么时候排进去的。没有就是静止的演示行。 */
  queuedAt: number | null
}

const rows: Row[] = []
let seq = 0

const idOf = (n: number) => `5ef00000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** 一行参考视频；没给的字段按「拆完、有演示拆解、属主是测试用户」补。 */
export const addMockReference = (overrides: Partial<Reference> = {}): Reference => {
  seq += 1
  const at = new Date(Date.now() - seq * 60_000).toISOString()
  const row: Row = {
    breakdownStatus: 'completed',
    canEdit: true,
    categories: [],
    contentKey: null,
    createdAt: at,
    document: DEMO_DOCUMENT,
    errorCode: null,
    id: idOf(seq),
    queuedAt: null,
    removed: false,
    testVideo: null,
    updatedAt: at,
    userName: mockAuthUser.username,
    version: 1,
    videoTypes: [],
    videoUrl: sampleVideoUrl,
    ...overrides,
  }
  rows.push(row)
  return publicOf(row, row.userName ?? '')
}

const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString()

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
      categories: ['短靴', '卫衣', '裤子'],
      createdAt: ago(0.2),
      userName: me,
      videoTypes: ['try_on'],
    },
    {
      categories: ['拖鞋'],
      createdAt: ago(2),
      userName: 'Maya.Cheng',
      videoTypes: ['review', 'product_showcase'],
    },
    {
      breakdownStatus: 'failed',
      categories: ['拖鞋'],
      createdAt: ago(5),
      errorCode: 'model_call_failed',
      userName: me,
      videoTypes: ['review', 'product_showcase'],
    },
    {
      categories: ['短靴'],
      createdAt: ago(26),
      userName: 'Sara.Hong',
      videoTypes: ['lifestyle'],
      videoUrl: sampleWideUrl,
    },
    { categories: ['拖鞋'], createdAt: ago(30), userName: 'Nora.Ho', videoTypes: ['slideshow'] },
    { createdAt: ago(50), userName: me },
    {
      categories: ['板鞋', 'T恤'],
      createdAt: ago(75),
      userName: 'Maya.Cheng',
      videoTypes: ['talking_head', 'try_on'],
    },
    {
      categories: ['穆勒鞋', '凉拖鞋', '平底鞋', '乐福鞋', '雪地靴', '外套'],
      createdAt: ago(100),
      document: LONG_DOCUMENT,
      userName: me,
      videoTypes: ['try_on', 'lifestyle', 'talking_head', 'product_showcase'],
    },
    { categories: ['穆勒鞋'], createdAt: ago(120), userName: 'Sara.Hong', videoTypes: ['try_on'] },
    { categories: ['拖鞋'], createdAt: ago(170), userName: me, videoTypes: ['product_showcase'] },
  ]
  for (const overrides of demo)
    addMockReference({ updatedAt: overrides.createdAt ?? ago(0), ...overrides })
}

/** 每例清空后放回演示行；给了 `seed` 就换成这些行（空数组即空表）。 */
export const resetMockReferences = (seed?: readonly Partial<Reference>[]) => {
  rows.length = 0
  seq = 0
  if (seed === undefined) seedDemo()
  else for (const overrides of seed) addMockReference(overrides)
}

/** 按时间推进后台拆解：排队 → 拆解中 → 拆完，拆完写回演示拆解与标签、版本加一。 */
const advance = (row: Row, now: number) => {
  if (row.queuedAt === null) return
  const elapsed = now - row.queuedAt
  if (elapsed < PENDING_MS) row.breakdownStatus = 'pending'
  else if (elapsed < SETTLE_MS) row.breakdownStatus = 'running'
  else {
    Object.assign(row, {
      breakdownStatus: 'completed',
      categories: ['拖鞋'],
      document: DEMO_DOCUMENT,
      errorCode: null,
      queuedAt: null,
      updatedAt: new Date(now).toISOString(),
      version: row.version + 1,
      videoTypes: ['review', 'product_showcase'],
    } satisfies Partial<Row>)
  }
}

const live = (): Row[] => {
  const now = Date.now()
  for (const row of rows) advance(row, now)
  return rows.filter((row) => !row.removed)
}

/** 交出去的样子：去掉 mock 自己的字段，`canEdit` 按此刻登录的人算。 */
const publicOf = (row: Row, viewer: string): Reference => {
  const { removed: _removed, contentKey: _contentKey, queuedAt: _queuedAt, ...reference } = row
  return { ...reference, canEdit: row.userName === viewer }
}

const find = (id: unknown) => live().find((row) => row.id === id)

const NOT_FOUND = () => HttpResponse.json({ detail: '资料库里没有这条参考视频' }, { status: 404 })

/** jsdom 的 XHR 发 File 时带不上文件内容，收到的是这几个字面量之一。 */
const NOT_FILE_BYTES = new Set(['', 'undefined', '[object File]'])

/** 字节的简单指纹：长度加 FNV-1a，够 mock 认出同一个文件。收到的不是文件内容（jsdom）就认不出来、当新文件；
 * 单测要重复上传的答复用 `server.use` 给。 */
const fingerprint = (body: ArrayBuffer): string | null => {
  if (NOT_FILE_BYTES.has(new TextDecoder().decode(body))) return null
  let hash = 0x811c9dc5
  for (const byte of new Uint8Array(body)) hash = Math.imul(hash ^ byte, 0x01000193)
  return `${body.byteLength}:${(hash >>> 0).toString(16)}`
}

const matches = (row: Row, query: URLSearchParams): boolean => {
  const types = query.getAll('videoTypes')
  const categories = query.getAll('categories')
  const userName = query.get('userName')
  const since = query.get('since')
  const until = query.get('until')
  const q = query.get('q')?.trim().toLowerCase()
  const at = Date.parse(row.createdAt)
  return (
    (types.length === 0 || row.videoTypes.some((type) => types.includes(type))) &&
    (categories.length === 0 || row.categories.some((name) => categories.includes(name))) &&
    (userName === null || row.userName === userName) &&
    (since === null || at >= Date.parse(since)) &&
    (until === null || at < Date.parse(until)) &&
    (q === undefined || q === '' || (row.document ?? '').toLowerCase().includes(q))
  )
}

const filtersOf = (all: readonly Row[]): Filters => {
  const typeCounts = new Map<VideoType, number>()
  const categoryCounts = new Map<Category, number>()
  for (const row of all) {
    for (const type of row.videoTypes) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    for (const name of row.categories) categoryCounts.set(name, (categoryCounts.get(name) ?? 0) + 1)
  }
  const ownerCounts = new Map<string, number>()
  for (const row of all) {
    if (row.userName !== null)
      ownerCounts.set(row.userName, (ownerCounts.get(row.userName) ?? 0) + 1)
  }
  const orderOf = (name: Category) => {
    const index = CATEGORY_ORDER.indexOf(name)
    return index < 0 ? CATEGORY_ORDER.length : index
  }
  return {
    categories: [...categoryCounts]
      .map(([name, count]) => ({ count, name }))
      .sort((a, b) => b.count - a.count || orderOf(a.name) - orderOf(b.name)),
    owners: [...ownerCounts]
      .map(([userName, count]) => ({ count, userName }))
      .sort((a, b) => b.count - a.count || a.userName.localeCompare(b.userName)),
    videoTypes: VIDEO_TYPES.map((type) => ({ ...type, count: typeCounts.get(type.value) ?? 0 })),
  }
}

const isBusy = (row: Row) => row.breakdownStatus === 'pending' || row.breakdownStatus === 'running'

/** `viewer` 给出此刻登录的用户名：属主才能改、重拆、移除。 */
export const referenceHandlers = (viewer: () => string) => [
  http.get('*/api/references', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('cursor')
    const all = live().filter((row) => matches(row, query))
    const page = pageBy(
      all,
      (row) => [row.createdAt, row.id],
      cursor,
      Number(query.get('limit') ?? 20),
    )
    return HttpResponse.json({
      canUpload: true,
      items: page.items.map((row) => {
        const { document: _document, ...item } = publicOf(row, viewer())
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
      categories: [],
      contentKey,
      createdAt: now,
      document: null,
      errorCode: null,
      id: idOf(1000 + seq),
      queuedAt: Date.now(),
      removed: false,
      testVideo: null,
      updatedAt: now,
      userName: viewer(),
      version: 1,
      videoTypes: [],
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
    Object.assign(row, {
      categories: [...new Set(body.categories)],
      document: body.document,
      updatedAt: new Date().toISOString(),
      version: row.version + 1,
      videoTypes: [...new Set(body.videoTypes)],
    } satisfies Partial<Row>)
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

  http.delete('*/api/references/:id', ({ params }) => {
    const row = find(params['id'])
    if (row === undefined) return NOT_FOUND()
    if (row.userName !== viewer())
      return HttpResponse.json({ detail: '只有属主能移除' }, { status: 403 })
    row.removed = true
    return new HttpResponse(null, { status: 204 })
  }),
]

// 模块载入时放好演示行；单测每例之后由 setup 再放一次。
resetMockReferences()

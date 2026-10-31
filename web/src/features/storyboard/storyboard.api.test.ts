import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import {
  generationsRefetchInterval,
  historyShotOf,
  readConversationVideoJobs,
  type GenerationJob,
} from './storyboard.api'

const conversationId = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

describe('historyShotOf', () => {
  const job = (request: Record<string, unknown>): GenerationJob =>
    makeGenerationJob({
      createdAt: '2026-09-01T10:00:00Z',
      id: 'e5b1c0de-6c1e-4f1a-9b3d-8c0a1f2e3d40',
      shotIndex: 2,
      request,
    })

  it('记录里的 shot 与分镜文件的 prompt 同形，起止秒与间隙原样取回', () => {
    const history = {
      global_settings: '设定。',
      timeline: [
        { timestamps: [0, 3.5], prompt: '一。', image_indexes: [] },
        { timestamps: [4.25, 8.5], prompt: '二 @Image1。', image_indexes: [1] },
      ],
    }
    expect(historyShotOf(job({ prompt: '拼好的正文', shot: history }))).toEqual(history)
  })

  it.each([
    ['只有正文', { prompt: '模特走向镜头，停下微笑。' }],
    ['shot 为空', { prompt: '正文', shot: null }],
    ['shot 缺时间线', { prompt: '正文', shot: { global_settings: '设定。', timeline: [] } }],
    [
      'timestamps 不是一对秒数',
      {
        shot: {
          global_settings: '设定。',
          timeline: [{ image_indexes: [], prompt: '一。', timestamps: [3] }],
        },
      },
    ],
  ])('%s 的记录回填不了', (_name, request) => {
    expect(historyShotOf(job(request))).toBeUndefined()
  })
})

describe('readConversationVideoJobs', () => {
  const fullPage = () => Array.from({ length: 100 }, () => makeGenerationJob())

  it.each<[string, GenerationJob[]]>([
    ['空页', []],
    ['不满一页的短页', Array.from({ length: 3 }, () => makeGenerationJob())],
  ])('按上一页最后一条往前翻，末页是%s时停下，按页序拼起全部记录', async (_name, lastPage) => {
    const pages = [fullPage(), fullPage(), lastPage]
    const requests: Record<string, string>[] = []
    server.use(
      http.get('*/api/generations', ({ request }) => {
        requests.push(Object.fromEntries(new URL(request.url).searchParams))
        // 多取的一页给空，让多发的请求由 requests 断言暴露，而不是先撞上 zod 校验。
        return HttpResponse.json({ items: pages[requests.length - 1] ?? [] })
      }),
    )

    const jobs = await readConversationVideoJobs(conversationId, new AbortController().signal)

    expect(jobs.map((job) => job.id)).toEqual(pages.flat().map((job) => job.id))
    expect(requests).toEqual([
      { conversationId, kind: 'video', limit: '100' },
      { conversationId, kind: 'video', limit: '100', before: pages[0]?.at(-1)?.id },
      { conversationId, kind: 'video', limit: '100', before: pages[1]?.at(-1)?.id },
    ])
  })

  it('游标原地不动时报分页异常，不无限翻页', async () => {
    const page = fullPage()
    let reads = 0
    server.use(
      http.get('*/api/generations', () => {
        reads += 1
        return HttpResponse.json({ items: page })
      }),
    )

    await expect(
      readConversationVideoJobs(conversationId, new AbortController().signal),
    ).rejects.toThrow('读取视频记录失败：分页异常，请重试')
    expect(reads).toBe(2)
  })
})

describe('generationsRefetchInterval', () => {
  it('有任务还在飞就定时再问一次', () => {
    expect(generationsRefetchInterval([{ status: 'completed' }, { status: 'submitted' }])).toBe(
      5000,
    )
    expect(generationsRefetchInterval([{ status: 'pending' }])).toBe(5000)
  })

  it('全落定了、或者一条都没有就不问', () => {
    expect(generationsRefetchInterval([{ status: 'completed' }, { status: 'failed' }])).toBe(false)
    expect(generationsRefetchInterval([])).toBe(false)
  })
})

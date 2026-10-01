import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { generationsRefetchInterval } from '../storyboard.api'
import {
  compileEditRequest,
  imageEditConversationKey,
  imageEditJobsRefetchInterval,
  imageEditQueryKey,
  resolveImageOptions,
  restoreEditParts,
  seedImageEditJob,
  submitImageEdit,
  useFrameImageJobs,
  useImageEditJobs,
} from './image-edit.api'
import type { ImageModel } from './image-edit.api'
import type { EditDraftPart, FrameEditTarget } from './image-edit-types'

const BASE = 'https://cdn.test/frame.png'
const ANNOTATED = 'https://cdn.test/annotated.png'
const JACKET = 'https://cdn.test/jacket.png'
const SHOE = 'https://cdn.test/shoe.png'
const NOTICE = '\n图中的编号和圈选只表示位置，输出干净的图片，不保留标注。'
const text = (value: string): EditDraftPart => ({ kind: 'text', text: value })
const image = (url: string, name = 'x.png'): EditDraftPart => ({ kind: 'image', name, url })
const mark = (id: string, number: number): EditDraftPart => ({ kind: 'annotation', id, number })
/** 画布上当前的编号：a1 后来成了 3 号（编号以画布为准，不看 chip 里记的）。 */
const numberOf = (id: string) => ({ a1: 3, a2: 2 })[id]

describe('compileEditRequest', () => {
  it.each<[string, EditDraftPart[], string | undefined, { prompt: string; urls: string[] }]>([
    [
      '没引用标注：@图片1 是干净底图，其余图片按出现顺序排在后面',
      [text('鞋面换成'), image(JACKET), text('的颜色，参考'), image(SHOE)],
      undefined,
      { prompt: '鞋面换成@图片2的颜色，参考@图片3', urls: [BASE, JACKET, SHOE] },
    ],
    [
      '引用了标注：@图片1 换成标注图，不再发干净底图，末尾补一句说明',
      [text('把'), mark('a1', 1), text('换成'), image(JACKET), text('的材质')],
      ANNOTATED,
      { prompt: `把@标注3换成@图片2的材质${NOTICE}`, urls: [ANNOTATED, JACKET] },
    ],
    [
      '帧 @1 恰好是底图：并进隐式的那张，落成 @图片1，不另占一张',
      [text('保持'), image(BASE, '帧 @1 · 编辑底图'), text('的光线，参考'), image(SHOE)],
      undefined,
      { prompt: '保持@图片1的光线，参考@图片2', urls: [BASE, SHOE] },
    ],
    [
      '引用了标注时提到底图：同样指向 @图片1（标注图）',
      [mark('a2', 2), text('以外保持'), image(BASE, '编辑底图'), text('不变')],
      ANNOTATED,
      { prompt: `@标注2以外保持@图片1不变${NOTICE}`, urls: [ANNOTATED] },
    ],
    [
      '同一张图提到两次：只发一次，两处同一个编号',
      [image(JACKET), text('和'), image(SHOE), text('，再看'), image(JACKET)],
      undefined,
      { prompt: '@图片2和@图片3，再看@图片2', urls: [BASE, JACKET, SHOE] },
    ],
  ])('%s', (_, parts, annotatedUrl, expected) => {
    expect(compileEditRequest(parts, { annotatedUrl, baseUrl: BASE, numberOf })).toEqual({
      prompt: expected.prompt,
      referenceImageUrls: expected.urls,
    })
  })

  it.each<[string, EditDraftPart[], string | undefined]>([
    ['引用了标注却没给标注图', [mark('a1', 1)], undefined],
    ['标注已不在画布上（漏了终校）', [mark('gone', 4)], ANNOTATED],
  ])('%s：抛错，不编出指向空处的引用', (_, parts, annotatedUrl) => {
    expect(() => compileEditRequest(parts, { annotatedUrl, baseUrl: BASE, numberOf })).toThrow()
  })
})

describe('restoreEditParts', () => {
  it.each<[string, { prompt: string; referenceImageUrls: string[] }, EditDraftPart[]]>([
    [
      '@图片N 装回图片 chip，底图叫「编辑底图」，其余取文件名',
      { prompt: '保持@图片1的光线，参考@图片2', referenceImageUrls: [BASE, SHOE] },
      [text('保持'), image(BASE, '编辑底图'), text('的光线，参考'), image(SHOE, 'shoe.png')],
    ],
    [
      '引用过标注：收尾那句去掉，@标注N 留成文字，排第一的标注图不装回',
      { prompt: `把@标注1换成@图片2的材质${NOTICE}`, referenceImageUrls: [ANNOTATED, JACKET] },
      [text('把@标注1换成'), image(JACKET, 'jacket.png'), text('的材质')],
    ],
    [
      '编号超出图片张数：当普通文字留着',
      { prompt: '参考@图片9', referenceImageUrls: [BASE] },
      [text('参考@图片9')],
    ],
    [
      '早先的请求带了正文没提到的图：接在末尾装回，底图本身不装',
      { prompt: '换个背景', referenceImageUrls: [JACKET, BASE, SHOE] },
      [text('换个背景'), image(JACKET, 'jacket.png'), image(SHOE, 'shoe.png')],
    ],
  ])('%s', (_, request, expected) => {
    expect(restoreEditParts(request, BASE)).toEqual(expected)
  })

  it('恢复出来的再编一次，得到同一份请求', () => {
    const request = {
      prompt: '鞋面换成@图片2的颜色，参考@图片3',
      referenceImageUrls: [BASE, JACKET, SHOE],
    }
    const parts = restoreEditParts(request, BASE)
    expect(compileEditRequest(parts, { annotatedUrl: undefined, baseUrl: BASE, numberOf })).toEqual(
      request,
    )
  })
})

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  shotIndex: 2,
  frameNumber: 3,
}

describe('useFrameImageJobs', () => {
  it('帧状态只取调模型的图片记录：切图没有坐标，不占 100 条的窗口', async () => {
    let query: URLSearchParams | undefined
    server.use(
      http.get('*/api/generations', ({ request }) => {
        query = new URL(request.url).searchParams
        return HttpResponse.json({ items: [] })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useFrameImageJobs(target.conversationId), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(query?.get('kind')).toBe('image')
    expect(query?.get('operation')).toBe('generate')
  })
})

describe('useImageEditJobs', () => {
  it('按格查询把坐标编成 JSON 对象放进 metadata 参数', async () => {
    let query: URLSearchParams | undefined
    server.use(
      http.get('*/api/generations', ({ request }) => {
        query = new URL(request.url).searchParams
        return HttpResponse.json({ items: [] })
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useImageEditJobs(target), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(query?.get('kind')).toBe('image')
    expect(JSON.parse(query?.get('metadata') ?? 'null')).toEqual({ shot: 2, frame: 3 })
  })
})

describe('imageEditJobsRefetchInterval', () => {
  const done = makeGenerationJob({ kind: 'image', status: 'completed' })
  const running = makeGenerationJob({ kind: 'image', status: 'submitted' })

  it('与生成列表同一口径：已翻开的哪一页里有在跑的都算', () => {
    const interval = imageEditJobsRefetchInterval({
      pages: [{ items: [done] }, { items: [running] }],
    })

    expect(interval).toBe(generationsRefetchInterval([done, running]))
    expect(interval).not.toBe(false)
  })

  it('全落定了、或者还没读到就不问', () => {
    expect(imageEditJobsRefetchInterval({ pages: [{ items: [done] }] })).toBe(false)
    expect(imageEditJobsRefetchInterval(undefined)).toBe(false)
  })
})

describe('seedImageEditJob', () => {
  const job = makeGenerationJob({ kind: 'image', status: 'pending' })

  it('这一格还没读过就落成一页', () => {
    const queryClient = new QueryClient()

    seedImageEditJob(queryClient, target, job)

    expect(queryClient.getQueryData(imageEditQueryKey(target))).toEqual({
      pages: [{ items: [job] }],
      pageParams: [undefined],
    })
  })

  it('已翻开几页时只进第一页最前面、同一条替换不重复，其余页不动，并失效本对话前缀', () => {
    const queryClient = new QueryClient()
    const older = makeGenerationJob({ kind: 'image' })
    const secondPage = { items: [makeGenerationJob({ kind: 'image' })] }
    queryClient.setQueryData(imageEditQueryKey(target), {
      pages: [{ items: [job, older] }, secondPage],
      pageParams: [undefined, older.id],
    })
    const frameJobsKey = imageEditConversationKey(target.conversationId)
    queryClient.setQueryData(frameJobsKey, { items: [] })
    const accepted = { ...job, status: 'submitted' as const }

    seedImageEditJob(queryClient, target, accepted)

    expect(queryClient.getQueryData(imageEditQueryKey(target))).toEqual({
      pages: [{ items: [accepted, older] }, secondPage],
      pageParams: [undefined, older.id],
    })
    expect(queryClient.getQueryState(frameJobsKey)?.isInvalidated).toBe(true)
  })
})

describe('submitImageEdit', () => {
  it('改的是哪张图走 sourceUrl，坐标只记这一格，编好的正文与图片照发', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json(
          {
            generation: {
              createdAt: '2026-09-13T02:00:00Z',
              errorMessage: null,
              id: '4a1e2f60-9a1e-4c2f-9c8b-1d2e3f4a5b6c',
              kind: 'image',
              operation: 'generate',
              metadata: body['metadata'],
              outputUrl: null,
              request: {},
              status: 'pending',
              taskId: null,
              rootJobId: null,
              sourceUrl: body['sourceUrl'],
              clipStage: null,
              durationMs: null,
              watermarkOutputUrl: null,
            },
          },
          { status: 202 },
        )
      }),
    )

    const job = await submitImageEdit(
      target,
      { prompt: '参考@图片2', referenceImageUrls: [BASE, JACKET] },
      BASE,
      {
        aspectRatio: '9:16',
        model: 'nano_banana_pro',
        resolution: '2k',
        channel: 'dev',
      },
    )

    expect(job.status).toBe('pending')
    expect(body['sourceUrl']).toBe('https://cdn.test/frame.png')
    expect(body['metadata']).toEqual({ shot: 2, frame: 3 })
    expect(body['prompt']).toBe('参考@图片2')
    expect(body['referenceImageUrls']).toEqual([BASE, JACKET])
  })
})

const NANO: ImageModel = {
  model: 'nano_banana_pro',
  label: 'Nano Banana Pro',
  aspectRatios: ['1:1', '4:5', '9:16'],
  resolutions: ['1k', '2k', '4k'],
  channels: ['dev', 'pro'],
}
const SEEDREAM: ImageModel = {
  model: 'seedream_v5_pro',
  label: 'Seedream 5.0 Pro',
  aspectRatios: ['1:1', '9:16'],
  resolutions: ['1k', '2k'],
  channels: [],
}
const WANTED = { model: 'nano_banana_pro', channel: 'dev', resolution: '2k' } as const

describe('resolveImageOptions', () => {
  it('保留调用方想要的那一组', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', WANTED)
    expect(resolved.model?.model).toBe('nano_banana_pro')
    expect(resolved.resolution).toBe('2k')
    expect(resolved.channel).toBe('dev')
  })

  it('所选模型没有渠道这个轴时不给渠道', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
    })
    expect(resolved.channel).toBeUndefined()
  })

  it('档位落在所选模型范围外时退到它最高的一档', () => {
    const resolved = resolveImageOptions([NANO, SEEDREAM], '9:16', {
      ...WANTED,
      model: 'seedream_v5_pro',
      resolution: '4k',
    })
    expect(resolved.resolution).toBe('2k')
  })

  it('画幅这家出不了就换成出得了的那家', () => {
    const resolved = resolveImageOptions([SEEDREAM, NANO], '4:5', {
      ...WANTED,
      model: 'seedream_v5_pro',
    })
    expect(resolved.model?.model).toBe('nano_banana_pro')
    expect(resolved.aspectUnsupported).toBe(false)
  })

  it('一家都出不了这个画幅时报出来，而不是挑一家去撞 422', () => {
    const resolved = resolveImageOptions([SEEDREAM], '4:5', WANTED)
    expect(resolved.model).toBeUndefined()
    expect(resolved.aspectUnsupported).toBe(true)
  })

  it('模型还没加载完不算画幅不支持', () => {
    expect(resolveImageOptions([], '4:5', WANTED).aspectUnsupported).toBe(false)
  })
})

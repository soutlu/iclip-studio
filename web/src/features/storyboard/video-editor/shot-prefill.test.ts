import { describe, expect, it } from 'vitest'
import type { ComposerPart } from '@/shared/ui/composer'
import { makeGenerationJob } from '@/testing/generation-job'
import type { Shot } from '../shot-document'
import { promptPartsOf, referenceImageUrlsOf, rootRangesOf, shotPromptOf } from './shot-prefill'

const ROOT = '0f6a2c9e-8d4b-4c1e-9a7f-3b5d6e8f1a2b'
const EDIT = '6c1d7e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f'
const V2 = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const V3 = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'

/** 基于 `base` 的一次合成，片段按给的顺序首尾相接。 */
const composite = (
  id: string,
  base: string,
  segments: { sourceJobId: string; start: number; end: number | null }[],
) =>
  makeGenerationJob({
    id,
    operation: 'compose',
    rootJobId: ROOT,
    sourceJobId: base,
    request: { segments: segments.map((segment) => ({ ...segment, url: 'https://cdn/x.mp4' })) },
  })

const edit = makeGenerationJob({
  id: EDIT,
  rootJobId: ROOT,
  sourceJobId: ROOT,
  rangeStartMs: 2000,
  rangeEndMs: 4000,
})

describe('rootRangesOf', () => {
  it('出自原作的段直接用它的区间', () => {
    expect(rootRangesOf([{ sourceJobId: ROOT, start: 1, end: 2 }], ROOT, [])).toEqual([
      { start: 1, end: 2 },
    ])
  })

  it('出自合成的段按片段列表映射到各段出处，落在编辑段上的部分丢掉', () => {
    // V2 = 原作 0–2 秒 + 编辑段 0–3 秒 + 原作 4–8 秒，在 V2 上依次占 0–2、2–5、5–9 秒。
    const v2 = composite(V2, ROOT, [
      { sourceJobId: ROOT, start: 0, end: 2 },
      { sourceJobId: EDIT, start: 0, end: 3 },
      { sourceJobId: ROOT, start: 4, end: 8 },
    ])

    expect(rootRangesOf([{ sourceJobId: V2, start: 1, end: 6 }], ROOT, [v2, edit])).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ])
    expect(rootRangesOf([{ sourceJobId: V2, start: 2.5, end: 4 }], ROOT, [v2, edit])).toEqual([])
  })

  it('合成基于合成：沿基底一层层推回原作', () => {
    // V2 = 原作 2–6 秒；V3 = V2 的 1–3 秒 + 原作 0–1 秒。
    const v2 = composite(V2, ROOT, [{ sourceJobId: ROOT, start: 2, end: 6 }])
    const v3 = composite(V3, V2, [
      { sourceJobId: V2, start: 1, end: 3 },
      { sourceJobId: ROOT, start: 0, end: 1 },
    ])

    expect(rootRangesOf([{ sourceJobId: V3, start: 0.5, end: 2.5 }], ROOT, [v2, v3])).toEqual([
      { start: 3.5, end: 5 },
      { start: 0, end: 0.5 },
    ])
  })

  it('开放结尾的片段取到出处的结尾，它之后的片段推不出位置', () => {
    const v2 = composite(V2, ROOT, [{ sourceJobId: ROOT, start: 3, end: null }])

    expect(rootRangesOf([{ sourceJobId: V2, start: 0, end: 2 }], ROOT, [v2])).toEqual([
      { start: 3, end: 5 },
    ])
  })

  it.each([
    { name: '编辑段', clip: { sourceJobId: EDIT, start: 0, end: 2 }, jobs: [edit] },
    { name: '链里找不到的合成', clip: { sourceJobId: V2, start: 0, end: 2 }, jobs: [] },
  ])('出自$name的段对应不上原作', ({ clip, jobs }) => {
    expect(rootRangesOf([clip], ROOT, jobs)).toEqual([])
  })
})

const shot: Shot['prompt'] = {
  global_settings: '写实，暖色调',
  timeline: [
    { timestamps: [0, 2], prompt: '清晨的街道，@Image1 推着单车走过', image_indexes: [1] },
    { timestamps: [2, 5], prompt: '他停在面包店门口', image_indexes: [] },
    { timestamps: [5, 8], prompt: '@Image2 隔着柜台递出一袋面包', image_indexes: [2] },
  ],
}

describe('shotPromptOf', () => {
  it('取有重叠的镜头，按时间先后、去重后一镜一行；只碰端点的不算', () => {
    expect(
      shotPromptOf(shot, [
        { start: 5, end: 6 },
        { start: 1, end: 2 },
        { start: 1.5, end: 2 },
      ]),
    ).toBe('清晨的街道，@Image1 推着单车走过\n@Image2 隔着柜台递出一袋面包')
  })

  it('跨两镜的区间两镜都取', () => {
    expect(shotPromptOf(shot, [{ start: 1, end: 3 }])).toBe(
      '清晨的街道，@Image1 推着单车走过\n他停在面包店门口',
    )
  })

  it.each([
    { name: '没有区间', ranges: [] },
    { name: '区间超出全部镜头', ranges: [{ start: 8, end: 9 }] },
  ])('$name时没有预填', ({ ranges }) => {
    expect(shotPromptOf(shot, ranges)).toBeUndefined()
  })
})

describe('referenceImageUrlsOf', () => {
  it.each([
    {
      name: '请求里有参考图',
      request: { reference_image_urls: ['https://cdn/a.png'] },
      expected: ['https://cdn/a.png'],
    },
    { name: '请求里没有参考图', request: {}, expected: [] },
  ])('$name', ({ request, expected }) => {
    expect(referenceImageUrlsOf(makeGenerationJob({ request }))).toEqual(expected)
  })
})

describe('promptPartsOf', () => {
  /** 附件编号是随机的，比对时只看文字与图片的地址和名字。 */
  const shape = (parts: readonly ComposerPart[]) =>
    parts.map((part) =>
      part.kind === 'media'
        ? { image: part.media.url, name: part.media.name, status: part.media.status }
        : part,
    )

  it('@ImageN 换成第 N 张参考图的就绪附件，名字取文件名；编号越界的照原文留着', () => {
    const urls = ['https://cdn.example/refs/boy.png?v=2', 'https://cdn.example/refs/baker.png']

    expect(
      shape(promptPartsOf('@Image1 推着单车，@Image3 与 @Image0 不在，\n@Image2 递面包', urls)),
    ).toEqual([
      { image: urls[0], name: 'boy.png', status: 'ready' },
      { kind: 'text', text: ' 推着单车，@Image3 与 @Image0 不在，\n' },
      { image: urls[1], name: 'baker.png', status: 'ready' },
      { kind: 'text', text: ' 递面包' },
    ])
  })

  it('地址里取不到文件名时叫「图片」', () => {
    expect(shape(promptPartsOf('@Image1', ['https://cdn.example/refs/']))).toEqual([
      { image: 'https://cdn.example/refs/', name: '图片', status: 'ready' },
    ])
  })
})

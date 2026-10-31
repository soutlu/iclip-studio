import { describe, expect, it } from 'vitest'
import { compileEditRequest, restoreEditParts } from './image-edit.api'
import type { EditDraftPart } from './image-edit-types'

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

import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_ANNOTATIONS, MAX_EDIT_REFERENCES } from '../generation-limits'
import {
  draftOf,
  editDraftError,
  editDraftKey,
  isEmptyDraft,
  loadEditDrafts,
  TOO_MANY_ANNOTATIONS,
} from './image-edit-draft'
import type { FrameEditDraft, FrameEditTarget, ImageAnnotation } from './image-edit-types'

const target: FrameEditTarget = {
  conversationId: 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d',
  shotIndex: 1,
  frameNumber: 1,
}
const BASE = 'https://example.com/original.png'
const OTHER = 'https://example.com/result.png'

const store = (drafts: Record<string, FrameEditDraft>) =>
  sessionStorage.setItem(editDraftKey(target), JSON.stringify(drafts))
const mark = (index: number): ImageAnnotation => ({
  id: `mark-${index}`,
  number: index + 1,
  kind: 'point',
  points: [{ x: 0.5, y: 0.5 }],
})
const image = (index: number) => ({
  kind: 'image' as const,
  name: `图${index}.png`,
  url: `https://example.com/${index}.png`,
})
const ask = { kind: 'text' as const, text: '改成蓝色' }

describe('未提交图片编辑草稿', () => {
  beforeEach(() => sessionStorage.clear())

  it('每张底图各存各的，互不串台；没写过的是同一份空草稿', () => {
    const onBase: FrameEditDraft = {
      annotations: [mark(0)],
      parts: [ask, { kind: 'annotation', id: 'mark-0', number: 1 }, image(1)],
    }
    store({ [BASE]: onBase })
    const drafts = loadEditDrafts(target)

    expect(draftOf(drafts, BASE)).toEqual(onBase)
    expect(draftOf(drafts, OTHER)).toEqual({ annotations: [], parts: [] })
    expect(draftOf(drafts, OTHER)).toBe(draftOf(drafts, 'https://example.com/third.png'))
    expect(isEmptyDraft(draftOf(drafts, OTHER))).toBe(true)
    expect(isEmptyDraft(onBase)).toBe(false)
  })

  it('换了存储前缀：旧形状的草稿读不到，也不报错', () => {
    sessionStorage.setItem(
      `cue:frame-edit:${target.conversationId}:${target.shotIndex}:${target.frameNumber}`,
      JSON.stringify({ [BASE]: { annotations: [], instructions: [], references: [] } }),
    )
    expect(loadEditDrafts(target)).toEqual({})
  })

  it('读坏的草稿抛出来，由调用方决定怎么提示', () => {
    sessionStorage.setItem(editDraftKey(target), JSON.stringify({ [BASE]: { annotations: 1 } }))
    expect(() => loadEditDrafts(target)).toThrow()
  })
})

describe('editDraftError', () => {
  const ok: FrameEditDraft = { annotations: [mark(0)], parts: [ask] }

  it.each<[string, FrameEditDraft, string | null]>([
    ['只有文字', ok, null],
    ['只有空白', { annotations: [], parts: [{ kind: 'text', text: '  ' }] }, '请填写修改要求'],
    ['只有图片没有文字', { annotations: [], parts: [image(1)] }, '请填写修改要求'],
    [
      '超过 4000 字',
      { annotations: [], parts: [{ kind: 'text', text: '长'.repeat(4001) }] },
      '修改要求不能超过 4000 字',
    ],
    [
      '引用了画布上删掉的标注',
      { annotations: [], parts: [ask, { kind: 'annotation', id: 'mark-0', number: 1 }] },
      '修改要求中有已删除的标注，请处理失效引用',
    ],
    [
      '标注刚好到上限',
      { annotations: Array.from({ length: MAX_ANNOTATIONS }, (_, i) => mark(i)), parts: [ask] },
      null,
    ],
    [
      '标注超出上限一个，与画布同一句提示',
      { annotations: Array.from({ length: MAX_ANNOTATIONS + 1 }, (_, i) => mark(i)), parts: [ask] },
      TOO_MANY_ANNOTATIONS,
    ],
    [
      '底图之外 9 张（底图固定占一张，合计正好 10 张）',
      {
        annotations: [],
        parts: [ask, ...Array.from({ length: MAX_EDIT_REFERENCES - 1 }, (_, i) => image(i))],
      },
      null,
    ],
    [
      '同一张图引用两次只算一张，指向底图的不另算',
      {
        annotations: [],
        parts: [
          ask,
          ...Array.from({ length: MAX_EDIT_REFERENCES - 1 }, (_, i) => image(i)),
          image(0),
          { kind: 'image', name: '编辑底图', url: BASE },
        ],
      },
      null,
    ],
    [
      '底图之外 10 张',
      {
        annotations: [],
        parts: [ask, ...Array.from({ length: MAX_EDIT_REFERENCES }, (_, i) => image(i))],
      },
      `每次最多提交 ${MAX_EDIT_REFERENCES} 张图片`,
    ],
  ])('%s', (_, draft, expected) => {
    expect(editDraftError(draft, BASE)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import { compileImageClipPrompt } from './edit-prompt'
import type { EditDraftPart } from './image-edit/image-edit-types'

const text = (value: string): EditDraftPart => ({ kind: 'text', text: value })
const image = (url: string): EditDraftPart => ({ kind: 'image', name: url, url })

describe('图生描述的编写', () => {
  it.each([
    {
      name: '1 张图作首帧，正文不写引用，多出来的空白并掉',
      parts: [image('a'), text(' 人物 '), image('a'), text('  转身\n'), text('  看向镜头')],
      expected: { referenceImageUrls: ['a'], text: '人物 转身\n看向镜头' },
    },
    {
      name: '2 张图依次作首帧、尾帧，重复引用的同一张只算一次',
      parts: [text('从 '), image('a'), text(' 走到 '), image('b'), text(' 再回到 '), image('a')],
      expected: { referenceImageUrls: ['a', 'b'], text: '从 走到 再回到' },
    },
    {
      name: '3 张及以上是参考图，正文照旧写 @ImageN',
      parts: [text('参考'), image('a'), image('b'), text('，'), image('c'), image('a')],
      expected: {
        referenceImageUrls: ['a', 'b', 'c'],
        text: '参考@Image1@Image2，@Image3@Image1',
      },
    },
  ])('$name', ({ parts, expected }) => {
    expect(compileImageClipPrompt(parts)).toEqual(expected)
  })
})

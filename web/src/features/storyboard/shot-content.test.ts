import { describe, expect, it } from 'vitest'
import {
  adjacentFrame,
  scriptSegments,
  segmentTimeRange,
  sharedFrameCaption,
  shotContents,
} from './shot-content'
import type { Shot } from './shot-document'

// 全局设定引用 @1；镜头 1 引用 @2、@1；镜头 2 没有图；@3 谁都没引用。
const shot: Shot = {
  index: 1,
  seconds: 6,
  image_urls: [
    'https://example.com/1.png',
    'https://example.com/2.png',
    'https://example.com/3.png',
  ],
  prompt: {
    global_settings: '人物跟住 @Image1。',
    timeline: [
      {
        timestamps: [0, 0.1 + 0.2],
        prompt: '走出门 @Image2，看向 @Image1。',
        image_indexes: [2, 1],
      },
      { timestamps: [0.1 + 0.2, 6], prompt: '只有旁白。', image_indexes: [] },
    ],
  },
}
const contents = shotContents(shot)
const byId = (id: string) => {
  const content = contents.find((item) => item.id === id)
  if (content === undefined) throw new Error(`缺少内容 ${id}`)
  return content
}

describe('scriptSegments', () => {
  it('全局设定与各镜头成段，未引用的图不成段', () => {
    expect(scriptSegments(contents).map((item) => item.id)).toEqual([
      'global',
      'scene:1',
      'scene:2',
    ])
  })
})

describe('segmentTimeRange', () => {
  it('镜头写起止秒，去掉浮点尾差；全局设定没有时间', () => {
    expect(segmentTimeRange(shot, byId('scene:1'))).toBe('0–0.3s')
    expect(segmentTimeRange(shot, byId('scene:2'))).toBe('0.3–6s')
    expect(segmentTimeRange(shot, byId('global'))).toBeUndefined()
  })
})

describe('adjacentFrame', () => {
  it('只在这段引用的帧之间按正文顺序走，到头为 undefined', () => {
    const scene = byId('scene:1')
    expect(adjacentFrame(scene, 2, 1)).toBe(1)
    expect(adjacentFrame(scene, 1, 1)).toBeUndefined()
    expect(adjacentFrame(scene, 1, -1)).toBe(2)
    expect(adjacentFrame(scene, 2, -1)).toBeUndefined()
  })

  it('当前帧不属于这段或这段没有帧时不走', () => {
    expect(adjacentFrame(byId('scene:1'), 3, 1)).toBeUndefined()
    expect(adjacentFrame(byId('scene:2'), undefined, 1)).toBeUndefined()
  })
})

describe('sharedFrameCaption', () => {
  it('被几段共用时列出它们，只属于一段或没有帧时不说', () => {
    expect(sharedFrameCaption(contents, 1)).toBe('@Image1 · 全局设定、镜头 1 共用')
    expect(sharedFrameCaption(contents, 2)).toBeUndefined()
    expect(sharedFrameCaption(contents, undefined)).toBeUndefined()
  })
})

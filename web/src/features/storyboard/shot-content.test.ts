import { describe, expect, it } from 'vitest'
import {
  adjacentFrame,
  contentAfterPickingFrame,
  framePosition,
  formatTimeRange,
  formatTimecode,
  frameUsage,
  promptLength,
  scriptSegments,
  segmentTimeRange,
  shotContents,
  timelineDuration,
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
  it('镜头照文件取起止秒，时长相减后取到 0.1s；全局设定没有时间', () => {
    expect(segmentTimeRange(shot, byId('scene:1'))).toEqual({
      start: 0,
      end: 0.1 + 0.2,
      duration: 0.3,
    })
    expect(segmentTimeRange(shot, byId('scene:2'))).toEqual({
      start: 0.1 + 0.2,
      end: 6,
      duration: 5.7,
    })
    expect(segmentTimeRange(shot, byId('global'))).toBeUndefined()
  })

  it('时长不带浮点尾差：3.4 − 1.6 得 1.8', () => {
    const fractional: Shot = {
      ...shot,
      prompt: {
        ...shot.prompt,
        timeline: [
          { timestamps: [0, 1.6], prompt: '开场。', image_indexes: [] },
          { timestamps: [1.6, 3.4], prompt: '穿鞋。', image_indexes: [] },
        ],
      },
    }
    const time = segmentTimeRange(fractional, byId('scene:2'))
    expect(time?.duration).toBe(1.8)
    expect(time === undefined ? undefined : formatTimeRange(time)).toBe('1.6s – 3.4s')
    expect(timelineDuration(fractional)).toBe(3.4)
  })
})

describe('formatTimecode', () => {
  it.each([
    [0, '0.0s'],
    [1.6, '1.6s'],
    [3.4 - 1.6, '1.8s'],
    [0.1 + 0.2, '0.3s'],
    [15, '15.0s'],
    [16 + 5.9, '21.9s'],
  ])('%s 秒写成 %s', (seconds, text) => {
    expect(formatTimecode(seconds)).toBe(text)
  })
})

describe('timelineDuration', () => {
  it('总长取最后一镜的止秒，不取出片参数 seconds', () => {
    expect(timelineDuration({ ...shot, seconds: 8 })).toBe(6)
  })
})

describe('promptLength', () => {
  it('空白不计，@ImageN 按显示的 @N 计', () => {
    expect(promptLength('人物跟住 @Image1。\n场景：停车场。')).toBe(14)
    expect(promptLength('  \n ')).toBe(0)
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

describe('framePosition', () => {
  it('按这段引用的顺序数第几帧、共几帧；帧不属于这段或这段没有帧时为 undefined', () => {
    expect(framePosition(byId('scene:1'), 2)).toEqual({ count: 2, index: 1 })
    expect(framePosition(byId('scene:1'), 1)).toEqual({ count: 2, index: 2 })
    expect(framePosition(byId('scene:1'), 3)).toBeUndefined()
    expect(framePosition(byId('scene:2'), undefined)).toBeUndefined()
  })
})

describe('frameUsage', () => {
  it('列出引用这一帧的段，多段时说共用，没有段引用时说未引用', () => {
    expect(frameUsage(contents, 1)).toBe('全局设定、镜头 1 共用')
    expect(frameUsage(contents, 2)).toBe('镜头 1')
    expect(frameUsage(contents, 3)).toBe('未引用')
  })
})

describe('contentAfterPickingFrame', () => {
  it.each([
    ['当前段引用它就留在当前段', 'scene:1', 1, 'scene:1'],
    ['当前段不引用它就到第一个引用它的段', 'scene:2', 2, 'scene:1'],
    ['按段的顺序取第一个', 'scene:2', 1, 'global'],
    ['没有段引用时落到未引用', 'scene:1', 3, 'unreferenced'],
    ['从未引用点回被引用的帧，到引用它的段', 'unreferenced', 2, 'scene:1'],
    ['帧不在本组时不选', 'scene:1', 4, undefined],
  ])('%s', (_case, currentId, frame, expected) => {
    expect(contentAfterPickingFrame(contents, currentId, frame)).toBe(expected)
  })
})

import { describe, expect, it } from 'vitest'
import type { FilmFrame, FilmGroup } from './film.api'
import {
  contentOfFrame,
  missingFramesText,
  missingReferencesText,
  resolveFilmSelection,
  segmentFrames,
  settingText,
  shotText,
} from './film-content'
import { regeneratePrompt } from './film-images'

const frame = (node: string, number: number | null, url: string | null): FilmFrame => ({
  aspectRatio: '9:16',
  kind: 'generated',
  label: node,
  missing: [],
  node,
  number,
  prompt: null,
  url,
})

const shot = (text: string, view: string | null, start: number) => ({
  end: start + 2,
  lines: [],
  parts: [text],
  start,
  target: `shot:board:${start}`,
  view,
})

/** 列表四张，c 没选用；列表后面接着镜头 4 没进列表的机位图 e（没有编号）。甲写 @1，乙写 @2、@4，丙也写 @2；
 * 镜头 1 开头引用机位图 c（@3），镜头 2 只写了一个超出列表的编号，镜头 3 正文里写 @1，镜头 4 只挂着 e。 */
const group: FilmGroup = {
  aspectRatio: '9:16',
  frames: [
    frame('a', 1, 'https://example.com/a.png'),
    frame('b', 2, 'https://example.com/b.png'),
    frame('c', 3, null),
    frame('d', 4, 'https://example.com/d.png'),
    frame('e', null, null),
  ],
  index: 1,
  model: 'seedance',
  prompt: '',
  seconds: 6,
  settings: [
    { images: [], kind: 'shooting', label: '拍摄与剪辑', target: 'value:拍法', text: '手持' },
    { images: [], kind: 'element', label: '人物', target: 'value:甲', text: '甲参考@Image1' },
    {
      images: [],
      kind: 'element',
      label: '产品',
      target: 'value:乙',
      text: '乙参考@Image2、@Image4，再看@Image2',
    },
    { images: [], kind: 'element', label: '场景', target: 'value:丙', text: '丙参考@Image2' },
  ],
  shots: [
    shot('参考@Image3，正文', 'c', 0),
    shot('正文写了@Image9', null, 2),
    shot('正文用@Image1', null, 4),
    shot('正文', 'e', 6),
  ],
  video: 'v',
}

describe('resolveFilmSelection', () => {
  it.each([
    ['不给段就是全局设定，图是它挂的第一张', undefined, undefined, 'global', 1],
    ['段不在这组里落回第一段', 'scene:9', undefined, 'global', 1],
    ['镜头段默认看它的画面', 'scene:1', undefined, 'scene:1', 3],
    ['没挂图的段舞台空着', 'scene:2', undefined, 'scene:2', undefined],
    ['没进列表的机位图也是那一镜的画面', 'scene:4', undefined, 'scene:4', 5],
    ['图越界就用这段挂的第一张', 'global', 7, 'global', 1],
    ['图在范围里就照给的', 'scene:2', 2, 'scene:2', 2],
  ])('%s', (_name, content, requested, contentId, expected) => {
    expect(resolveFilmSelection(group, { content, frame: requested })).toEqual({
      contentId,
      frame: expected,
    })
  })
})

describe('segmentFrames', () => {
  it('全局设定是各段字里写的 @ImageN，按先后、去重', () => {
    expect(segmentFrames(group, 'global')).toEqual([1, 2, 4])
  })

  it('镜头是它的机位图与正文里写的，开头的「参考@ImageN，」也算；超出列表的编号不算', () => {
    expect(segmentFrames(group, 'scene:1')).toEqual([3])
    expect(segmentFrames(group, 'scene:2')).toEqual([])
    expect(segmentFrames(group, 'scene:3')).toEqual([1])
  })

  it('没进列表的机位图按它在 frames 里的位置算；字里的编号只认列表里的，不会指到它', () => {
    expect(segmentFrames(group, 'scene:4')).toEqual([5])
    const cited = {
      ...group,
      shots: [shot('参考@Image5，正文', null, 0)],
    }
    expect(segmentFrames(cited, 'scene:1')).toEqual([])
    expect(contentOfFrame(group, 'global', 5)).toBe('scene:4')
  })
})

describe('contentOfFrame', () => {
  it('当前段挂着这张就不动，否则选第一段挂着它的', () => {
    expect(contentOfFrame(group, 'scene:3', 1)).toBe('scene:3')
    expect(contentOfFrame(group, 'scene:2', 1)).toBe('global')
    expect(contentOfFrame(group, 'global', 3)).toBe('scene:1')
  })
})

describe('settingText', () => {
  it('称呼后面接「：」；声音的正文开头已有说话人，空一格接；拍法没有称呼', () => {
    expect(settingText({ kind: 'element', label: '人物 甲', text: '甲' })).toBe('人物 甲：甲')
    expect(settingText({ kind: 'voice', label: '声音', text: '旁白：低沉的男声。' })).toBe(
      '声音 旁白：低沉的男声。',
    )
    expect(settingText({ kind: 'shooting', label: null, text: '手持' })).toBe('手持')
  })
})

describe('shotText', () => {
  it('台词夹在前后两段字之间，写成说话人加引号', () => {
    expect(
      shotText({
        lines: [{ role: '旁白', target: 'line:a', text: '一双就够了。' }],
        parts: ['她走过来。', '然后停下。'],
      }),
    ).toBe('她走过来。旁白“一双就够了。”然后停下。')
  })
})

describe('缺图原因', () => {
  it('生图：几张没选用的按先后用顿号连，同名的只写一次；一张都不缺就没有原因', () => {
    expect(missingReferencesText(['短发女生', '镜头 1', '短发女生'])).toBe(
      '参考图尚未选用：短发女生、镜头 1，无法生成图片；请先选用图片',
    )
    expect(missingReferencesText([])).toBeUndefined()
  })

  it('出片：只数列表里没图的，没进列表的机位图不算', () => {
    expect(missingFramesText(group)).toBe('1 张参考图尚未选用，无法生成视频；请先选用图片')
    expect(
      missingFramesText({ ...group, frames: group.frames.filter((item) => item.node !== 'c') }),
    ).toBeUndefined()
  })
})

describe('regeneratePrompt', () => {
  const original = [
    { kind: 'image' as const, name: '金发女生', url: 'https://example.com/girl.png' },
    { kind: 'text' as const, text: '的人物，站在坡面上。' },
  ]

  it('没改过就不给，后端照文件里的描述拼', () => {
    expect(regeneratePrompt(original, [...original])).toBeUndefined()
  })

  it('改过的按第一次出现的先后给参考图编号，正文里写 @ImageN，同一张只算一次', () => {
    expect(
      regeneratePrompt(original, [
        ...original,
        { kind: 'text', text: '傍晚，' },
        { kind: 'image', name: '鞋', url: 'https://example.com/shoe.png' },
        { kind: 'text', text: '放在' },
        { kind: 'image', name: '金发女生', url: 'https://example.com/girl.png' },
        { kind: 'text', text: '脚边。' },
      ]),
    ).toEqual({
      referenceImageUrls: ['https://example.com/girl.png', 'https://example.com/shoe.png'],
      text: '@Image1的人物，站在坡面上。傍晚，@Image2放在@Image1脚边。',
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { FilmFrame, FilmGroup } from './film.api'
import {
  contentOfFrame,
  groupMissingLabels,
  missingReferencesText,
  resolveFilmSelection,
  segmentFrames,
  settingText,
  shotText,
} from './film-content'
import { regeneratePrompt } from './film-images'

const frame = (node: string, number: number | null): FilmFrame => ({
  aspectRatio: '9:16',
  kind: 'generated',
  label: node,
  missing: [],
  node,
  number,
  prompt: null,
  url: number === null ? null : `https://example.com/${node}.png`,
})

const shot = (view: string | null, start: number) => ({
  end: start + 2,
  lines: [],
  parts: ['正文'],
  start,
  target: `shot:board:${start}`,
  view,
})

/** 甲挂 a，乙挂 b、d 两张，丙也挂 b；镜头 1 的画面是 c，镜头 2 没挂图，镜头 3 也用 a 当画面。 */
const group: FilmGroup = {
  aspectRatio: '9:16',
  frames: [frame('a', 1), frame('b', 2), frame('c', null), frame('d', 3)],
  index: 1,
  model: 'seedance',
  seconds: 6,
  settings: [
    { images: [], kind: 'shooting', label: null, target: 'value:拍法', text: '手持' },
    { images: ['a'], kind: 'element', label: '人物 甲', target: 'value:甲', text: '甲' },
    { images: ['b', 'd'], kind: 'element', label: '产品 乙', target: 'value:乙', text: '乙' },
    { images: ['b'], kind: 'element', label: '场景 丙', target: 'value:丙', text: '丙' },
  ],
  shots: [shot('c', 0), shot(null, 2), shot('a', 4)],
  video: 'v',
}

describe('resolveFilmSelection', () => {
  it.each([
    ['不给段就是全局设定，图是它挂的第一张', undefined, undefined, 'global', 1],
    ['段不在这组里落回第一段', 'scene:9', undefined, 'global', 1],
    ['镜头段默认看它的画面', 'scene:1', undefined, 'scene:1', 3],
    ['没挂图的段舞台空着', 'scene:2', undefined, 'scene:2', undefined],
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
  it('全局设定是各元素挂的所有图，按先后、去重；一个元素挂几张就有几张', () => {
    expect(segmentFrames(group, 'global')).toEqual([1, 2, 4])
  })

  it('镜头是它的机位图，没挂图的没有', () => {
    expect(segmentFrames(group, 'scene:1')).toEqual([3])
    expect(segmentFrames(group, 'scene:2')).toEqual([])
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

describe('缺图提醒', () => {
  it('几张没图的用顿号连，同名的只写一次；名字以数字结尾时空一格；一张都不缺就不提醒', () => {
    expect(missingReferencesText(['短发女生'])).toBe('短发女生缺失，参考描述生成')
    expect(missingReferencesText(['短发女生', '镜头 1', '短发女生'])).toBe(
      '短发女生、镜头 1 缺失，参考描述生成',
    )
    expect(missingReferencesText([])).toBeUndefined()
  })

  it('一组出片缺的是没图的生成图，按先后；用户给的图不算', () => {
    const photo: FilmFrame = { ...frame('p', null), kind: 'photo', url: null }
    expect(groupMissingLabels({ ...group, frames: [...group.frames, photo] })).toEqual(['c'])
    expect(groupMissingLabels({ ...group, frames: [frame('a', 1), photo] })).toEqual([])
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

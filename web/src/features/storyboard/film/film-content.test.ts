import { describe, expect, it } from 'vitest'
import type { FilmFrame, FilmGroup, FilmSetting } from './film.api'
import { contentOfFrame, globalSettingsText, segmentFrames, settingSections } from './film-content'
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
    {
      images: [],
      kind: 'shooting',
      label: '拍摄与剪辑',
      shared: true,
      target: 'value:拍法',
      text: '手持',
    },
    {
      images: [],
      kind: 'element',
      label: '人物',
      shared: false,
      target: 'value:甲',
      text: '甲参考@Image1',
    },
    {
      images: [],
      kind: 'element',
      label: '产品',
      shared: false,
      target: 'value:乙',
      text: '乙参考@Image2、@Image4，再看@Image2',
    },
    {
      images: [],
      kind: 'element',
      label: '场景',
      shared: false,
      target: 'value:丙',
      text: '丙参考@Image2',
    },
  ],
  shots: [
    shot('参考@Image3，正文', 'c', 0),
    shot('正文写了@Image9', null, 2),
    shot('正文用@Image1', null, 4),
    shot('正文', 'e', 6),
  ],
  video: 'v',
}

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

describe('全局设定分节', () => {
  const setting = (kind: FilmSetting['kind'], label: string | null, text: string): FilmSetting => ({
    images: [],
    kind,
    label,
    shared: false,
    target: `value:${text}`,
    text,
  })

  const settings = [
    setting('shooting', '拍摄与剪辑', '摄影：手机实拍质感。\n剪辑：全片硬切。'),
    setting('element', '人物', '金色短发女生，长相参考 @Image1。'),
    setting('element', '产品', '黑色包头半拖鞋，外观参考 @Image3。'),
    setting('element', '产品', '沙色包头半拖鞋，外观参考 @Image4。'),
    setting('element', '产品', '栗棕色包头半拖鞋，外观参考 @Image5。'),
    setting('voice', '声音', '旁白：年轻女性的中音。'),
  ]

  it('连着的同一标题合成一节，标题只写一次，下面一条一行；声音也一样；节与节空一行', () => {
    expect(settingSections(settings).map((section) => section.label)).toEqual([
      '拍摄与剪辑',
      '人物',
      '产品',
      '声音',
    ])
    expect(globalSettingsText(settings)).toBe(
      [
        '拍摄与剪辑：',
        '摄影：手机实拍质感。',
        '剪辑：全片硬切。',
        '',
        '人物：',
        '金色短发女生，长相参考 @Image1。',
        '',
        '产品：',
        '黑色包头半拖鞋，外观参考 @Image3。',
        '沙色包头半拖鞋，外观参考 @Image4。',
        '栗棕色包头半拖鞋，外观参考 @Image5。',
        '',
        '声音：',
        '旁白：年轻女性的中音。',
      ].join('\n'),
    )
  })

  it('没有标题的那节只列各条，不补标题', () => {
    const untitled = [
      setting('shooting', null, '手持拍摄。'),
      setting('shooting', null, '全片硬切。'),
      setting('element', '人物', '金发女生。'),
    ]
    expect(settingSections(untitled).map((section) => section.label)).toEqual([null, '人物'])
    expect(globalSettingsText(untitled)).toBe('手持拍摄。\n全片硬切。\n\n人物：\n金发女生。')
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

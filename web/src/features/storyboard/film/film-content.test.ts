import { describe, expect, it } from 'vitest'
import type { FilmFrame, FilmGroup } from './film.api'
import { contentOfFrame, resolveFilmSelection, shotText } from './film-content'

const frame = (node: string, number: number | null): FilmFrame => ({
  aspectRatio: '9:16',
  kind: 'generated',
  label: node,
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

/** 两个元素挂图（a、b），镜头 1 的画面是 c，镜头 2 没挂图，镜头 3 也用 a 当画面。 */
const group: FilmGroup = {
  aspectRatio: '9:16',
  frames: [frame('a', 1), frame('b', 2), frame('c', null)],
  index: 1,
  model: 'seedance',
  seconds: 6,
  settings: [
    { image: 'a', kind: 'element', label: '人物 甲', target: 'element:甲', text: '甲' },
    { image: 'b', kind: 'element', label: '产品 乙', target: 'element:乙', text: '乙' },
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

describe('contentOfFrame', () => {
  it('当前段挂着这张就不动，否则选第一段挂着它的', () => {
    expect(contentOfFrame(group, 'scene:3', 1)).toBe('scene:3')
    expect(contentOfFrame(group, 'scene:2', 1)).toBe('global')
    expect(contentOfFrame(group, 'global', 3)).toBe('scene:1')
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

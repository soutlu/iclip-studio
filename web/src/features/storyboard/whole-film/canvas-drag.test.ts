import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import { canvasDelta, dragTargetOf, moveEditOf, positionOf, snapDrag } from './canvas-drag'

const film = () =>
  draftOf([video('v1', 's1', 0, 3_000)], {
    overlays: [overlay('o1', 0, 1_000), overlay('o2', 0, 1_000, { track: 1, x: 30, y: -20 })],
  })

describe('拖哪个元素', () => {
  it('特效块拖它自己，字幕的任何一句都拖全部字幕；画面轨上的段、音乐与空处不拖', () => {
    expect(dragTargetOf({ kind: 'overlay', id: 'o1' })).toBe('o1')
    expect(dragTargetOf({ kind: 'caption', key: 'v1:sub:3' })).toBe('captions')
    expect(dragTargetOf({ kind: 'clip', id: 'v1' })).toBeUndefined()
    expect(dragTargetOf({ kind: 'music' })).toBeUndefined()
    expect(dragTargetOf(null)).toBeUndefined()
  })

  it('按下时的位置取草稿里记着的；没写位置的按没挪过算', () => {
    const draft = film()
    expect(positionOf(draft, 'o2')).toEqual({ x: 30, y: -20 })
    expect(positionOf(draft, 'captions')).toEqual({ x: 0, y: 0 })
    const { x: _x, y: _y, ...captions } = draft.captions
    expect(positionOf({ ...draft, captions }, 'captions')).toEqual({ x: 0, y: 0 })
  })
})

describe('屏幕位移换成画布像素', () => {
  it('除以缩放（iframe 宽 / 画布宽）后取整', () => {
    // 1080 宽的画布显示成 360 像素宽：屏幕上 1 像素是画布 3 像素
    expect(canvasDelta({ dx: 10.2, dy: -4.9, scale: 1 / 3, from: { x: 0, y: 0 } })).toEqual({
      dx: 31,
      dy: -15,
    })
    expect(canvasDelta({ dx: 0.1, dy: -0.1, scale: 1 / 3, from: { x: 0, y: 0 } })).toEqual({
      dx: 0,
      dy: 0,
    })
  })

  it('挪完的位置裁在 ±4096 以内', () => {
    expect(canvasDelta({ dx: 5_000, dy: -5_000, scale: 1, from: { x: 4_000, y: -4_000 } })).toEqual(
      { dx: 96, dy: -96 },
    )
  })
})

describe('吸附', () => {
  const frame = { left: 0, top: 0, width: 360, height: 640 }
  // 宽 100、高 40 的一块，中线在 x=150
  const moving = { left: 100, top: 400, width: 100, height: 40 }

  it('靠近画面的竖中线时吸住，画一条横跨整个画面高度的参考线', () => {
    const snapped = snapDrag({ moving, frame, dx: 27, dy: 0, enabled: true })
    expect(snapped.dx).toBe(30)
    expect(snapped.guides).toEqual([{ left: 180, top: 0, width: 1, height: 640 }])
  })

  it('靠近画面边缘时吸住，参考线横跨整个画面宽度', () => {
    const snapped = snapDrag({ moving, frame, dx: 0, dy: 197, enabled: true })
    expect(snapped.dy).toBe(200)
    expect(snapped.guides).toEqual([{ left: 0, top: 640, width: 360, height: 1 }])
  })

  it('关掉吸附，或刚起步（位移还不到 4 像素）时不吸', () => {
    expect(snapDrag({ moving, frame, dx: 27, dy: 0, enabled: false })).toEqual({
      dx: 27,
      dy: 0,
      guides: [],
    })
    // 这块的竖中线离画面中线 1 像素，刚按下时不该被拽过去
    const near = { ...moving, left: 131 }
    expect(snapDrag({ moving: near, frame, dx: 2, dy: 1, enabled: true })).toEqual({
      dx: 2,
      dy: 1,
      guides: [],
    })
  })
})

describe('松手后的移动写进草稿', () => {
  it('拖的是特效块就挪那一块，是全部字幕就挪字幕', () => {
    const draft = film()
    const moved = (target: string, x: number, y: number) => {
      const result = moveEditOf(draft, { type: 'moveElement', target, x, y })
      if (result === null) throw new Error(`没有处理 ${target} 的移动`)
      return expectOk(result).draft
    }
    expect(moved('o1', 40.4, 12).overlays.map((o) => [o.id, o.x, o.y])).toEqual([
      ['o1', 40, 12],
      ['o2', 30, -20],
    ])
    expect(moved('captions', 0, -90).captions).toEqual({ ...draft.captions, x: 0, y: -90 })
  })

  it('别的元素（画面轨上的段、草稿里没有的）与别的操作不处理', () => {
    const draft = film()
    expect(moveEditOf(draft, { type: 'moveElement', target: 'v1', x: 1, y: 1 })).toBeNull()
    expect(moveEditOf(draft, { type: 'moveElement', target: 'gone', x: 1, y: 1 })).toBeNull()
    expect(moveEditOf(draft, { type: 'moveElement', target: ['o1'], x: 1, y: 1 })).toBeNull()
    expect(moveEditOf(draft, { type: 'removeElement', target: 'o1' })).toBeNull()
  })
})

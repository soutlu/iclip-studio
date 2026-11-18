import { describe, expect, it } from 'vitest'
import { snapDrag, type SnapRects } from './canvas-snap'
import { toLocal } from './layer-edits'

const CANVAS = { width: 480, height: 854 }
// 一段铺满画面的视频（能吸过去的别的层），拖的层 100×50、中心在 (150, 125)
const RECTS: SnapRects = {
  moving: { x: 100, y: 100, width: 100, height: 50 },
  targets: [{ x: 0, y: 0, width: 480, height: 854 }],
}

const drag = (overrides: Partial<Parameters<typeof snapDrag>[0]>) =>
  snapDrag({
    delta: { x: 0, y: 0 },
    zoom: 0.5,
    rects: RECTS,
    canvas: CANVAS,
    alt: false,
    angle: 0,
    ...overrides,
  })

describe('画面上挪层时的吸附', () => {
  it('中心拖到离画布中线几像素：吸到正中，画一条贯穿画面的竖线', () => {
    // 中心拖到 243，离中线 3 个画布像素（屏幕 1.5 像素）
    const { delta, guides } = drag({ delta: { x: 93, y: 7 } })
    expect(delta).toEqual({ x: 90, y: 7 })
    expect(guides?.lines).toEqual([{ key: 'x120', left: 120, top: 0, width: 1, height: 427 }])
  })

  it('阈值是屏幕像素：同样差 10 个画布像素，缩小着看时吸，放大着看时不吸', () => {
    expect(drag({ delta: { x: 80, y: 7 }, zoom: 0.5 }).delta.x).toBe(90)
    expect(drag({ delta: { x: 80, y: 7 }, zoom: 1 }).delta.x).toBe(80)
  })

  it('吸附以后的位移再换成父元素里的像素：缩在宿主里的层也正好落在中线上', () => {
    const { delta } = drag({ delta: { x: 93, y: 7 } })
    // 宿主把组件缩到 1/4：父元素里挪 4 像素是画布上 1 像素
    const parent = { a: 0.25, b: 0, c: 0, d: 0.25 }
    const local = toLocal(parent, delta)
    expect(150 + local.x * parent.a).toBe(CANVAS.width / 2)
  })

  it('按住 Alt：不吸，也不画参考线', () => {
    expect(drag({ delta: { x: 93, y: 7 }, alt: true })).toEqual({
      delta: { x: 93, y: 7 },
      guides: null,
    })
  })

  it('拖过 4 个屏幕像素以前不吸：停在中线附近拿起来不会先跳一下', () => {
    const near: SnapRects = { ...RECTS, moving: { ...RECTS.moving, x: 188 } }
    // 中心在 238，离中线 2 个画布像素
    expect(drag({ rects: near, delta: { x: 6, y: 0 } }).delta.x).toBe(6)
    expect(drag({ rects: near, delta: { x: 10, y: 0 } }).delta.x).toBe(2)
  })

  it('只挪一层、它转过 0.5° 及以上时不吸；挪好几层时不看角度', () => {
    expect(drag({ delta: { x: 93, y: 7 }, angle: 0.5 })).toEqual({
      delta: { x: 93, y: 7 },
      guides: null,
    })
    expect(drag({ delta: { x: 93, y: 7 }, angle: -0.4 }).delta.x).toBe(90)
    expect(drag({ delta: { x: 93, y: 7 }, angle: null }).delta.x).toBe(90)
  })

  it('没有别的层可吸时连画布也不吸；矩形还没量回来时不吸', () => {
    expect(drag({ delta: { x: 93, y: 7 }, rects: { ...RECTS, targets: [] } }).delta.x).toBe(93)
    expect(drag({ delta: { x: 93, y: 7 }, rects: null }).delta.x).toBe(93)
  })

  it('和左右两层间距相等时标出间距，标的是画布像素，不往那里吸', () => {
    const rects: SnapRects = {
      moving: { x: 60, y: 600, width: 40, height: 50 },
      targets: [
        { x: 0, y: 400, width: 40, height: 50 },
        { x: 140, y: 400, width: 40, height: 50 },
      ],
    }
    // 挪到 70：和左右两层各隔 30
    const { delta, guides } = drag({ rects, delta: { x: 10, y: 0 } })
    expect(delta).toEqual({ x: 10, y: 0 })
    expect(guides?.lines).toEqual([])
    expect(guides?.spacings.map(({ axis, gap }) => ({ axis, gap }))).toEqual([
      { axis: 'x', gap: 30 },
      { axis: 'x', gap: 30 },
    ])
  })
})

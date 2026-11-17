import { describe, expect, it } from 'vitest'
import {
  CYCLE_MS,
  frameContains,
  nudgeOf,
  pickAt,
  resizedSize,
  rotatedAngle,
} from './canvas-geometry'

describe('点选', () => {
  const point = { x: 100, y: 100 }

  it('点在不在框里按转过的框算', () => {
    const frame = { cx: 0, cy: 0, width: 200, height: 20, angle: 90 }
    expect(frameContains(frame, { x: 0, y: 90 })).toBe(true)
    expect(frameContains(frame, { x: 90, y: 0 })).toBe(false)
    expect(frameContains(frame, { x: 5, y: -99 })).toBe(true)
    expect(frameContains(frame, { x: 15, y: -99 })).toBe(false)
  })

  it('点到的是最上面一层；没点到层是 null', () => {
    expect(pickAt(['top', 'below'], new Set(), null, point, 0, 4)).toBe('top')
    expect(pickAt([], new Set(['top']), null, point, 0, 4)).toBeNull()
  })

  it('指针下有已经选中的层时还是它，不被盖在上面的抢走', () => {
    expect(pickAt(['top', 'below'], new Set(['below']), null, point, 0, 4)).toBe('below')
  })

  it('同一处 600 毫秒内再点一次换下一层，到底了回到最上面；隔久了、挪开了都不换', () => {
    const last = { point, at: 1_000, id: 'top' }
    const hits = ['top', 'middle', 'below']
    const selected = new Set(['top'])
    expect(pickAt(hits, selected, last, { x: 102, y: 101 }, 1_000 + CYCLE_MS, 4)).toBe('middle')
    expect(pickAt(hits, selected, { ...last, id: 'below' }, point, 1_100, 4)).toBe('top')
    expect(pickAt(hits, selected, last, point, 1_000 + CYCLE_MS + 1, 4)).toBe('top')
    expect(pickAt(hits, selected, last, { x: 110, y: 100 }, 1_100, 4)).toBe('top')
  })
})

describe('缩放和旋转', () => {
  const frame = { cx: 0, cy: 0, width: 200, height: 100, angle: 30 }
  const size = { width: 400, height: 200 }

  it('缩放：布局宽高乘指针离中心的距离比，哪个角、转没转都一样', () => {
    expect(resizedSize(frame, size, { x: 100, y: 50 }, { x: 200, y: 100 })).toEqual({
      width: 800,
      height: 400,
    })
    expect(resizedSize(frame, size, { x: -100, y: 0 }, { x: 0, y: 50 })).toEqual({
      width: 200,
      height: 100,
    })
  })

  it('缩到最短的一边是 1 个布局像素就不再缩；按在中心上不缩', () => {
    expect(resizedSize(frame, size, { x: 100, y: 0 }, { x: 0.01, y: 0 })).toEqual({
      width: 2,
      height: 1,
    })
    expect(resizedSize(frame, size, { x: 0, y: 0 }, { x: 300, y: 0 })).toEqual(size)
  })

  const center = { x: 0, y: 0 }

  it('转过的角度加到原来的角度上，跨过 ±180° 时不跳一圈', () => {
    expect(rotatedAngle(center, 10, { x: 100, y: 0 }, { x: 0, y: 100 }, false)).toBe(100)
    expect(rotatedAngle(center, 0, { x: -100, y: 1 }, { x: -100, y: -1 }, false)).toBeCloseTo(
      1.146,
      3,
    )
  })

  it('按住 Shift 吸到 15° 的整数倍', () => {
    const near = { x: Math.cos(0.4), y: Math.sin(0.4) }
    expect(rotatedAngle(center, 0, { x: 1, y: 0 }, near, false)).toBeCloseTo(22.918, 3)
    expect(rotatedAngle(center, 0, { x: 1, y: 0 }, near, true)).toBe(30)
    expect(rotatedAngle(center, 7, { x: 1, y: 0 }, { x: 1, y: 0 }, true)).toBe(0)
  })
})

describe('方向键微调', () => {
  it('每次 1 像素，按住 Shift 10 像素；别的键不挪', () => {
    expect(nudgeOf('ArrowLeft', false)).toEqual({ x: -1, y: 0 })
    expect(nudgeOf('ArrowDown', true)).toEqual({ x: 0, y: 10 })
    expect(nudgeOf('Enter', false)).toBeNull()
  })
})

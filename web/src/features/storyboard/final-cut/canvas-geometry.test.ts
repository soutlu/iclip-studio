import { describe, expect, it } from 'vitest'
import {
  CYCLE_MS,
  frameContains,
  frameOf,
  nudgeOf,
  pickAt,
  placementOf,
  resizedScale,
  rotatedAngle,
  rotateText,
  scaleText,
  topFirst,
  translateText,
  type ClipBox,
  type Placement,
} from './canvas-geometry'

const NONE: Placement = { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1 }

// 1080 × 1920 的竖画面
const FULL = { x: 0, y: 0, width: 1080, height: 1920 }
const fullBox: ClipBox = { box: FULL, content: FULL }

// 1920 × 1080 的组件按 0.5625 缩小、居中摆在竖画面里（主文件写法里的 itemLayout）：布局框从画面中心起
const hostBox: ClipBox = {
  box: { x: 540, y: 960, width: 1920, height: 1080 },
  content: { x: 0, y: 0, width: 1920, height: 1080 },
}

describe('摆放的写法', () => {
  it('没写是不挪、不转、不缩放', () => {
    expect(placementOf({}, FULL)).toEqual(NONE)
    expect(placementOf({ translate: 'none', rotate: 'none', scale: 'none' }, FULL)).toEqual(NONE)
  })

  it('位移的百分比按元素自己的宽高算，只写一个值时竖着不挪', () => {
    expect(placementOf({ translate: '-50% -50%', scale: '0.5625' }, hostBox.box)).toEqual({
      ...NONE,
      x: -960,
      y: -540,
      scaleX: 0.5625,
      scaleY: 0.5625,
    })
    expect(placementOf({ translate: '120px' }, FULL)).toEqual({ ...NONE, x: 120 })
    expect(placementOf({ translate: '0 0' }, FULL)).toEqual(NONE)
  })

  it('角度认 deg、turn、rad，缩放认两个方向分开写和百分比', () => {
    expect(placementOf({ rotate: '15deg' }, FULL)?.angle).toBe(15)
    expect(placementOf({ rotate: '0.25turn' }, FULL)?.angle).toBe(90)
    expect(placementOf({ rotate: `${Math.PI}rad` }, FULL)?.angle).toBeCloseTo(180)
    expect(placementOf({ scale: '0.5 2' }, FULL)).toMatchObject({ scaleX: 0.5, scaleY: 2 })
    expect(placementOf({ scale: '50%' }, FULL)).toMatchObject({ scaleX: 0.5, scaleY: 0.5 })
  })

  it('读不懂的写法（calc、带 Z 轴、绕别的轴转、没单位的长度）答 null', () => {
    expect(placementOf({ translate: 'calc(10px + 5%) 0px' }, FULL)).toBeNull()
    expect(placementOf({ translate: '10px 10px 5px' }, FULL)).toBeNull()
    expect(placementOf({ rotate: 'x 30deg' }, FULL)).toBeNull()
    expect(placementOf({ rotate: '30' }, FULL)).toBeNull()
    expect(placementOf({ scale: '1 1 2' }, FULL)).toBeNull()
    expect(placementOf({ translate: '10em 0px' }, FULL)).toBeNull()
  })

  it('写回去：位移写像素留三位小数，角度写 deg，缩放两个方向一样时只写一个数', () => {
    expect(translateText(-960.123456, 40)).toBe('-960.123px 40px')
    expect(translateText(-0.0001, 0)).toBe('0px 0px')
    expect(rotateText(-37.50049)).toBe('-37.5deg')
    expect(scaleText(0.5625, 0.5625)).toBe('0.5625')
    expect(scaleText(0.123456, 2)).toBe('0.1235 2')
  })
})

describe('片段在画面上的样子', () => {
  it('没挪时就是布局框；挪了按位移平移', () => {
    expect(frameOf(fullBox, NONE)).toEqual({
      cx: 540,
      cy: 960,
      width: 1080,
      height: 1920,
      angle: 0,
    })
    expect(frameOf(fullBox, { ...NONE, x: 100, y: -50 })).toMatchObject({ cx: 640, cy: 910 })
  })

  it('居中摆放的组件：中心在画面中心，宽高乘缩放', () => {
    const placement = placementOf({ translate: '-50% -50%', scale: '0.5625' }, hostBox.box)
    if (placement === null) throw new Error('读不出摆放')
    expect(frameOf(hostBox, placement)).toEqual({
      cx: 540,
      cy: 960,
      width: 1080,
      height: 607.5,
      angle: 0,
    })
  })

  it('视频只框有画面的那块：横视频放进竖画面，上下的黑边不算；缩放、转都绕元素中心', () => {
    const video: ClipBox = { box: FULL, content: { x: 0, y: 656.25, width: 1080, height: 607.5 } }
    expect(frameOf(video, NONE)).toEqual({ cx: 540, cy: 960, width: 1080, height: 607.5, angle: 0 })
    // 画面偏上一块时，缩一半以后离元素中心的距离也减半，转 90° 以后跑到中心右边
    const top: ClipBox = { box: FULL, content: { x: 0, y: 0, width: 1080, height: 960 } }
    const frame = frameOf(top, { ...NONE, scaleX: 0.5, scaleY: 0.5, angle: 90 })
    expect(frame.cx).toBeCloseTo(540 + 240)
    expect(frame.cy).toBeCloseTo(960)
    expect(frame).toMatchObject({ width: 540, height: 480, angle: 90 })
  })

  it('点在不在框里按转过的框算', () => {
    const frame = { cx: 0, cy: 0, width: 200, height: 20, angle: 90 }
    expect(frameContains(frame, { x: 0, y: 90 })).toBe(true)
    expect(frameContains(frame, { x: 90, y: 0 })).toBe(false)
    expect(frameContains(frame, { x: 5, y: -99 })).toBe(true)
    expect(frameContains(frame, { x: 15, y: -99 })).toBe(false)
  })
})

describe('点选', () => {
  it('从最上面一层往下排：叠放顺序大的在上，一样大时文件里靠后的在上', () => {
    const clips = [
      { id: 'a', z: 1 },
      { id: 'b', z: 3 },
      { id: 'c', z: 1 },
    ]
    expect(topFirst(clips).map((clip) => clip.id)).toEqual(['b', 'c', 'a'])
  })

  const point = { x: 100, y: 100 }

  it('点到的是最上面一层；没点到片段是 null', () => {
    expect(pickAt(['top', 'below'], new Set(), null, point, 0, 4)).toBe('top')
    expect(pickAt([], new Set(['top']), null, point, 0, 4)).toBeNull()
  })

  it('指针下有已经选中的片段时还是它，不被盖在上面的抢走', () => {
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

  it('缩放倍数是指针离中心的距离比，哪个角、转没转都一样', () => {
    expect(resizedScale(frame, NONE, { x: 100, y: 50 }, { x: 200, y: 100 })).toEqual({
      scaleX: 2,
      scaleY: 2,
    })
    expect(
      resizedScale(
        frame,
        { ...NONE, scaleX: 0.5, scaleY: 0.25 },
        { x: -100, y: 0 },
        { x: 0, y: 50 },
      ),
    ).toEqual({ scaleX: 0.25, scaleY: 0.125 })
  })

  it('缩到最短的边是 8 像素就不再缩；按在中心上不缩', () => {
    expect(resizedScale(frame, NONE, { x: 100, y: 0 }, { x: 0.1, y: 0 })).toEqual({
      scaleX: 0.08,
      scaleY: 0.08,
    })
    expect(resizedScale(frame, NONE, { x: 0, y: 0 }, { x: 300, y: 0 })).toEqual({
      scaleX: 1,
      scaleY: 1,
    })
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

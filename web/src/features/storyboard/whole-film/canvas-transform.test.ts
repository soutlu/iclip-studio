import { describe, expect, it } from 'vitest'
import { draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import {
  cornerCursor,
  cornersOf,
  formatRotation,
  formatScale,
  insidePlaced,
  outsideCanvas,
  outsidePictureClip,
  pivotOf,
  placedBox,
  placedOnScreen,
  placementOf,
  rotateGesture,
  scaleGesture,
  transformEditOf,
  type Placed,
  type Placement,
} from './canvas-transform'

const film = () =>
  draftOf([video('v1', 's1', 0, 3_000)], {
    overlays: [
      overlay('o1', 0, 1_000),
      overlay('o2', 0, 1_000, {
        track: 1,
        x: 30,
        y: -20,
        scale: 1.5,
        rotation: -30,
        pivotX: 400,
        pivotY: 900,
      }),
    ],
  })

const at = (placement: Partial<Placement>): Placement => ({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  pivot: { x: 0, y: 0 },
  ...placement,
})

const expectPlaced = (actual: Placed, expected: Placed) => {
  for (const key of ['cx', 'cy', 'width', 'height', 'angle'] as const) {
    expect(actual[key]).toBeCloseTo(expected[key], 6)
  }
}

describe('草稿里的摆放', () => {
  it('取草稿里记着的位置、倍数、角度与转轴', () => {
    expect(placementOf(film(), 'o2')).toEqual({
      x: 30,
      y: -20,
      scale: 1.5,
      rotation: -30,
      pivot: { x: 400, y: 900 },
    })
  })

  it('有这几项之前存的草稿没写，按没挪过、原大、不转算；字幕同样', () => {
    const draft = film()
    const {
      x: _x,
      y: _y,
      scale: _s,
      rotation: _r,
      pivotX: _px,
      pivotY: _py,
      ...captions
    } = draft.captions
    expect(placementOf({ ...draft, captions }, 'captions')).toEqual(at({}))
    expect(placementOf(draft, 'gone')).toEqual(at({}))
  })
})

describe('画面上的一块', () => {
  // 不变换时画在 (100, 200)，宽 80、高 40，中心 (140, 220)
  const local = { left: 100, top: 200, width: 80, height: 40 }

  it('原大、不转时转轴取画出来那块的中心（取整）；缩放或旋转着时沿用记下的', () => {
    expect(pivotOf({ ...local, width: 81 }, at({ pivot: { x: 7, y: 9 } }))).toEqual({
      x: 141,
      y: 220,
    })
    expect(pivotOf(local, at({ scale: 2, pivot: { x: 7, y: 9 } }))).toEqual({ x: 7, y: 9 })
  })

  it('原大、不转时就是画出来那块挪开 (x, y)，同不变换时量的', () => {
    expectPlaced(placedBox(local, at({ x: -30, y: 15, pivot: { x: 999, y: 999 } })), {
      cx: 110,
      cy: 235,
      width: 80,
      height: 40,
      angle: 0,
    })
  })

  it('缩放、旋转绕转轴：中心 = 转轴 + 位移 + R·S·(c0 − 转轴)，宽高乘倍数', () => {
    // 转轴在左上角，顺时针转 90°、放大 2 倍，再往右挪 10
    expectPlaced(
      placedBox(local, at({ x: 10, scale: 2, rotation: 90, pivot: { x: 100, y: 200 } })),
      { cx: 70, cy: 280, width: 160, height: 80, angle: 90 },
    )
    // 绕自己的中心转，中心不动
    expectPlaced(placedBox(local, at({ rotation: -45, pivot: { x: 140, y: 220 } })), {
      cx: 140,
      cy: 220,
      width: 80,
      height: 40,
      angle: -45,
    })
  })

  it('四个角跟着转，次序从左上起顺时针', () => {
    const corners = cornersOf({ cx: 0, cy: 0, width: 4, height: 2, angle: 90 })
    const rounded = corners.map(({ x, y }) => [Math.round(x) + 0, Math.round(y) + 0])
    expect(rounded).toEqual([
      [1, -2],
      [1, 2],
      [-1, 2],
      [-1, -2],
    ])
  })

  it('点在不在转过的一块里，可以四周放宽', () => {
    const placed = { cx: 50, cy: 50, width: 40, height: 10, angle: 90 }
    expect(insidePlaced({ x: 50, y: 68 }, placed)).toBe(true)
    expect(insidePlaced({ x: 68, y: 50 }, placed)).toBe(false)
    expect(insidePlaced({ x: 57, y: 50 }, placed, 3)).toBe(true)
  })

  it('换到屏幕上：乘缩放再加上画面的位置', () => {
    expect(
      placedOnScreen(
        { cx: 90, cy: 160, width: 60, height: 20, angle: 30 },
        { left: 100, top: 40, width: 360, height: 640 },
        2,
      ),
    ).toEqual({ cx: 280, cy: 360, width: 120, height: 40, angle: 30 })
  })
})

describe('伸出画面', () => {
  const canvas = { width: 1080, height: 1920 }

  it('四角都在画面里（贴边也算）时没伸出，一角出去就算', () => {
    expect(outsideCanvas({ cx: 540, cy: 960, width: 1080, height: 1920, angle: 0 }, canvas)).toBe(
      false,
    )
    expect(outsideCanvas({ cx: 1060, cy: 960, width: 60, height: 20, angle: 0 }, canvas)).toBe(true)
    expect(outsideCanvas({ cx: 540, cy: -5, width: 60, height: 20, angle: 0 }, canvas)).toBe(true)
  })

  it('转过的块按转过的四角算', () => {
    // 贴着左边的方块，不转时在画面里，转 45° 后角伸出去
    const square = { cx: 50, cy: 500, width: 100, height: 100, angle: 0 }
    expect(outsideCanvas(square, canvas)).toBe(false)
    expect(outsideCanvas({ ...square, angle: 45 }, canvas)).toBe(true)
  })

  it('画面外的裁切：整张卡片减去画面', () => {
    expect(
      outsidePictureClip(
        { width: 800, height: 600 },
        { left: 220, top: 20, width: 360, height: 560 },
      ),
    ).toBe("path(evenodd, 'M0 0H800V600H0Z M220 20H580V580H220Z')")
  })
})

describe('拖角缩放', () => {
  const pivot = { x: 100, y: 100 }

  it('指针到转轴的距离与按下时之比乘上原来的倍数，取 3 位小数', () => {
    expect(
      scaleGesture({
        pivot,
        start: { x: 150, y: 100 },
        current: { x: 200, y: 100 },
        from: 1.2,
        snap: false,
      }),
    ).toBe(2.4)
    expect(
      scaleGesture({
        pivot,
        start: { x: 130, y: 100 },
        current: { x: 140, y: 100 },
        from: 1,
        snap: false,
      }),
    ).toBe(1.333)
  })

  it('裁在 10%–1000%', () => {
    expect(
      scaleGesture({
        pivot,
        start: { x: 110, y: 100 },
        current: { x: 900, y: 100 },
        from: 1,
        snap: false,
      }),
    ).toBe(10)
    expect(
      scaleGesture({
        pivot,
        start: { x: 200, y: 100 },
        current: { x: 101, y: 100 },
        from: 1,
        snap: false,
      }),
    ).toBe(0.1)
  })

  it('按在转轴上时按 1 像素算，不除以 0', () => {
    expect(
      scaleGesture({ pivot, start: pivot, current: { x: 103, y: 104 }, from: 1, snap: false }),
    ).toBe(5)
  })

  it('吸附开着时离 100% 不到 3% 吸到 100%，关着不吸', () => {
    const near = { pivot, start: { x: 200, y: 100 }, current: { x: 202, y: 100 }, from: 1 }
    expect(scaleGesture({ ...near, snap: true })).toBe(1)
    expect(scaleGesture({ ...near, snap: false })).toBe(1.02)
    expect(
      scaleGesture({
        pivot,
        start: { x: 200, y: 100 },
        current: { x: 204, y: 100 },
        from: 1,
        snap: true,
      }),
    ).toBe(1.04)
  })
})

describe('拖把手旋转', () => {
  const pivot = { x: 0, y: 0 }
  // 指针从正下方出发，绕转轴转到 degrees（屏幕坐标 y 向下，顺时针为正）
  const turn = (from: number, degrees: number, shift = false) =>
    rotateGesture({
      pivot,
      start: { x: 0, y: 100 },
      current: {
        x: 100 * Math.cos(((90 + degrees) * Math.PI) / 180),
        y: 100 * Math.sin(((90 + degrees) * Math.PI) / 180),
      },
      from,
      shift,
    })

  it('指针绕转轴转过的角度加上原来的角度，取 1 位小数', () => {
    expect(turn(0, 30)).toBe(30)
    expect(turn(10, -12.34)).toBe(-2.3)
  })

  it('规整到 (-180, 180]：转过 180° 接到另一头，-180° 记成 180°', () => {
    expect(turn(170, 20)).toBe(-170)
    expect(turn(-170, -20)).toBe(170)
    expect(turn(90, 90)).toBe(180)
    expect(turn(-90, -90)).toBe(180)
    expect(turn(179.96, 0)).toBe(180)
  })

  it('按住 Shift 每 15° 一档', () => {
    expect(turn(0, 22, true)).toBe(15)
    expect(turn(0, 23, true)).toBe(30)
    expect(turn(-10, -2, true)).toBe(-15)
    expect(turn(170, 8, true)).toBe(180)
    expect(turn(-170, -8, true)).toBe(180)
  })
})

describe('读数与指针', () => {
  it('倍数显示百分比，角度取整、负数用减号', () => {
    expect(formatScale(1.204)).toBe('120%')
    expect(formatRotation(-15)).toBe('−15°')
    expect(formatRotation(44.6)).toBe('45°')
    expect(formatRotation(-0.3)).toBe('0°')
  })

  it('角把手的指针随角度对调', () => {
    expect(cornerCursor('nw', 0)).toBe('nwse-resize')
    expect(cornerCursor('ne', 0)).toBe('nesw-resize')
    expect(cornerCursor('nw', 45)).toBe('nesw-resize')
    expect(cornerCursor('se', -90)).toBe('nesw-resize')
    expect(cornerCursor('sw', 135)).toBe('nesw-resize')
    expect(cornerCursor('nw', 180)).toBe('nwse-resize')
  })
})

describe('松手后的缩放、旋转写进草稿', () => {
  it('特效块改那一块；原大、不转时记下转轴', () => {
    const result = transformEditOf(film(), 'o1', {
      scale: 1.2,
      rotation: 0,
      pivot: { x: 140, y: 220 },
    })
    if (result === null) throw new Error('没有处理 o1')
    expect(expectOk(result).draft.overlays[0]).toMatchObject({
      scale: 1.2,
      rotation: 0,
      pivotX: 140,
      pivotY: 220,
    })
  })

  it('字幕改全部字幕；已经缩放旋转着的沿用记下的转轴', () => {
    const draft = film()
    const scaled = transformEditOf(draft, 'captions', {
      scale: 2,
      rotation: 0,
      pivot: { x: 500, y: 1600 },
    })
    if (scaled === null) throw new Error('没有处理字幕')
    const first = expectOk(scaled).draft
    expect(first.captions).toMatchObject({ scale: 2, pivotX: 500, pivotY: 1600 })
    const rotated = transformEditOf(first, 'captions', {
      scale: 2,
      rotation: 15,
      pivot: { x: 1, y: 1 },
    })
    if (rotated === null) throw new Error('没有处理字幕')
    expect(expectOk(rotated).draft.captions).toMatchObject({
      rotation: 15,
      pivotX: 500,
      pivotY: 1600,
    })
  })

  it('草稿里已经没有这一块时不处理', () => {
    expect(
      transformEditOf(film(), 'gone', { scale: 2, rotation: 0, pivot: { x: 0, y: 0 } }),
    ).toBeNull()
  })
})

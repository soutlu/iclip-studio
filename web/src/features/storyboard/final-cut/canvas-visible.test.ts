import { describe, expect, it } from 'vitest'
import type { Frame, Point } from './canvas-geometry'
import { canvasBox, drawnFrame, followFrame, visibleFrame, type ClipBox } from './canvas-visible'

const NO_CROP = { clipPath: 'none', scaleX: 1, scaleY: 1 }

/** 画布上横平竖直的一个裁切框：左上角 (`x`, `y`)、宽高。 */
const box = (x: number, y: number, width: number, height: number, axes = { x: true, y: true }) =>
  ({
    corners: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    ...axes,
  }) satisfies ClipBox

const close = (actual: Frame | null, expected: Frame) => {
  expect(actual).not.toBeNull()
  for (const key of ['cx', 'cy', 'width', 'height', 'angle'] as const)
    expect(actual?.[key]).toBeCloseTo(expected[key], 6)
}

describe('看得见的那一块', () => {
  it('没有裁切、整层都在画布里：就是整层', () => {
    const frame = { cx: 100, cy: 100, width: 80, height: 40, angle: 0 }
    close(visibleFrame(frame, NO_CROP, [canvasBox(480, 854)]), frame)
  })

  it('自己的 inset() 裁切按它画在画布上的缩放收窄', () => {
    const frame = { cx: 100, cy: 100, width: 200, height: 100, angle: 0 }
    const own = { clipPath: 'inset(10px 20px 30px 40px)', scaleX: 0.5, scaleY: 0.5 }
    // 左边收 20、右边收 10、上边收 5、下边收 15
    close(visibleFrame(frame, own, [canvasBox(480, 854)]), {
      cx: 105,
      cy: 95,
      width: 170,
      height: 80,
      angle: 0,
    })
  })

  it('认不出的 clip-path（不是像素的 inset）不收窄', () => {
    const frame = { cx: 100, cy: 100, width: 200, height: 100, angle: 0 }
    const own = { clipPath: 'circle(50% at 50% 50%)', scaleX: 1, scaleY: 1 }
    close(visibleFrame(frame, own, [canvasBox(480, 854)]), frame)
  })

  it('比画面大得多的层被 overflow: hidden 的祖先裁掉：只剩祖先的框里那一块', () => {
    // 镜头抖动那样：里面的层远大于画面，外面一层把它裁到画面里的一块
    const frame = { cx: 240, cy: 427, width: 2000, height: 1600, angle: 0 }
    close(visibleFrame(frame, NO_CROP, [box(100, 200, 280, 400), canvasBox(480, 854)]), {
      cx: 240,
      cy: 400,
      width: 280,
      height: 400,
      angle: 0,
    })
  })

  it('伸出画布的部分不算', () => {
    const frame = { cx: 450, cy: -20, width: 100, height: 100, angle: 0 }
    close(visibleFrame(frame, NO_CROP, [canvasBox(480, 854)]), {
      cx: 440,
      cy: 15,
      width: 80,
      height: 30,
      angle: 0,
    })
  })

  it('只横向裁的祖先（overflow-x）不管竖向', () => {
    const frame = { cx: 100, cy: 100, width: 200, height: 200, angle: 0 }
    close(visibleFrame(frame, NO_CROP, [box(50, 90, 100, 20, { x: true, y: false })]), {
      cx: 100,
      cy: 100,
      width: 100,
      height: 200,
      angle: 0,
    })
  })

  it('转过的层：看得见的那一块和它同一个角度，在它自己的坐标里裁', () => {
    // 转了 90°：在画布上竖着，上下各伸出画布 50
    const frame = { cx: 50, cy: 50, width: 200, height: 40, angle: 90 }
    close(visibleFrame(frame, NO_CROP, [canvasBox(100, 100)]), {
      cx: 50,
      cy: 50,
      width: 100,
      height: 40,
      angle: 90,
    })
  })

  it('裁它的框相对它转了角度：取裁剩的那块在它自己坐标里的外接矩形', () => {
    const frame = { cx: 0, cy: 0, width: 100, height: 100, angle: 0 }
    // 一个转了 45° 的方块，中心在层的右边上：层里只剩它的左半个菱形
    const diamond: ClipBox = {
      corners: [
        { x: 50, y: -30 },
        { x: 80, y: 0 },
        { x: 50, y: 30 },
        { x: 20, y: 0 },
      ],
      x: true,
      y: true,
    }
    close(visibleFrame(frame, NO_CROP, [diamond]), {
      cx: 35,
      cy: 0,
      width: 30,
      height: 60,
      angle: 0,
    })
  })

  it('什么都看不见时是 null，画出来的是整层', () => {
    const frame = { cx: 100, cy: 100, width: 50, height: 50, angle: 0 }
    const visible = visibleFrame(frame, NO_CROP, [box(300, 300, 50, 50)])
    expect(visible).toBeNull()
    expect(drawnFrame({ frame, visible })).toEqual(frame)
  })
})

describe('拖动中画出来的框跟着这一层走', () => {
  const frame = { cx: 100, cy: 100, width: 200, height: 100, angle: 0 }
  // 只看得见右半边
  const shown = { cx: 150, cy: 100, width: 100, height: 100, angle: 0 }
  const corner = (each: Frame): Point => ({
    x: each.cx + each.width / 2,
    y: each.cy - each.height / 2,
  })

  it('挪：一起平移', () => {
    expect(followFrame(shown, frame, { ...frame, cx: 130, cy: 90 })).toEqual({
      ...shown,
      cx: 180,
      cy: 90,
    })
  })

  it('缩放：以这一层的中心缩', () => {
    const resized = followFrame(shown, frame, { ...frame, width: 400, height: 200 })
    expect(resized).toEqual({ cx: 200, cy: 100, width: 200, height: 200, angle: 0 })
    // 右上角和这一层的右上角一起走
    expect(corner(resized)).toEqual({ x: 300, y: 0 })
  })

  it('转：绕这一层的中心转', () => {
    const turned = followFrame(shown, frame, { ...frame, angle: 90 })
    expect(turned.cx).toBeCloseTo(100, 6)
    expect(turned.cy).toBeCloseTo(150, 6)
    expect(turned).toMatchObject({ width: 100, height: 100, angle: 90 })
  })
})

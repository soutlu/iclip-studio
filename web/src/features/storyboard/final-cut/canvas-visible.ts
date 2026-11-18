import { rotated, type Frame, type Point } from './canvas-geometry'
import { hugRectForClipPath } from './vendor/hyperframes-studio/components/editor/domEditOverlayCrop'

/**
 * 画面上一层看得见的那一块：它自己的 `inset()` 裁切（照工作台），再和裁掉它的祖先、画布相交。悬停框、选中框画在
 * 这一块上，缩放、旋转仍按整层的框（`frame`）算。坐标都是 final-cut 画布的像素。
 */

/**
 * 裁掉里面内容的一个框（一个祖先 `overflow` 不是 `visible` 时的内边距框，或者画布）：四个角（左上、右上、右下、
 * 左下，画布像素）；`x` 是它沿自己横向裁、`y` 是沿竖向裁（`overflow-x`、`overflow-y` 各管一个方向）。
 */
export type ClipBox = {
  corners: readonly [Point, Point, Point, Point]
  x: boolean
  y: boolean
}

/** 画布本身：`width` × `height`，两个方向都裁。 */
export const canvasBox = (width: number, height: number): ClipBox => ({
  corners: [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ],
  x: true,
  y: true,
})

/** 一层自己的裁切：`clip-path` 的写法（读不出时 null），和它一个 CSS 像素在画布上的宽、高。 */
export type OwnClip = { clipPath: string | null; scaleX: number; scaleY: number }

const cross = (a: Point, b: Point, p: Point) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

/** 凸多边形留下直线 `a`→`b` 上和 `inside` 同一边的部分（边上也留）；`inside` 就在线上时什么都不留。 */
const keepSide = (polygon: readonly Point[], a: Point, b: Point, inside: Point): Point[] => {
  const sign = Math.sign(cross(a, b, inside))
  if (sign === 0) return []
  const side = (p: Point) => sign * cross(a, b, p)
  const kept: Point[] = []
  polygon.forEach((current, at) => {
    const next = polygon[(at + 1) % polygon.length] ?? current
    const here = side(current)
    const there = side(next)
    const hereKept = here >= 0
    if (hereKept) kept.push(current)
    if (hereKept !== there >= 0) {
      const t = here / (here - there)
      kept.push({
        x: current.x + (next.x - current.x) * t,
        y: current.y + (next.y - current.y) * t,
      })
    }
  })
  return kept
}

const areaOf = (polygon: readonly Point[]) =>
  Math.abs(
    polygon.reduce((sum, p, at) => {
      const q = polygon[(at + 1) % polygon.length] ?? p
      return sum + p.x * q.y - q.x * p.y
    }, 0),
  ) / 2

/** 小于这么多平方像素就算什么都看不见。 */
const EMPTY_AREA = 1e-6

/**
 * 一层看得见的那一块，和它的框 `frame` 同一个角度：先按它自己的 `inset()` 裁切收窄（`own`，照工作台
 * `hugRectForClipPath`），再依次和 `clips` 里每个框相交。都在这一层自己的坐标里算（中心在 `frame` 中心、沿它的
 * 角度）；裁它的框转了角度时，交出来的不是矩形，取它在这一层坐标里的外接矩形。什么都看不见（或算不出）时是 null。
 */
export function visibleFrame(frame: Frame, own: OwnClip, clips: readonly ClipBox[]): Frame | null {
  const center = { x: frame.cx, y: frame.cy }
  const toLocal = (p: Point) => rotated({ x: p.x - center.x, y: p.y - center.y }, -frame.angle)
  const cropped = hugRectForClipPath(
    {
      left: -frame.width / 2,
      top: -frame.height / 2,
      width: frame.width,
      height: frame.height,
      editScaleX: own.scaleX,
      editScaleY: own.scaleY,
    },
    own.clipPath,
  )
  let polygon: Point[] = [
    { x: cropped.left, y: cropped.top },
    { x: cropped.left + cropped.width, y: cropped.top },
    { x: cropped.left + cropped.width, y: cropped.top + cropped.height },
    { x: cropped.left, y: cropped.top + cropped.height },
  ]
  for (const clip of clips) {
    const [nw, ne, se, sw] = clip.corners.map(toLocal) as [Point, Point, Point, Point]
    // 横向裁：左边、右边两条线之间；竖向裁：上边、下边两条线之间
    if (clip.x) polygon = keepSide(keepSide(polygon, nw, sw, ne), ne, se, nw)
    if (clip.y) polygon = keepSide(keepSide(polygon, nw, ne, sw), sw, se, nw)
    if (polygon.length < 3) return null
  }
  if (!(areaOf(polygon) > EMPTY_AREA)) return null
  const xs = polygon.map((p) => p.x)
  const ys = polygon.map((p) => p.y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const middle = rotated({ x: (left + right) / 2, y: (top + bottom) / 2 }, frame.angle)
  const visible = {
    cx: center.x + middle.x,
    cy: center.y + middle.y,
    width: right - left,
    height: bottom - top,
    angle: frame.angle,
  }
  return Object.values(visible).every(Number.isFinite) ? visible : null
}

/** 一层在画面上画出来的框：看得见的那一块；什么都看不见时画整层。 */
export const drawnFrame = (measure: { frame: Frame; visible: Frame | null }): Frame =>
  measure.visible ?? measure.frame

/**
 * 拖动中画出来的框跟着这一层走：`box` 是按下时画的框，`from` 是按下时这一层的框，`to` 是它现在（草稿）的框。
 * 挪是平移，缩放是以这一层的中心缩，转是绕这一层的中心转。
 */
export function followFrame(box: Frame, from: Frame, to: Frame): Frame {
  const scaleX = from.width > 0 ? to.width / from.width : 1
  const scaleY = from.height > 0 ? to.height / from.height : 1
  const offset = rotated({ x: box.cx - from.cx, y: box.cy - from.cy }, -from.angle)
  const moved = rotated({ x: offset.x * scaleX, y: offset.y * scaleY }, to.angle)
  return {
    cx: to.cx + moved.x,
    cy: to.cy + moved.y,
    width: box.width * scaleX,
    height: box.height * scaleY,
    angle: box.angle + to.angle - from.angle,
  }
}

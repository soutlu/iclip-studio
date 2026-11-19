import { rotated, type Frame, type Point } from './canvas-geometry'
import { hugRectForClipPath } from './vendor/hyperframes-studio/components/editor/domEditOverlayCrop'

/**
 * 图层可见裁剪框计算：先应用元素自身的 `inset()` 裁切（对齐上游 Studio），再与溢出裁剪祖先及画布边界求交。
 * 悬停框与选中框贴合可见区域绘制；缩放与旋转的几何中心仍以完整图层框（`frame`）为准。坐标单位均为 final-cut 画布像素。
 */

/**
 * 裁剪边界框（`overflow` 非 `visible` 的祖先内边距框或画布本身）：
 * `corners` 为顺时针四角坐标（左上、右上、右下、左下，画布像素），`x` / `y` 标识是否在对应局部轴向上裁剪（对应 `overflow-x` / `overflow-y`）。
 */
export type ClipBox = {
  corners: readonly [Point, Point, Point, Point]
  x: boolean
  y: boolean
}

/** 构造画布自身的双向裁剪框（`width` × `height`）。 */
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

/** 元素自身的裁切信息：`clip-path` 字符串（无法读取时为 `null`）及 1 CSS 像素对应的画布缩放比。 */
export type OwnClip = { clipPath: string | null; scaleX: number; scaleY: number }

const cross = (a: Point, b: Point, p: Point) =>
  (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

/** 用有向直线 `a`→`b` 裁剪凸多边形，保留与参考点 `inside` 同侧（含边界）的部分；`inside` 共线时返回空集。 */
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

/** 交集面积低于该阈值（平方像素）时视作完全不可见。 */
const EMPTY_AREA = 1e-6

/**
 * 计算与 `frame` 同角度的可见外接框：
 * 在图层局部坐标系（以 `frame` 中心为原点、沿 `frame.angle` 定向）内，先按自身 `inset()` 收窄（复用上游 Studio `hugRectForClipPath`），
 * 再依次与 `clips` 各边界做半平面交集裁剪；裁剪框与图层存在夹角时取交集多边形在局部坐标系下的外接矩形。完全不可见或数值退化时返回 `null`。
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
    // 横向裁剪保留左右两条边之间，纵向裁剪保留上下两条边之间
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

/** 取画布绘制用的线框：优先使用可见区域，完全不可见时回退为完整图层框。 */
export const drawnFrame = (measure: { frame: Frame; visible: Frame | null }): Frame =>
  measure.visible ?? measure.frame

/**
 * 拖拽期间令绘制线框跟随图层草稿同步变换：`box` 为按下时的初始绘制框，`from` 为初始完整图层框，`to` 为当前草稿框
 * （平移跟随位移，缩放与旋转均围绕 `from` / `to` 中心计算）。
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

/**
 * 预览画面上特效块与字幕的摆放：草稿里的位置、倍数、角度与转轴怎么换成画面上的一块，拖四角缩放、
 * 拖把手旋转怎么算，伸出画面没有，松手后怎么写进草稿。手势的接线在 canvas-layer.tsx。
 *
 * 合成页里这几项写在铺满画面的外层（.place）上：CSS 按 translate → rotate → scale 的次序合成，
 * 转轴（transform-origin）是挪开之前的画布像素。所以一块没缩放、没旋转、没挪开时画出来的中心 c0
 * 落到 pivot + (x, y) + R·S·(c0 − pivot)。
 */
import { CAPTIONS_HF_ID } from './composition/build'
import { setCaptionsTransform } from './editing/captions'
import {
  MAX_SCALE,
  MIN_SCALE,
  normalizeDegrees,
  toOffset,
  type TransformArgs,
  type WholeFilmDraft,
} from './editing/draft'
import { setOverlayTransform } from './editing/overlays'
import type { EditResult } from './editing/result'
import type { Box } from './painted-bounds'

export type Point = { x: number; y: number }

/** 一块在草稿里的摆放：挪开的位置、倍数、顺时针角度与记下的转轴，都是画布像素 */
export type Placement = { x: number; y: number; scale: number; rotation: number; pivot: Point }

/** 画面上的一块：中心、宽高与顺时针角度（宽高是转之前的） */
export type Placed = { cx: number; cy: number; width: number; height: number; angle: number }

/** 选中框四角，顺时针从左上起 */
export const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
export type Corner = (typeof CORNERS)[number]

/** 吸附开着时，缩放到离 100% 不到这么多就吸到 100% */
const SCALE_SNAP = 0.03
/** 按住 Shift 旋转时每一档的角度，同 Studio */
const ROTATION_STEP = 15

const rad = (degrees: number) => (degrees * Math.PI) / 180

const isIdentity = (placement: Placement) => placement.scale === 1 && placement.rotation === 0

const centerOf = (box: Box): Point => ({
  x: box.left + box.width / 2,
  y: box.top + box.height / 2,
})

/**
 * 这一块（data-hf-id 是特效块的草稿 id 或全部字幕）在草稿里的摆放；有这几项之前存的草稿没写，
 * 按没挪过、原大、不转、转轴 (0, 0) 算
 */
export function placementOf(draft: WholeFilmDraft, target: string): Placement {
  const item =
    target === CAPTIONS_HF_ID ? draft.captions : draft.overlays.find((o) => o.id === target)
  return {
    x: item?.x ?? 0,
    y: item?.y ?? 0,
    scale: item?.scale ?? 1,
    rotation: item?.rotation ?? 0,
    pivot: { x: item?.pivotX ?? 0, y: item?.pivotY ?? 0 },
  }
}

/**
 * 缩放、旋转绕的转轴（挪开之前的画布像素）：已经缩放或旋转着时是草稿里记下的；原大、不转时取这一块
 * 不变换时画出来那块的中心，取整同草稿，松手写进草稿后画面不跳。`local` 是那块的范围。
 */
export function pivotOf(local: Box, placement: Placement): Point {
  if (!isIdentity(placement)) return placement.pivot
  const center = centerOf(local)
  return { x: toOffset(center.x), y: toOffset(center.y) }
}

/** 不变换时画出来的范围 `local` 按摆放换到画面上（画布像素），宽高乘上倍数，角度同摆放 */
export function placedBox(local: Box, placement: Placement): Placed {
  const pivot = pivotOf(local, placement)
  const center = centerOf(local)
  const { scale, rotation } = placement
  const cos = Math.cos(rad(rotation))
  const sin = Math.sin(rad(rotation))
  const dx = (center.x - pivot.x) * scale
  const dy = (center.y - pivot.y) * scale
  return {
    cx: pivot.x + placement.x + dx * cos - dy * sin,
    cy: pivot.y + placement.y + dx * sin + dy * cos,
    width: local.width * scale,
    height: local.height * scale,
    angle: rotation,
  }
}

/** 一块转过之后的四个角，次序同 {@link CORNERS} */
export function cornersOf(placed: Placed): Point[] {
  const cos = Math.cos(rad(placed.angle))
  const sin = Math.sin(rad(placed.angle))
  const halfW = placed.width / 2
  const halfH = placed.height / 2
  return [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ].map(([x = 0, y = 0]) => ({
    x: placed.cx + x * cos - y * sin,
    y: placed.cy + x * sin + y * cos,
  }))
}

/** 这一点落在转过的这一块里（含边，四周再放宽 `margin`） */
export function insidePlaced(point: Point, placed: Placed, margin = 0): boolean {
  // 把点转回这一块没转时的坐标里再比
  const cos = Math.cos(rad(-placed.angle))
  const sin = Math.sin(rad(-placed.angle))
  const dx = point.x - placed.cx
  const dy = point.y - placed.cy
  const x = dx * cos - dy * sin
  const y = dx * sin + dy * cos
  return Math.abs(x) <= placed.width / 2 + margin && Math.abs(y) <= placed.height / 2 + margin
}

/** 转过的这一块有一角伸出画面（画布像素，容差半个像素） */
export function outsideCanvas(placed: Placed, canvas: { width: number; height: number }): boolean {
  return cornersOf(placed).some(
    (corner) =>
      corner.x < -0.5 ||
      corner.y < -0.5 ||
      corner.x > canvas.width + 0.5 ||
      corner.y > canvas.height + 0.5,
  )
}

/**
 * 画面上的一块换到屏幕上：`picture` 是画面在屏幕上的范围（同一个坐标系），`scale` 是画布 1 像素在
 * 屏幕上多宽
 */
export function placedOnScreen(placed: Placed, picture: Box, scale: number): Placed {
  return {
    cx: picture.left + placed.cx * scale,
    cy: picture.top + placed.cy * scale,
    width: placed.width * scale,
    height: placed.height * scale,
    angle: placed.angle,
  }
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y)
const angleOf = (from: Point, to: Point) =>
  (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI

/**
 * 拖角把手缩放：指针到转轴的距离与按下时之比，乘上按下时的倍数，裁在 10%–1000%；吸附开着时离 100%
 * 不到 3% 吸到 100%。取 3 位小数。点都在同一个屏幕坐标系里。
 */
export function scaleGesture(args: {
  pivot: Point
  start: Point
  current: Point
  from: number
  snap: boolean
}): number {
  const ratio = distance(args.pivot, args.current) / Math.max(1, distance(args.pivot, args.start))
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, args.from * ratio))
  if (args.snap && Math.abs(next - 1) < SCALE_SNAP) return 1
  return Math.round(next * 1000) / 1000
}

/**
 * 拖旋转把手：同 Studio 的 resolveDomEditRotationGesture，指针绕转轴转过的角度加上按下时的角度，
 * 规整到 (-180, 180]；按住 Shift 每 15° 一档。取 1 位小数。
 */
export function rotateGesture(args: {
  pivot: Point
  start: Point
  current: Point
  from: number
  shift: boolean
}): number {
  const delta = normalizeDegrees(
    angleOf(args.pivot, args.current) - angleOf(args.pivot, args.start),
  )
  let next = normalizeDegrees(args.from + delta)
  if (args.shift) next = normalizeDegrees(Math.round(next / ROTATION_STEP) * ROTATION_STEP)
  // 取整后 -179.96 会变成 -180，再规整一次记成 180
  return normalizeDegrees(Math.round(next * 10) / 10)
}

/** 缩放时旁边显示的倍数，如「120%」 */
export const formatScale = (scale: number) => `${Math.round(scale * 100)}%`

/** 旋转时旁边显示的角度，取整，负数用真正的减号，如「−15°」 */
export const formatRotation = (rotation: number) => {
  const degrees = Math.round(rotation) + 0
  return degrees < 0 ? `−${-degrees}°` : `${degrees}°`
}

/**
 * 角把手上的指针：左上、右下两角是 ↖↘，另外两角是 ↗↙；这一块转到 [45°, 135°)（每 180° 一样）时对调，
 * 指针方向跟着角走
 */
export function cornerCursor(corner: Corner, rotation: number): 'nwse-resize' | 'nesw-resize' {
  const turned = ((rotation % 180) + 180) % 180
  const swapped = turned >= 45 && turned < 135
  const diagonal = corner === 'nw' || corner === 'se'
  return diagonal !== swapped ? 'nwse-resize' : 'nesw-resize'
}

/**
 * 只露出画面外的裁切：整张预览卡片减去画面（evenodd），给画面外的轮廓用。坐标都是卡片自己的。
 */
export function outsidePictureClip(card: { width: number; height: number }, picture: Box): string {
  const right = picture.left + picture.width
  const bottom = picture.top + picture.height
  return (
    `path(evenodd, 'M0 0H${card.width}V${card.height}H0Z ` +
    `M${picture.left} ${picture.top}H${right}V${bottom}H${picture.left}Z')`
  )
}

/**
 * 松手后的缩放、旋转写进草稿：拖的是字幕就改全部字幕，是特效块就改那一块；草稿里已经没有这一块时
 * 返回 null。`pivot` 见 {@link pivotOf}。
 */
export function transformEditOf(
  draft: WholeFilmDraft,
  target: string,
  args: TransformArgs,
): EditResult | null {
  if (target === CAPTIONS_HF_ID) return setCaptionsTransform(draft, args)
  if (!draft.overlays.some((overlay) => overlay.id === target)) return null
  return setOverlayTransform(draft, { overlayId: target, ...args })
}

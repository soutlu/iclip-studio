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

export type Placement = { x: number; y: number; scale: number; rotation: number; pivot: Point }

export type Placed = { cx: number; cy: number; width: number; height: number; angle: number }

export const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
export type Corner = (typeof CORNERS)[number]

const SCALE_SNAP = 0.03
const ROTATION_STEP = 15

const rad = (degrees: number) => (degrees * Math.PI) / 180

const isIdentity = (placement: Placement) => placement.scale === 1 && placement.rotation === 0

const centerOf = (box: Box): Point => ({
  x: box.left + box.width / 2,
  y: box.top + box.height / 2,
})

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

export function pivotOf(local: Box, placement: Placement): Point {
  if (!isIdentity(placement)) return placement.pivot
  const center = centerOf(local)
  return { x: toOffset(center.x), y: toOffset(center.y) }
}

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

export function insidePlaced(point: Point, placed: Placed, margin = 0): boolean {
  const cos = Math.cos(rad(-placed.angle))
  const sin = Math.sin(rad(-placed.angle))
  const dx = point.x - placed.cx
  const dy = point.y - placed.cy
  const x = dx * cos - dy * sin
  const y = dx * sin + dy * cos
  return Math.abs(x) <= placed.width / 2 + margin && Math.abs(y) <= placed.height / 2 + margin
}

export function outsideCanvas(placed: Placed, canvas: { width: number; height: number }): boolean {
  return cornersOf(placed).some(
    (corner) =>
      corner.x < -0.5 ||
      corner.y < -0.5 ||
      corner.x > canvas.width + 0.5 ||
      corner.y > canvas.height + 0.5,
  )
}

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
  return normalizeDegrees(Math.round(next * 10) / 10)
}

export const formatScale = (scale: number) => `${Math.round(scale * 100)}%`

export const formatRotation = (rotation: number) => {
  const degrees = Math.round(rotation) + 0
  return degrees < 0 ? `−${-degrees}°` : `${degrees}°`
}

export function cornerCursor(corner: Corner, rotation: number): 'nwse-resize' | 'nesw-resize' {
  const turned = ((rotation % 180) + 180) % 180
  const swapped = turned >= 45 && turned < 135
  const diagonal = corner === 'nw' || corner === 'se'
  return diagonal !== swapped ? 'nwse-resize' : 'nesw-resize'
}

export function outsidePictureClip(card: { width: number; height: number }, picture: Box): string {
  const right = picture.left + picture.width
  const bottom = picture.top + picture.height
  return (
    `path(evenodd, 'M0 0H${card.width}V${card.height}H0Z ` +
    `M${picture.left} ${picture.top}H${right}V${bottom}H${picture.left}Z')`
  )
}

export function transformEditOf(
  draft: WholeFilmDraft,
  target: string,
  args: TransformArgs,
): EditResult | null {
  if (target === CAPTIONS_HF_ID) return setCaptionsTransform(draft, args)
  if (!draft.overlays.some((overlay) => overlay.id === target)) return null
  return setOverlayTransform(draft, { overlayId: target, ...args })
}

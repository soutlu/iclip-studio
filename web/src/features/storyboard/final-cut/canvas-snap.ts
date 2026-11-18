import type { Point } from './canvas-geometry'
import type { Rect } from './preview-canvas'
import {
  buildCompositionSnapTarget,
  extractSnapTargets,
  resolveEquidistanceGuides,
  resolveGuideLineRect,
  resolveSnapAdjustment,
  snapEngagedForTravel,
  SNAP_THRESHOLD_PX,
  type Rect as ScreenRect,
} from './vendor/hyperframes-studio/components/editor/snapEngine'

/**
 * 画面上拖着挪层时的吸附，照工作台：拖的层的边、中线靠近别的层或画布的边、中线（屏幕上 `SNAP_THRESHOLD_PX` 以内）
 * 时吸过去，画出对齐线；和左右（上下）相邻的层间距相等时标出间距（只标不吸）。吸附引擎按屏幕像素算，这里把画布
 * 像素换过去、算完换回来。只在挪的时候吸，缩放、转、方向键都不吸。
 */

/** 挪的时候吸附用的矩形（画布像素）：要挪的那几层合起来的框，和能吸过去的别的层（不含画布）。 */
export type SnapRects = { moving: Rect; targets: readonly Rect[] }

/** 编辑层上的一个框（屏幕像素，相对画布左上角），`key` 是它在这一刻的参考线里的身份。 */
type Box = { key: string; left: number; top: number; width: number; height: number }

/** 拖动中画的参考线：对齐线，和标着间距（画布像素）的等距标记。 */
export type SnapGuides = {
  lines: readonly Box[]
  spacings: readonly (Box & { axis: 'x' | 'y'; gap: number })[]
}

/** 最多画几条对齐线、几个等距标记（工作台 `SnapGuideOverlay`）。 */
const MAX_GUIDES = 6
const MAX_SPACING_GUIDES = 4

/** 只挪一层、它转过这么多度（及以上）时不吸（工作台 `ROTATED_SNAP_BYPASS_DEGREES`）：吸的是横平竖直的框。 */
const ROTATED_SNAP_BYPASS_DEGREES = 0.5

type SnapInput = {
  /** 指针拖过的距离（画布像素）。 */
  delta: Point
  /** 画布一像素在屏幕上多宽。 */
  zoom: number
  /** 预览页量回来的矩形；还没回来、量不到时是 null。 */
  rects: SnapRects | null
  canvas: { width: number; height: number }
  /** 按住 Alt：不吸，也不画参考线。 */
  alt: boolean
  /** 只挪一层时它在画面上的角度；挪好几层时是 null（不看角度）。 */
  angle: number | null
}

/**
 * 挪的这一下吸附以后实际挪多少（画布像素），和要画的参考线（没有时 null）。照工作台：没有别的层可吸时连画布也
 * 不吸；拖过 `snapEngagedForTravel` 的距离以前不吸（好几层一起挪时这时也不画间距）；只挪一层、转过
 * `ROTATED_SNAP_BYPASS_DEGREES` 时不吸。
 */
export function snapDrag({ delta, zoom, rects, canvas, alt, angle }: SnapInput): {
  delta: Point
  guides: SnapGuides | null
} {
  const unsnapped = { delta, guides: null }
  if (rects === null || rects.targets.length === 0 || !(zoom > 0)) return unsnapped
  if (angle !== null && Math.abs(angle) >= ROTATED_SNAP_BYPASS_DEGREES) return unsnapped
  const toScreen = (rect: Rect): ScreenRect => ({
    left: rect.x * zoom,
    top: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  })
  const composition = toScreen({ x: 0, y: 0, width: canvas.width, height: canvas.height })
  const targets = [
    ...extractSnapTargets(
      rects.targets.map((rect, at) => ({ rect: toScreen(rect), id: `snap-target-${at}` })),
    ),
    buildCompositionSnapTarget(composition),
  ]
  const movingRect = toScreen(rects.moving)
  const proposedDx = delta.x * zoom
  const proposedDy = delta.y * zoom
  const engaged = snapEngagedForTravel(proposedDx, proposedDy)
  if (angle === null && !engaged) return unsnapped
  const snap = resolveSnapAdjustment({
    movingRect,
    proposedDx,
    proposedDy,
    disabledForTravel: !engaged,
    targets,
    threshold: SNAP_THRESHOLD_PX,
    disabled: alt,
  })
  const spacings = alt
    ? []
    : resolveEquidistanceGuides({
        movingRect: {
          ...movingRect,
          left: movingRect.left + snap.dx,
          top: movingRect.top + snap.dy,
        },
        targets,
        threshold: SNAP_THRESHOLD_PX,
      })
  // 引擎对同一条线只报一次；同一个间距可能在相邻的两组里各报一次，画一个
  const shownSpacings = new Map(
    spacings
      .slice(0, MAX_SPACING_GUIDES)
      .map((spacing) => [
        `${spacing.axis}${spacing.position}/${spacing.from}/${spacing.to}/${spacing.size}`,
        spacing,
      ]),
  )
  const guides: SnapGuides = {
    lines: snap.guides.slice(0, MAX_GUIDES).map((guide) => ({
      key: `${guide.axis}${guide.position}`,
      ...resolveGuideLineRect(guide, composition),
    })),
    spacings: [...shownSpacings].map(([key, spacing]) => ({
      key,
      axis: spacing.axis,
      ...(spacing.axis === 'x'
        ? {
            left: spacing.position,
            top: spacing.from,
            width: spacing.size,
            height: spacing.to - spacing.from,
          }
        : {
            left: spacing.from,
            top: spacing.position,
            width: spacing.to - spacing.from,
            height: spacing.size,
          }),
      // 标的是画布像素（工作台标的是屏幕像素）
      gap: Math.round(spacing.size / zoom),
    })),
  }
  return {
    // 没吸的方向照指针走，不经两次换算
    delta: {
      x: snap.dx === proposedDx ? delta.x : snap.dx / zoom,
      y: snap.dy === proposedDy ? delta.y : snap.dy / zoom,
    },
    guides: guides.lines.length === 0 && guides.spacings.length === 0 ? null : guides,
  }
}

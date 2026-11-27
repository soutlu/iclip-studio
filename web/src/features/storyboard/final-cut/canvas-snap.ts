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
 * 画布拖拽移动时的对齐吸附与参考线计算（对齐上游 Studio）：
 * - 当被拖图层的四边或中心线靠近其他图层或画布边界/中线（屏幕距离在 `SNAP_THRESHOLD_PX` 内）时吸附并绘制对齐线；
 * - 与左右/上下相邻图层间距相等时仅标注等距参考线（不额外吸附）。
 * 底层吸附引擎工作在屏幕像素空间，本模块负责画布像素与屏幕像素的双向换算。仅用于鼠标拖拽移动（缩放、旋转与方向键微调不触发）。
 */

/** 拖拽吸附输入矩形（画布像素）：`moving` 为被拖图层的联合外框，`targets` 为其他可吸附图层外框（不含画布自身）。 */
export type SnapRects = { moving: Rect; targets: readonly Rect[] }

/** 叠层参考线矩形（屏幕像素，相对画布左上角），`key` 为渲染稳定标识。 */
type Box = { key: string; left: number; top: number; width: number; height: number }

/** 拖拽期间展示的参考线：对齐实线（`lines`）与标注画布像素间距的等距指示（`spacings`）。 */
export type SnapGuides = {
  lines: readonly Box[]
  spacings: readonly (Box & { axis: 'x' | 'y'; gap: number })[]
}

/** 对齐线与等距标记的最大展示条数（对齐上游 Studio `SnapGuideOverlay`）。 */
const MAX_GUIDES = 6
const MAX_SPACING_GUIDES = 4

/** 单图层旋转角度达到该阈值（度）时跳过轴向矩形吸附（对齐上游 Studio `ROTATED_SNAP_BYPASS_DEGREES`）。 */
const ROTATED_SNAP_BYPASS_DEGREES = 0.5

type SnapInput = {
  /** 指针累计拖拽位移（画布像素）。 */
  delta: Point
  /** 画布 1 像素对应的屏幕像素宽度。 */
  zoom: number
  /** 预览页实测的吸附矩形；尚未返回或无法测量时为 `null`。 */
  rects: SnapRects | null
  canvas: { width: number; height: number }
  /** 按住 Alt 时临时禁用吸附与参考线。 */
  alt: boolean
  /** 单选拖拽时的图层角度；多选拖拽为 `null`（不按角度跳过）。 */
  angle: number | null
}

/**
 * 计算单次拖拽经吸附修正后的实际位移（画布像素）及参考线（无参考线时为 `null`）。
 * 即使画布中无其他目标图层，仍支持向画布四边与中心线吸附（上游 Studio 在无其他图层时会一并跳过画布吸附，此处保留以便单个元素片段居中对齐）。
 * 拖拽行程未达 `snapEngagedForTravel` 前不触发吸附（多选时亦不显示等距线）；单图层旋转达 `ROTATED_SNAP_BYPASS_DEGREES` 时跳过吸附。
 */
export function snapDrag({ delta, zoom, rects, canvas, alt, angle }: SnapInput): {
  delta: Point
  guides: SnapGuides | null
} {
  const unsnapped = { delta, guides: null }
  if (rects === null || !(zoom > 0)) return unsnapped
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
  // 对齐线由引擎去重；同一段等距间隙可能在相邻配对中重复出现，按坐标键去重
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
      // 间距数值按画布像素展示（而非屏幕缩放后的像素）
      gap: Math.round(spacing.size / zoom),
    })),
  }
  return {
    // 未触发吸附的轴直接使用原始画布位移，避免乘除缩放引入浮点误差
    delta: {
      x: snap.dx === proposedDx ? delta.x : snap.dx / zoom,
      y: snap.dy === proposedDy ? delta.y : snap.dy / zoom,
    },
    guides: guides.lines.length === 0 && guides.spacings.length === 0 ? null : guides,
  }
}

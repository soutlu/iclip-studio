/**
 * 预览画布编辑（点选、拖拽、缩放、旋转）的纯几何计算，坐标单位均为 final-cut 画布像素。
 * 图层初始边界由预览页实测返回（见 preview-canvas.ts），拖拽期间由编辑器结合指针位置实时计算草稿框。
 */

export type Point = { x: number; y: number }

/** 画布上的旋转矩形：中心坐标、宽高与顺时针旋转角度（度）。 */
export type Frame = { cx: number; cy: number; width: number; height: number; angle: number }

const radians = (degrees: number) => (degrees * Math.PI) / 180

/** 将向量 (`x`, `y`) 顺时针旋转 `degrees` 度。 */
export const rotated = ({ x, y }: Point, degrees: number): Point => {
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** 上一次画布点选记录：点击坐标、时间戳（毫秒）与命中的图层键。 */
export type CanvasPick = { point: Point; at: number; id: string }

/** 同位置连续点击循环切换下层图层的时间窗口（毫秒，对齐上游 Studio）。 */
export const CYCLE_MS = 600

/**
 * 计算画布点击应选中的图层：
 * `hits` 为指针下从上到下排列的命中图层列表（贴片与场景整体作为一层，见预览页 `pick`）；`last` 为上次点选记录（按下阶段不触发换层，传 `null`）。
 *
 * - 在 `CYCLE_MS` 内于原位置 `tolerance` 范围内再次点击：切换到上次命中图层的下一层，到底后回绕至顶层；
 * - 指针下包含已选中图层：保持选中该层（便于直接按住拖拽，避免被上方图层抢占）；
 * - 其余情况选中最顶层（无命中时返回 `null`）。
 */
export function pickAt(
  hits: readonly string[],
  selected: ReadonlySet<string>,
  last: CanvasPick | null,
  point: Point,
  now: number,
  tolerance: number,
): string | null {
  const [top] = hits
  if (top === undefined) return null
  if (
    last !== null &&
    now - last.at <= CYCLE_MS &&
    Math.hypot(point.x - last.point.x, point.y - last.point.y) <= tolerance
  ) {
    const at = hits.indexOf(last.id)
    if (at >= 0) return hits[(at + 1) % hits.length] ?? top
  }
  return hits.find((id) => selected.has(id)) ?? top
}

/** 缩放时短边保留的最小布局像素（对齐上游 Studio `MIN_RESIZE_LOCAL_PX`）。 */
export const MIN_EDGE = 1

/**
 * 拖拽四角控制柄时的中心等比缩放倍率：按当前指针与按下位置到图层中心的距离比计算，与拖拽角及旋转角度无关
 * （对齐上游 Studio `domEditResizeLocal.ts` 的 `resolveCenterResizeSize`）。
 * 按在中心点附近时返回 `1`，短边缩至 `MIN_EDGE` 布局像素时封底。
 */
export function resizeRatio(
  frame: Frame,
  size: { width: number; height: number },
  pointerStart: Point,
  pointer: Point,
): number {
  const from = Math.hypot(pointerStart.x - frame.cx, pointerStart.y - frame.cy)
  if (!Number.isFinite(from) || from < 0.5) return 1
  const least = MIN_EDGE / Math.min(Math.max(size.width, MIN_EDGE), Math.max(size.height, MIN_EDGE))
  return Math.max(least, Math.hypot(pointer.x - frame.cx, pointer.y - frame.cy) / from)
}

/** 拖拽四角控制柄缩放后的布局宽高（未取整，倍率见 `resizeRatio`）。 */
export function resizedSize(
  frame: Frame,
  size: { width: number; height: number },
  pointerStart: Point,
  pointer: Point,
): { width: number; height: number } {
  const width = Math.max(size.width, MIN_EDGE)
  const height = Math.max(size.height, MIN_EDGE)
  const ratio = resizeRatio(frame, size, pointerStart, pointer)
  return { width: width * ratio, height: height * ratio }
}

/** 按住 Shift 旋转时的角度吸附步长（度）。 */
export const ROTATION_SNAP_DEGREES = 15

const round3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

const degreesTo = (center: Point, point: Point) =>
  (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI

/**
 * 拖拽旋转控制柄后的目标角度：在初始角度 `angle` 上叠加指针绕中心转过的角度差；
 * `snap`（按住 Shift）时吸附到 `ROTATION_SNAP_DEGREES` 的整数倍，否则保留三位小数（对齐上游 Studio `resolveDomEditRotationGesture`）。
 */
export function rotatedAngle(
  center: Point,
  angle: number,
  pointerStart: Point,
  pointer: Point,
  snap: boolean,
): number {
  const turned = degreesTo(center, pointer) - degreesTo(center, pointerStart)
  const delta = ((((turned + 180) % 360) + 360) % 360) - 180
  const next = angle + delta
  return snap
    ? round3(Math.round(next / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES)
    : round3(next)
}

/** 方向键单次微调步长（像素）：按住 Shift 为 `10`，否则为 `1`。 */
export const nudgeStep = (shift: boolean): number => (shift ? 10 : 1)

/** 将方向键映射为位移向量；非方向键返回 `null`。 */
export function nudgeOf(key: string, shift: boolean): Point | null {
  const step = nudgeStep(shift)
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 }
    case 'ArrowRight':
      return { x: step, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -step }
    case 'ArrowDown':
      return { x: 0, y: step }
    default:
      return null
  }
}

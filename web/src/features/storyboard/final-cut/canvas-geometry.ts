/**
 * 预览画面上的编辑（点选、拖动、缩放、旋转）用的几何换算，坐标都是 final-cut 画布的像素。一层在画面上的样子由
 * 预览页量出来（见 preview-canvas.ts），拖动中编辑器按它和指针算草稿。
 */

export type Point = { x: number; y: number }

/** 画面上一个转了角度的矩形：中心、宽高和角度（度，顺时针）。 */
export type Frame = { cx: number; cy: number; width: number; height: number; angle: number }

const radians = (degrees: number) => (degrees * Math.PI) / 180

const rotated = ({ x, y }: Point, degrees: number): Point => {
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** 点 `point` 在不在 `frame` 里（边上也算）。 */
export function frameContains(frame: Frame, point: Point): boolean {
  const local = rotated({ x: point.x - frame.cx, y: point.y - frame.cy }, -frame.angle)
  return Math.abs(local.x) <= frame.width / 2 && Math.abs(local.y) <= frame.height / 2
}

/** 上一次在画面上点选：点在哪、什么时候（毫秒）、选中了谁。 */
export type CanvasPick = { point: Point; at: number; id: string }

/** 同一处在这么久以内再点一次，换成下面一层，照参照的工作台。 */
export const CYCLE_MS = 600

/**
 * 在画面上点选时选中哪一层。`hits` 是指针下的层，从最上面一层往下排；`last` 是上一次点选（按下时不换层，
 * 给 null）。
 *
 * - 同一处（离上一次不超过 `tolerance`）`CYCLE_MS` 以内再点：换成上一次选中的下面一层，到底了回到最上面；
 * - 指针下有已经选中的层：还是它（按住就能拖，不会被盖在上面的层抢走）；
 * - 不然是最上面一层。指针下没有层时是 null。
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

/** 缩到最短的一边是这么多布局像素就不再缩（工作台 `MIN_RESIZE_LOCAL_PX`）。 */
export const MIN_EDGE = 1

/**
 * 拖角上的把手缩放：以中心为准等比缩放，倍数是指针现在离中心的距离比按下时离中心的距离，哪个角、转没转都一样
 * （照工作台 `domEditResizeLocal.ts` 的 `resolveCenterResizeSize`）。`frame` 是按下时这一层的样子，`size` 是它
 * 那时的布局宽高；答复新的布局宽高（没取整）。按在中心上时不缩，缩到最短的一边是 `MIN_EDGE` 就不再缩。
 */
export function resizedSize(
  frame: Frame,
  size: { width: number; height: number },
  pointerStart: Point,
  pointer: Point,
): { width: number; height: number } {
  const width = Math.max(size.width, MIN_EDGE)
  const height = Math.max(size.height, MIN_EDGE)
  const from = Math.hypot(pointerStart.x - frame.cx, pointerStart.y - frame.cy)
  if (!Number.isFinite(from) || from < 0.5) return { width, height }
  const least = MIN_EDGE / Math.min(width, height)
  const ratio = Math.max(least, Math.hypot(pointer.x - frame.cx, pointer.y - frame.cy) / from)
  return { width: width * ratio, height: height * ratio }
}

/** 按住 Shift 转时吸到的角度间隔。 */
export const ROTATION_SNAP_DEGREES = 15

const round3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

const degreesTo = (center: Point, point: Point) =>
  (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI

/**
 * 拖旋转把手：转过的角度是指针绕中心转过的角度，加到按下时的角度 `angle` 上；`snap`（按住 Shift）时吸到
 * `ROTATION_SNAP_DEGREES` 的整数倍，不吸时留三位小数（照工作台 `resolveDomEditRotationGesture`）。
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

/** 方向键挪一下的像素：按住 Shift 是 10。 */
export const nudgeStep = (shift: boolean): number => (shift ? 10 : 1)

/** 方向键对应的挪动方向；别的键是 null。 */
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

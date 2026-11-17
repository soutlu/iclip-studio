/**
 * 预览画面上的编辑（点选、拖动、缩放、旋转）用的几何换算，坐标都是 final-cut 画布的像素。
 *
 * 片段在画面上的摆放写在它自己元素的行内样式上：位移 `translate`、角度 `rotate`、缩放 `scale`，三个都绕元素的中心
 * （默认的 `transform-origin`）。预览只报元素没加这三样时的布局框（见 `ClipBox`），编辑器按主文件里写的值算出它在
 * 画面上的样子，拖动中按草稿算，和松手写进文件的是同一套值。
 */

export type Point = { x: number; y: number }

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * 预览量出来的一个片段：`box` 是元素的布局框（不含行内的位移、角度和缩放），`content` 是框里真正有画面的部分，
 * 相对 `box` 的左上角（视频按 `object-fit: contain` 放进框里时两边或上下有空，别的元素就是整个框）。
 */
export type ClipBox = { box: Rect; content: Rect }

/** 行内样式里写着的摆放（SDK 的属性名），没写的是 undefined。 */
export type PlacementStyles = { translate?: string; rotate?: string; scale?: string }

/** 要写进几个片段的摆放：片段编号 → 改的那几样（null 是去掉，没给的不动）。 */
export type PlacementChanges = ReadonlyMap<string, Record<string, string | null>>

/** 摆放换成数：位移（像素）、角度（度，顺时针）、横竖两个方向的缩放倍数。 */
export type Placement = { x: number; y: number; angle: number; scaleX: number; scaleY: number }

/** 画面上一个转了角度的矩形：中心、宽高和角度（度，顺时针）。 */
export type Frame = { cx: number; cy: number; width: number; height: number; angle: number }

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?'
const LENGTH = new RegExp(`^(${NUMBER})(px|%)?$`, 'i')
const ANGLE = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)?$`, 'i')
const FACTOR = new RegExp(`^(${NUMBER})(%)?$`)

const DEGREES_PER: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }

const isNone = (value: string | undefined) =>
  value === undefined || value.trim() === '' || value.trim() === 'none'

const partsOf = (value: string) => value.trim().split(/\s+/)

/** 一个长度：`px`、相对 `side` 的百分比，或者不带单位的 0；别的写法是 NaN。 */
const lengthOf = (token: string, side: number) => {
  const matched = LENGTH.exec(token)
  if (matched === null) return Number.NaN
  const value = Number(matched[1])
  const unit = matched[2]?.toLowerCase()
  if (unit === '%') return (value / 100) * side
  return unit === 'px' || value === 0 ? value : Number.NaN
}

const translateOf = (value: string | undefined, size: { width: number; height: number }) => {
  if (isNone(value)) return { x: 0, y: 0 }
  const [x = '', y = '0px', z = '0px', ...rest] = partsOf(value ?? '')
  if (rest.length > 0 || lengthOf(z, 0) !== 0) return null
  const point = { x: lengthOf(x, size.width), y: lengthOf(y, size.height) }
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
}

const angleOf = (value: string | undefined) => {
  if (isNone(value)) return 0
  const tokens = partsOf(value ?? '')
  const matched = tokens.length === 1 ? ANGLE.exec(tokens[0] ?? '') : null
  if (matched === null) return null
  const angle = Number(matched[1])
  const unit = matched[2]?.toLowerCase()
  if (unit === undefined) return angle === 0 ? 0 : null
  return angle * (DEGREES_PER[unit] ?? Number.NaN)
}

const factorOf = (token: string) => {
  const matched = FACTOR.exec(token)
  if (matched === null) return Number.NaN
  return Number(matched[1]) / (matched[2] === '%' ? 100 : 1)
}

const scaleOf = (value: string | undefined) => {
  if (isNone(value)) return { scaleX: 1, scaleY: 1 }
  const [x = '', y = x, z = '1', ...rest] = partsOf(value ?? '')
  if (rest.length > 0 || factorOf(z) !== 1) return null
  const scale = { scaleX: factorOf(x), scaleY: factorOf(y) }
  return Number.isFinite(scale.scaleX) && Number.isFinite(scale.scaleY) ? scale : null
}

/**
 * 把行内样式里的摆放换成数；`size` 是元素的布局框大小，位移写成百分比时按它算。写法读不懂（`calc()`、带 Z 轴、
 * 绕别的轴转……）时返回 null，这个片段在画面上只能选中、不能挪。
 */
export function placementOf(
  styles: PlacementStyles,
  size: { width: number; height: number },
): Placement | null {
  const translate = translateOf(styles.translate, size)
  const angle = angleOf(styles.rotate)
  const scale = scaleOf(styles.scale)
  if (translate === null || angle === null || !Number.isFinite(angle) || scale === null) return null
  return { ...translate, angle, ...scale }
}

const round = (value: number, digits: number) => {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits
  // -0 写出来是「-0」
  return rounded === 0 ? 0 : rounded
}

/** 位移写成像素，照参照的工作台（动画库按空格拆 `translate`，读不了 `calc()`）。 */
export const translateText = (x: number, y: number): string => `${round(x, 3)}px ${round(y, 3)}px`

export const rotateText = (angle: number): string => `${round(angle, 3)}deg`

export const scaleText = (scaleX: number, scaleY: number): string => {
  const x = round(scaleX, 4)
  const y = round(scaleY, 4)
  return x === y ? String(x) : `${x} ${y}`
}

const radians = (degrees: number) => (degrees * Math.PI) / 180

const rotated = ({ x, y }: Point, degrees: number): Point => {
  const cos = Math.cos(radians(degrees))
  const sin = Math.sin(radians(degrees))
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** 片段按 `placement` 摆好以后，它有画面的部分在画布上的样子。 */
export function frameOf({ box, content }: ClipBox, placement: Placement): Frame {
  const offset = rotated(
    {
      x: (content.x + content.width / 2 - box.width / 2) * placement.scaleX,
      y: (content.y + content.height / 2 - box.height / 2) * placement.scaleY,
    },
    placement.angle,
  )
  return {
    cx: box.x + box.width / 2 + placement.x + offset.x,
    cy: box.y + box.height / 2 + placement.y + offset.y,
    width: content.width * Math.abs(placement.scaleX),
    height: content.height * Math.abs(placement.scaleY),
    angle: placement.angle,
  }
}

/** 点 `point` 在不在 `frame` 里（边上也算）。 */
export function frameContains(frame: Frame, point: Point): boolean {
  const local = rotated({ x: point.x - frame.cx, y: point.y - frame.cy }, -frame.angle)
  return Math.abs(local.x) <= frame.width / 2 && Math.abs(local.y) <= frame.height / 2
}

/**
 * 画面区的片段从最上面一层排到最下面：叠放顺序 `z` 大的在上面，一样大时文件里写在后面的在上面。
 * `clips` 按文件里的先后给。
 */
export function topFirst<T extends { z: number }>(clips: readonly T[]): T[] {
  return clips
    .map((clip, index) => ({ clip, index }))
    .toSorted((left, right) => right.clip.z - left.clip.z || right.index - left.index)
    .map(({ clip }) => clip)
}

/** 上一次在画面上点选：点在哪、什么时候（毫秒）、选中了谁。 */
export type CanvasPick = { point: Point; at: number; id: string }

/** 同一处在这么久以内再点一次，换成下面一层，照参照的工作台。 */
export const CYCLE_MS = 600

/**
 * 在画面上点选时选中哪个片段。`hits` 是指针下的片段，从最上面一层往下排；`last` 是上一次点选（按下时不换层，
 * 给 null）。
 *
 * - 同一处（离上一次不超过 `tolerance`）`CYCLE_MS` 以内再点：换成上一次选中的下面一层，到底了回到最上面；
 * - 指针下有已经选中的片段：还是它（按住就能拖，不会被盖在上面的片段抢走）；
 * - 不然是最上面一层。指针下没有片段时是 null。
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

/** 画面上最小的边长：缩到这么小就不再缩，免得小到点不中。 */
export const MIN_EDGE = 8

/**
 * 拖角上的把手缩放：以片段中心为准等比缩放，倍数是指针现在离中心的距离比按下时离中心的距离，哪个角、片段转没转都
 * 一样（照参照的工作台）。`frame` 是按下时片段的样子，答复新的缩放倍数；按在中心上时不缩，缩到最短的边是
 * `MIN_EDGE` 就不再缩。
 */
export function resizedScale(
  frame: Frame,
  placement: Placement,
  pointerStart: Point,
  pointer: Point,
): { scaleX: number; scaleY: number } {
  const from = Math.hypot(pointerStart.x - frame.cx, pointerStart.y - frame.cy)
  if (from < 0.5) return { scaleX: placement.scaleX, scaleY: placement.scaleY }
  const shortest = Math.min(frame.width, frame.height)
  const least = shortest > 0 ? Math.min(1, MIN_EDGE / shortest) : 1
  const ratio = Math.max(least, Math.hypot(pointer.x - frame.cx, pointer.y - frame.cy) / from)
  return { scaleX: placement.scaleX * ratio, scaleY: placement.scaleY * ratio }
}

/** 按住 Shift 转时吸到的角度间隔。 */
export const ROTATION_SNAP_DEGREES = 15

const degreesTo = (center: Point, point: Point) =>
  (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI

/**
 * 拖旋转把手：转过的角度是指针绕片段中心转过的角度，加到按下时的角度 `angle` 上；`snap`（按住 Shift）时吸到
 * `ROTATION_SNAP_DEGREES` 的整数倍，不吸时留三位小数（照参照的工作台）。
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
    ? round(Math.round(next / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES, 3)
    : round(next, 3)
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

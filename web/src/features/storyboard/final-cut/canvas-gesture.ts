import type { CanvasLayer } from './canvas-layers'
import type { Frame, Point } from './canvas-geometry'
import type { SnapGuides, SnapRects } from './canvas-snap'
import { LayerRefusal, REFUSAL_TEXT, type Gesture as Ability } from './layer-abilities'
import { inlineStyleOf, movedTo, movedTranslate, type RotationTarget } from './layer-edits'
import type { LayerMeasure } from './preview-protocol'
import type { LayerEdit } from './use-film-session'

/**
 * 画布手势的数据与纯计算（状态推进见 use-canvas-gesture.ts）：手势状态机、拖拽草稿、
 * 手势被可编辑性规则拦下时的提示，以及把草稿换成写回文件的图层变更。
 */

/** 读取已打开工程文件的当前内容（相对工程根路径；未打开时返回 `undefined`）。 */
type ContentOf = (file: string) => string | undefined

/** 当前时间点可见并已完成测量的选中图层。 */
export type Shown = { at: number; layer: CanvasLayer; measure: LayerMeasure }

/**
 * 画布指针手势状态机：
 * - `press`：等待预览页返回按下处的命中图层栈（`last` 记录最新指针坐标）；
 * - `move`：拖拽移动选中图层（`blocked` 表示已被可编辑性规则拦截并提示原因）；
 * - `resize` / `rotate`：拖拽单选图层的四角缩放或旋转控制柄；普通图层缩放松手后（`released`）需等待末次中心回位偏移返回后再提交，
 *   元素/模板宿主缩放时 `scale` 保存其当前行内 `scale`（普通图层为 `null`）。
 */
export type Gesture =
  | {
      kind: 'press'
      start: Point
      last: Point
      shift: boolean
      /** 最新指针事件是否按住 Alt（禁用吸附）。 */
      alt: boolean
      released: number | null
    }
  | {
      kind: 'move'
      start: Point
      targets: readonly Shown[]
      moved: boolean
      blocked: boolean
      hits: readonly string[]
      picked: string
      shift: boolean
      /** 最新指针位置与 Alt 状态，供吸附矩形异步返回后立即重算对齐位置。 */
      last: Point
      alt: boolean
      /** 拖拽吸附矩形（见 canvas-snap.ts）；起拖时向预览页请求，返回前或无法测量时为 `null`。 */
      snap: SnapRects | null
    }
  | {
      kind: 'resize'
      start: Point
      target: Shown
      size: { width: number; height: number }
      scale: string | null
      released: boolean
    }
  | { kind: 'rotate'; start: Point; target: Shown; rotation: RotationTarget }

/** 拖拽期间的实时草稿：各图层当前线框、待提交位移与行内样式，以及移动吸附参考线。 */
export type Draft = {
  kind: 'move' | 'resize' | 'rotate'
  frames: ReadonlyMap<number, Frame>
  moves: ReadonlyMap<number, Point>
  styles: Readonly<Record<string, string>> | null
  guides: SnapGuides | null
}

/** 检查图层是否允许执行指定手势；不允许时返回面向用户的拒绝提示。 */
export const refusalOf = (measure: LayerMeasure, ability: Ability): string | undefined => {
  const allowed =
    ability === 'move' ? measure.move : ability === 'resize' ? measure.resize : measure.turn
  if (allowed) return undefined
  const refusal = measure.refusal === LayerRefusal.none ? LayerRefusal.animated : measure.refusal
  return REFUSAL_TEXT[refusal as Exclude<LayerRefusal, 0>]
}

/** 读取图层所属文件中该元素的行内 CSS 属性值（未声明时返回空串）。 */
export const inlineOf = (contentOf: ContentOf, layer: CanvasLayer, property: string) =>
  inlineStyleOf(contentOf(layer.file) ?? '', layer.element.hfId, property)

/** 构造图层局部像素位移 `delta` 的写入载荷：宿主写行内 `translate`，普通图层走 SDK `moveElement` 写 `data-x/y`。 */
export const movedEdit = (
  contentOf: ContentOf,
  layer: CanvasLayer,
  delta: Point,
): Pick<LayerEdit, 'move'> & { styles?: Record<string, string> } =>
  layer.host
    ? { styles: { translate: movedTranslate(inlineOf(contentOf, layer, 'translate'), delta) } }
    : { move: movedTo(layer.element.attributes, delta) }

/** 把最终草稿换成各图层的写回变更（缩放与旋转写行内样式，位移按 `movedEdit` 分发）；没变的图层不出变更。 */
export const draftEdits = (
  contentOf: ContentOf,
  last: Draft,
  targets: readonly Shown[],
): LayerEdit[] =>
  targets.flatMap(({ at, layer }): LayerEdit[] => {
    const move = last.moves.get(at)
    const moved =
      move === undefined || (move.x === 0 && move.y === 0)
        ? null
        : movedEdit(contentOf, layer, move)
    const styles = { ...last.styles, ...moved?.styles }
    if (moved?.move === undefined && Object.keys(styles).length === 0) return []
    return [
      {
        file: layer.file,
        element: layer.element.hfId,
        ...(moved?.move === undefined ? {} : { move: moved.move }),
        ...(Object.keys(styles).length === 0 ? {} : { styles }),
      },
    ]
  })

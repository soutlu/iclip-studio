/**
 * 在预览画面上拖动特效块或整片字幕：拖哪个元素、屏幕上的位移怎么吸附并换成画布像素、松手时 SDK
 * 交回的移动操作怎么写进草稿。手势与 SDK 预览适配器的接线在 canvas-layer.tsx。
 */
import type { EditOp } from '@hyperframes/sdk'
import { CAPTIONS_HF_ID } from './composition/build'
import { setCaptionsPosition } from './editing/captions'
import { toOffset, type WholeFilmDraft } from './editing/draft'
import { setOverlayPosition } from './editing/overlays'
import type { EditResult } from './editing/result'
import type { Selection } from './film-tracks'
import {
  buildCompositionSnapTarget,
  resolveGuideLineRect,
  resolveSnapAdjustment,
  snapEngagedForTravel,
  SNAP_THRESHOLD_PX,
  type Rect,
} from './vendor/hyperframes-studio/components/editor/snapEngine'

/**
 * 选中的这一块在画面上拖哪个元素（它的 data-hf-id）：特效块拖它自己，字幕的任何一句都拖整片字幕。
 * 成片轨上的段（视频段、组件段）只能选中，不能拖。
 */
export function dragTargetOf(selection: Selection): string | undefined {
  if (selection?.kind === 'overlay') return selection.id
  if (selection?.kind === 'caption') return CAPTIONS_HF_ID
  return undefined
}

/** 这个元素在草稿里记着的位置；有位置之前存的草稿没写，按没挪过算 */
export function positionOf(draft: WholeFilmDraft, target: string): { x: number; y: number } {
  const moved =
    target === CAPTIONS_HF_ID ? draft.captions : draft.overlays.find((o) => o.id === target)
  return { x: moved?.x ?? 0, y: moved?.y ?? 0 }
}

/**
 * 拖动中屏幕上的位移换成画布像素：除以缩放（iframe 宽 / 画布宽）后取整；挪完的位置（`from` 加上它）
 * 裁在 ±4096 以内，同草稿里记的，松手后画面不会再跳。
 */
export function canvasDelta(args: {
  dx: number
  dy: number
  scale: number
  from: { x: number; y: number }
}): { dx: number; dy: number } {
  const { scale, from } = args
  return {
    dx: toOffset(from.x + args.dx / scale) - from.x,
    dy: toOffset(from.y + args.dy / scale) - from.y,
  }
}

/**
 * 拖动的位移过一遍吸附（Studio 的 snapEngine）：吸附对象只有画面本身，被拖的这一块靠近画面的中线
 * 或四边时吸住，不吸别的块。坐标都是同一个屏幕坐标系（`moving` 是被拖这一块画出来的范围，`frame`
 * 是画面）。返回吸附后的位移与要画的参考线，参考线横跨整个画面。
 */
export function snapDrag(args: {
  moving: Rect
  frame: Rect
  dx: number
  dy: number
  /** 编辑器的「吸附」开关 */
  enabled: boolean
}): { dx: number; dy: number; guides: Rect[] } {
  const { frame } = args
  const snapped = resolveSnapAdjustment({
    movingRect: args.moving,
    proposedDx: args.dx,
    proposedDy: args.dy,
    targets: [buildCompositionSnapTarget(frame)],
    threshold: SNAP_THRESHOLD_PX,
    disabled: !args.enabled,
    disabledForTravel: !snapEngagedForTravel(args.dx, args.dy),
  })
  return {
    dx: snapped.dx,
    dy: snapped.dy,
    guides: snapped.guides.map((guide) => resolveGuideLineRect(guide, frame)),
  }
}

/**
 * 松手时 SDK 交回的操作写进草稿：拖的是整片字幕就挪字幕，是特效块就挪那一块。别的操作、别的元素
 * （草稿里已经没有这一块）不处理，返回 null。
 */
export function moveEditOf(draft: WholeFilmDraft, op: EditOp): EditResult | null {
  if (op.type !== 'moveElement' || typeof op.target !== 'string') return null
  const { target, x, y } = op
  if (target === CAPTIONS_HF_ID) return setCaptionsPosition(draft, { x, y })
  if (!draft.overlays.some((overlay) => overlay.id === target)) return null
  return setOverlayPosition(draft, { overlayId: target, x, y })
}

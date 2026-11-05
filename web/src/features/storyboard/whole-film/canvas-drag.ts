import type { EditOp } from '@hyperframes/sdk'
import { CAPTIONS_HF_ID } from './composition/build'
import { setCaptionsPosition } from './editing/captions'
import { toOffset, type WholeFilmDraft } from './editing/draft'
import { setOverlayPosition } from './editing/overlays'
import type { EditResult } from './editing/result'
import type { Selection } from './selection'
import {
  buildCompositionSnapTarget,
  resolveGuideLineRect,
  resolveSnapAdjustment,
  snapEngagedForTravel,
  SNAP_THRESHOLD_PX,
  type Rect,
} from './vendor/hyperframes-studio/components/editor/snapEngine'

export function dragTargetOf(selection: Selection): string | undefined {
  if (selection?.kind === 'overlay') return selection.id
  if (selection?.kind === 'caption') return CAPTIONS_HF_ID
  return undefined
}

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

export function snapDrag(args: {
  moving: Rect
  frame: Rect
  dx: number
  dy: number
  enabled: boolean
  rotated: boolean
}): { dx: number; dy: number; guides: Rect[] } {
  const { frame } = args
  const snapped = resolveSnapAdjustment({
    movingRect: args.moving,
    proposedDx: args.dx,
    proposedDy: args.dy,
    targets: [buildCompositionSnapTarget(frame)],
    threshold: SNAP_THRESHOLD_PX,
    disabled: !args.enabled || args.rotated,
    disabledForTravel: !snapEngagedForTravel(args.dx, args.dy),
  })
  return {
    dx: snapped.dx,
    dy: snapped.dy,
    guides: snapped.guides.map((guide) => resolveGuideLineRect(guide, frame)),
  }
}

export function moveEditOf(draft: WholeFilmDraft, op: EditOp): EditResult | null {
  if (op.type !== 'moveElement' || typeof op.target !== 'string') return null
  const { target, x, y } = op
  if (target === CAPTIONS_HF_ID) return setCaptionsPosition(draft, { x, y })
  if (!draft.overlays.some((overlay) => overlay.id === target)) return null
  return setOverlayPosition(draft, { overlayId: target, x, y })
}

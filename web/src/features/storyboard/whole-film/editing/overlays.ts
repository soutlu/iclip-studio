import {
  MIN_CLIP_MS,
  type ComponentVariables,
  type OverlayClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import { clamp, filmDuration, moveStartMs, nextId, normalize, resizeMs } from './timeline'

const endOf = (overlay: OverlayClip) => overlay.start + overlay.duration

/** 包装轨上一段两侧的空当：前一段的结尾到后一段的开头，两头不超出整片 */
const roomAround = (draft: WholeFilmDraft, overlay: OverlayClip) => {
  const others = draft.overlays.filter((o) => o.id !== overlay.id)
  const before = others.filter((o) => o.start < overlay.start)
  const after = others.filter((o) => o.start >= overlay.start)
  return {
    minStart: Math.max(0, ...before.map(endOf)),
    maxEnd: Math.min(filmDuration(draft), ...after.map((o) => o.start)),
  }
}

/**
 * 在 atMs 处加一段包装，时长取组件自带的时长，放不下时截短到所在空当；atMs 落在已有包装上时
 * 不加。包装轨只有一行，互不重叠。
 */
export const addOverlay = (
  draft: WholeFilmDraft,
  args: { component: string; durationMs: number; variables: ComponentVariables; atMs: number },
): EditResult => {
  const total = filmDuration(draft)
  const at = clamp(args.atMs, 0, total)
  if (draft.overlays.some((o) => at >= o.start && at < endOf(o))) return refuse('no-room')
  const gapStart = Math.max(0, ...draft.overlays.filter((o) => endOf(o) <= at).map(endOf))
  const gapEnd = Math.min(total, ...draft.overlays.filter((o) => o.start > at).map((o) => o.start))
  const duration = Math.min(args.durationMs, gapEnd - gapStart)
  if (duration < MIN_CLIP_MS) return refuse('no-room')
  const overlay: OverlayClip = {
    id: nextId(draft, 'o'),
    component: args.component,
    start: clamp(at, gapStart, gapEnd - duration),
    duration,
    variables: args.variables,
  }
  return done(normalize({ ...draft, overlays: [...draft.overlays, overlay] }))
}

/** 拖动一段包装：用 Studio 的拖动换算，停在两侧相邻的包装之间 */
export const moveOverlay = (
  draft: WholeFilmDraft,
  args: { overlayId: string; deltaMs: number },
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const { minStart, maxEnd } = roomAround(draft, overlay)
  const start = moveStartMs(overlay, args.deltaMs, {
    minStart,
    maxStart: maxEnd - overlay.duration,
  })
  if (start === overlay.start) return done(draft)
  return done(
    normalize({
      ...draft,
      overlays: draft.overlays.map((o) => (o === overlay ? { ...o, start } : o)),
    }),
  )
}

/** 拖包装的一端：用 Studio 的修剪，不越过相邻的包装和片尾 */
export const trimOverlay = (
  draft: WholeFilmDraft,
  args: { overlayId: string; edge: 'start' | 'end'; deltaMs: number },
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const next = resizeMs(overlay, args.edge, args.deltaMs, roomAround(draft, overlay))
  if (next.start === overlay.start && next.duration === overlay.duration) return done(draft)
  return done(
    normalize({
      ...draft,
      overlays: draft.overlays.map((o) =>
        o === overlay ? { ...o, start: next.start, duration: next.duration } : o,
      ),
    }),
  )
}

export const removeOverlay = (draft: WholeFilmDraft, args: { overlayId: string }): EditResult => {
  if (!draft.overlays.some((o) => o.id === args.overlayId)) return refuse('unknown-clip')
  return done({ ...draft, overlays: draft.overlays.filter((o) => o.id !== args.overlayId) })
}

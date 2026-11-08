import {
  resolveInsertRow,
  resolveNearestFreeStart,
} from '../vendor/hyperframes-studio/player/components/timelineCollision'
import {
  computeStackingPatches,
  type StackingDirection,
} from '../vendor/hyperframes-studio/player/components/timelineStackingSync'
import type { EditContext } from './context'
import {
  MAX_FILM_MS,
  MIN_CLIP_MS,
  toOffset,
  transformed,
  type ComponentVariables,
  type TransformArgs,
  type OverlayClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import { componentMsOf, moveStartMs, nextId, resizeMs } from './timeline'

export type OverlayRow = { track: number } | { insertAt: number }

const endOf = (overlay: OverlayClip) => overlay.start + overlay.duration

export const overlayRowCount = (overlays: readonly OverlayClip[]): number =>
  new Set(overlays.map((overlay) => overlay.track)).size

export const overlayRowAt = (rowFloat: number, rowCount: number): OverlayRow => {
  const insertAt = resolveInsertRow(rowFloat, rowCount)
  return insertAt === null ? { track: Math.floor(rowFloat) } : { insertAt }
}

const normalizeTracks = (overlays: OverlayClip[]): OverlayClip[] => {
  const rank = new Map(
    [...new Set(overlays.map((overlay) => overlay.track))]
      .sort((a, b) => a - b)
      .map((track, index) => [track, index]),
  )
  return overlays.map((overlay) => {
    const track = rank.get(overlay.track) ?? overlay.track
    return track === overlay.track ? overlay : { ...overlay, track }
  })
}

const topZ = (overlays: readonly OverlayClip[]) =>
  Math.max(0, ...overlays.map((overlay) => overlay.zIndex)) + 1

const landOn = (
  others: OverlayClip[],
  overlay: OverlayClip,
  row: OverlayRow,
  origin: number | null,
): { others: OverlayClip[]; placed: OverlayClip } => {
  if ('insertAt' in row) {
    return {
      others: others.map((o) => (o.track >= row.insertAt ? { ...o, track: o.track + 1 } : o)),
      placed: { ...overlay, track: row.insertAt },
    }
  }
  const start = resolveNearestFreeStart(
    others,
    row.track,
    overlay.start,
    overlay.duration,
    overlay.id,
    0,
    origin,
  )
  return { others, placed: { ...overlay, track: row.track, start: Math.round(start) } }
}

const newOverlay = (
  draft: WholeFilmDraft,
  args: { component: string; durationMs: number; variables: ComponentVariables; atMs: number },
): OverlayClip => ({
  id: nextId(draft, 'o'),
  component: args.component,
  start: Math.max(0, Math.round(args.atMs)),
  duration: args.durationMs,
  playbackStart: 0,
  track: 0,
  zIndex: topZ(draft.overlays),
  variables: args.variables,
})

export const addOverlay = (
  draft: WholeFilmDraft,
  args: { component: string; durationMs: number; variables: ComponentVariables; atMs: number },
): EditResult => {
  if (args.durationMs < MIN_CLIP_MS) return refuse('too-short')
  const overlay = newOverlay(draft, args)
  if (endOf(overlay) > MAX_FILM_MS) return refuse('overlay-too-long')
  return done({
    ...draft,
    overlays: [...draft.overlays.map((o) => ({ ...o, track: o.track + 1 })), overlay],
  })
}

export const dropOverlay = (
  draft: WholeFilmDraft,
  args: {
    component: string
    durationMs: number
    variables: ComponentVariables
    atMs: number
    row: OverlayRow
  },
): EditResult => {
  if (args.durationMs < MIN_CLIP_MS) return refuse('too-short')
  const { others, placed } = landOn(draft.overlays, newOverlay(draft, args), args.row, null)
  if (endOf(placed) > MAX_FILM_MS) return refuse('overlay-too-long')
  return done({ ...draft, overlays: normalizeTracks([...others, placed]) })
}

const directionOf = (from: number, row: OverlayRow): StackingDirection | null => {
  if ('insertAt' in row) return row.insertAt <= from ? 'up' : 'down'
  return row.track === from ? null : row.track < from ? 'up' : 'down'
}

export const moveOverlay = (
  draft: WholeFilmDraft,
  args: { overlayId: string; deltaMs: number; row?: OverlayRow },
): EditResult => {
  const index = draft.overlays.findIndex((o) => o.id === args.overlayId)
  const overlay = draft.overlays[index]
  if (!overlay) return refuse('unknown-clip')
  const start = moveStartMs(overlay, args.deltaMs, {
    minStart: 0,
    maxStart: MAX_FILM_MS - overlay.duration,
  })
  const row = args.row ?? { track: overlay.track }
  const origin = 'track' in row && row.track === overlay.track ? overlay.start : null
  const { others, placed } = landOn(
    draft.overlays.filter((o) => o.id !== overlay.id),
    { ...overlay, start },
    row,
    origin,
  )
  if (endOf(placed) > MAX_FILM_MS) return refuse('overlay-too-long')
  let overlays = normalizeTracks([...others.slice(0, index), placed, ...others.slice(index)])
  const direction = directionOf(overlay.track, row)
  if (direction !== null) {
    const patches = computeStackingPatches(
      overlays.map((o, domIndex) => ({
        key: o.id,
        start: o.start,
        duration: o.duration,
        track: o.track,
        zIndex: o.zIndex,
        isAudio: false,
        domIndex,
      })),
      [overlay.id],
      direction,
    )
    const zOf = new Map(patches.map((patch) => [patch.key, patch.zIndex]))
    overlays = overlays.map((o) => {
      const zIndex = zOf.get(o.id)
      return zIndex === undefined ? o : { ...o, zIndex }
    })
  }
  const unchanged = overlays.every((o, i) => {
    const before = draft.overlays[i]
    return (
      before !== undefined &&
      o.start === before.start &&
      o.track === before.track &&
      o.zIndex === before.zIndex
    )
  })
  return done(unchanged ? draft : { ...draft, overlays })
}

export const trimOverlay = (
  draft: WholeFilmDraft,
  args: { overlayId: string; edge: 'start' | 'end'; deltaMs: number },
  context: EditContext,
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const row = draft.overlays.filter((o) => o.id !== overlay.id && o.track === overlay.track)
  const next = resizeMs(overlay, args.edge, args.deltaMs, {
    minStart: Math.max(0, ...row.filter((o) => o.start < overlay.start).map(endOf)),
    maxEnd: Math.min(
      MAX_FILM_MS,
      overlay.start + componentMsOf(context, overlay.component) - overlay.playbackStart,
      ...row.filter((o) => o.start >= overlay.start).map((o) => o.start),
    ),
  })
  if (
    next.start === overlay.start &&
    next.duration === overlay.duration &&
    next.playbackStart === overlay.playbackStart
  ) {
    return done(draft)
  }
  return done({
    ...draft,
    overlays: draft.overlays.map((o) => (o === overlay ? { ...o, ...next } : o)),
  })
}

export const setOverlayPosition = (
  draft: WholeFilmDraft,
  args: { overlayId: string; x: number; y: number },
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const x = toOffset(args.x)
  const y = toOffset(args.y)
  if (x === (overlay.x ?? 0) && y === (overlay.y ?? 0)) return done(draft)
  return done({
    ...draft,
    overlays: draft.overlays.map((o) => (o === overlay ? { ...o, x, y } : o)),
  })
}

export const setOverlayTransform = (
  draft: WholeFilmDraft,
  args: { overlayId: string } & TransformArgs,
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const next = transformed(overlay, args)
  if (next === undefined) return done(draft)
  return done({
    ...draft,
    overlays: draft.overlays.map((o) => (o === overlay ? { ...o, ...next } : o)),
  })
}

export const removeOverlay = (draft: WholeFilmDraft, args: { overlayId: string }): EditResult => {
  if (!draft.overlays.some((o) => o.id === args.overlayId)) return refuse('unknown-clip')
  return done({
    ...draft,
    overlays: normalizeTracks(draft.overlays.filter((o) => o.id !== args.overlayId)),
  })
}

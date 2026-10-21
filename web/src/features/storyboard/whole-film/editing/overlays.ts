import {
  resolveInsertRow,
  resolveNearestFreeStart,
} from '../vendor/hyperframes-studio/player/components/timelineCollision'
import {
  computeStackingPatches,
  type StackingDirection,
} from '../vendor/hyperframes-studio/player/components/timelineStackingSync'
import {
  MAX_FILM_MS,
  MIN_CLIP_MS,
  toOffset,
  type ComponentVariables,
  type OverlayClip,
  type WholeFilmDraft,
} from './draft'
import { done, refuse, type EditResult } from './result'
import { moveStartMs, nextId, resizeMs } from './timeline'

// 特效轨照 HyperFrames：`track` 是显示的行（数小的在上，从 0 起连续），同一行里不重叠；`zIndex` 是
// 特效块之间的叠放次序（相同时数组里后面的在上），渲染只看它。特效块不跟随画面轨，可以超出画面轨
// 的结尾（成片随之变长），只是不能在成片总长上限之后结束；放不下时拒绝，不截短。

/** 落到哪：已有的第 `track` 行，或在第 `insertAt` 行之前开一行（等于行数时开在最下面） */
export type OverlayRow = { track: number } | { insertAt: number }

const endOf = (overlay: OverlayClip) => overlay.start + overlay.duration

export const overlayRowCount = (overlays: readonly OverlayClip[]): number =>
  new Set(overlays.map((overlay) => overlay.track)).size

/**
 * 指针在特效轨上的位置（按行高折成的行数，从第一行顶上起算）落到哪一行：只有第一行之上、最后一行
 * 之下的空处开新行，落在行上就是那一行（同 HyperFrames 的 resolveInsertRow）。
 */
export const overlayRowAt = (rowFloat: number, rowCount: number): OverlayRow => {
  const insertAt = resolveInsertRow(rowFloat, rowCount)
  return insertAt === null ? { track: Math.floor(rowFloat) } : { insertAt }
}

/** 去掉空行：行号收成 0…n−1，先后不变 */
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

/** 新加的组件叠在所有特效块之上（同 HyperFrames 的 blockInstaller：最大的 z 加一） */
const topZ = (overlays: readonly OverlayClip[]) =>
  Math.max(0, ...overlays.map((overlay) => overlay.zIndex)) + 1

/**
 * 把 overlay 放到 row 上；others 是其余的特效块（不含它）。落在已有的行上时，与行上的块相撞就挪到
 * 这一行离它最近的空位（同 HyperFrames 的 resolveNearestFreeStart，`origin` 是它在这一行上原来的
 * 开始时间）；开新行时，那一行和它下面的行都往下让一行。
 */
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

/** 点卡片加特效块：在最上面开一行，从 atMs 起，叠在所有特效块之上 */
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

/** 把组件拖到特效轨上松手：落到 row，叠在所有特效块之上 */
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

/**
 * 拖动一个特效块：用 Studio 的拖动换算出开始时间，落到 row（不给就是原来那一行）。换了行时只给它
 * 重排叠放（同 HyperFrames 的 timelineStackingSync）：往上挪就盖过它现在压着的、时间上重叠的块，
 * 往下挪就沉到它现在被压着的块下面；别的块的 zIndex 不变，只在原来那一行左右挪时也不变。
 */
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

/** 拖特效块的一端：用 Studio 的修剪，不越过同一行上相邻的块与总长上限；修开头时从组件自己时间里更晚处起播 */
export const trimOverlay = (
  draft: WholeFilmDraft,
  args: { overlayId: string; edge: 'start' | 'end'; deltaMs: number },
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const row = draft.overlays.filter((o) => o.id !== overlay.id && o.track === overlay.track)
  const next = resizeMs(overlay, args.edge, args.deltaMs, {
    minStart: Math.max(0, ...row.filter((o) => o.start < overlay.start).map(endOf)),
    maxEnd: Math.min(
      MAX_FILM_MS,
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

/** 在画面上挪一个特效块：x、y 是画面像素，取整并裁在 ±4096 以内；位置没变时原样返回 */
export const setOverlayPosition = (
  draft: WholeFilmDraft,
  args: { overlayId: string; x: number; y: number },
): EditResult => {
  const overlay = draft.overlays.find((o) => o.id === args.overlayId)
  if (!overlay) return refuse('unknown-clip')
  const x = toOffset(args.x)
  const y = toOffset(args.y)
  // 有位置之前存的草稿没写 x、y，按没挪过算
  if (x === (overlay.x ?? 0) && y === (overlay.y ?? 0)) return done(draft)
  return done({
    ...draft,
    overlays: draft.overlays.map((o) => (o === overlay ? { ...o, x, y } : o)),
  })
}

export const removeOverlay = (draft: WholeFilmDraft, args: { overlayId: string }): EditResult => {
  if (!draft.overlays.some((o) => o.id === args.overlayId)) return refuse('unknown-clip')
  return done({
    ...draft,
    overlays: normalizeTracks(draft.overlays.filter((o) => o.id !== args.overlayId)),
  })
}

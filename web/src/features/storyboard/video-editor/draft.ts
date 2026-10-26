import { z } from 'zod'
import { roundToMs, type Clip } from '../editing/clip'
import { amend, startHistory, type History } from '../editing/edit-history'
import { keyframeRanges } from '../editing/keyframe-segments'

const MIN_TRIM_SECONDS = 0.2

const MIN_SPLIT_SECONDS = 0.1

export type DraftClip = Clip & {
  kind: 'clip'
  id: string
  origin: { start: number; end: number }
}

export type DraftPending = {
  kind: 'pending'
  id: string
  editJobId: string
  replaced: readonly DraftClip[]
}

export type DraftItem = DraftClip | DraftPending
export type Draft = readonly DraftItem[]

export type Selection = readonly string[]

export const clipItem = (clip: Clip, origin = { start: clip.start, end: clip.end }): DraftClip => ({
  kind: 'clip',
  id: `${clip.sourceJobId}@${clip.start}-${clip.end}`,
  sourceJobId: clip.sourceJobId,
  start: clip.start,
  end: clip.end,
  origin,
})

const pendingItem = (editJobId: string, replaced: readonly DraftClip[]): DraftPending => ({
  kind: 'pending',
  id: `pending@${editJobId}`,
  editJobId,
  replaced,
})

export const keyframeSegments = (
  versionJobId: string,
  index: { keyframes: readonly number[]; duration: number },
): DraftClip[] =>
  keyframeRanges(index).map((range) => clipItem({ sourceJobId: versionJobId, ...range }))

const joinedClips = (clips: readonly Clip[]): Clip[] => {
  const joined: Clip[] = []
  for (const clip of clips) {
    const previous = joined.at(-1)
    if (previous?.sourceJobId === clip.sourceJobId && previous.end === clip.start)
      previous.end = clip.end
    else joined.push({ sourceJobId: clip.sourceJobId, start: clip.start, end: clip.end })
  }
  return joined
}

export const isUnchanged = (draft: Draft, segments: readonly DraftClip[]): boolean => {
  if (!draft.every((item) => item.kind === 'clip')) return false
  const current = joinedClips(draft)
  const original = joinedClips(segments)
  return (
    current.length === original.length &&
    current.every(
      (clip, at) =>
        clip.sourceJobId === original[at]?.sourceJobId &&
        clip.start === original[at]?.start &&
        clip.end === original[at]?.end,
    )
  )
}

export const itemDuration = (item: DraftItem): number =>
  item.kind === 'clip'
    ? item.end - item.start
    : item.replaced.reduce((sum, clip) => sum + clip.end - clip.start, 0)

export type PlacedItem = { item: DraftItem; at: number; duration: number }

export const layoutDraft = (draft: Draft): PlacedItem[] => {
  let at = 0
  return draft.map((item) => {
    const duration = itemDuration(item)
    const placed = { item, at, duration }
    at += duration
    return placed
  })
}

export const draftDuration = (draft: Draft): number =>
  roundToMs(draft.reduce((sum, item) => sum + itemDuration(item), 0))

export const compositeSegments = (draft: Draft): Clip[] | undefined =>
  draft.every((item) => item.kind === 'clip')
    ? draft.map(({ sourceJobId, start, end }) => ({ sourceJobId, start, end }))
    : undefined

export const selectedRange = (
  draft: Draft,
  selection: Selection,
): { from: number; to: number } | undefined => {
  const from = draft.findIndex((item) => item.id === selection[0])
  if (from < 0) return undefined
  const ok = selection.every((id, offset) => draft[from + offset]?.id === id)
  return ok ? { from, to: from + selection.length - 1 } : undefined
}

const idsBetween = (draft: Draft, from: number, to: number): Selection =>
  draft.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id)

export const clickSelect = (draft: Draft, selection: Selection, id: string): Selection => {
  const index = draft.findIndex((item) => item.id === id)
  if (index < 0 || draft[index]?.kind !== 'clip') return selection
  const range = selectedRange(draft, selection)
  if (range === undefined) return [id]
  if (index === range.from - 1 || index === range.to + 1)
    return idsBetween(draft, Math.min(index, range.from), Math.max(index, range.to))
  if (index === range.from) return selection.slice(1)
  if (index === range.to) return selection.slice(0, -1)
  return [id]
}

export const stepSelect = (
  draft: Draft,
  selection: Selection,
  focusId: string,
  direction: -1 | 1,
  extend: boolean,
): { focus: string; selection: Selection } => {
  const focus = draft.findIndex((item) => item.id === focusId)
  const target = draft[focus + direction]
  if (focus < 0 || target === undefined || target.kind !== 'clip')
    return { focus: focusId, selection }
  if (!extend) return { focus: target.id, selection: [target.id] }
  const range = selectedRange(draft, selection)
  const anchor =
    range === undefined || (focus !== range.from && focus !== range.to)
      ? focus
      : focus === range.from
        ? range.to
        : range.from
  return { focus: target.id, selection: idsBetween(draft, anchor, focus + direction) }
}

export type Edit = { draft: Draft; selection: Selection }

export const mergeSelection = (draft: Draft, selection: Selection): Edit => {
  const range = selectedRange(draft, selection)
  if (range === undefined || range.from === range.to) return { draft, selection }
  const items = draft.slice(range.from, range.to + 1)
  if (!items.every((item) => item.kind === 'clip')) return { draft, selection }
  const joined = joinedClips(items)
  const clip = joined[0]
  if (joined.length !== 1 || clip === undefined) return { draft, selection }
  const merged = clipItem(clip)
  return {
    draft: [...draft.slice(0, range.from), merged, ...draft.slice(range.to + 1)],
    selection: [merged.id],
  }
}

export const trimBounds = (clip: DraftClip, edge: 'start' | 'end'): { min: number; max: number } =>
  edge === 'start'
    ? { min: clip.origin.start, max: Math.max(clip.start, roundToMs(clip.end - MIN_TRIM_SECONDS)) }
    : { min: Math.min(clip.end, roundToMs(clip.start + MIN_TRIM_SECONDS)), max: clip.origin.end }

/** 裁选区的一端：开头裁第一段的开头，结尾裁最后一段的结尾；选区仍是原来那几段。 */
export const trimClip = (
  draft: Draft,
  selection: Selection,
  edge: 'start' | 'end',
  value: number,
): Edit => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return { draft, selection }
  const at = edge === 'start' ? range.from : range.to
  const clip = draft[at]
  if (clip === undefined || clip.kind !== 'clip') return { draft, selection }
  const { min, max } = trimBounds(clip, edge)
  const bounded = roundToMs(Math.min(max, Math.max(min, value)))
  const trimmed = clipItem({ ...clip, [edge]: bounded }, clip.origin)
  return {
    draft: draft.with(at, trimmed),
    selection: selection.map((id) => (id === clip.id ? trimmed.id : id)),
  }
}

export const moveItems = (draft: Draft, ids: Selection, before: number): Edit => {
  const moving = draft.filter((item) => ids.includes(item.id))
  if (moving.length === 0 || moving.some((item) => item.kind !== 'clip'))
    return { draft, selection: ids }
  const rest = draft.filter((item) => !ids.includes(item.id))
  const insertAt = draft.slice(0, before).filter((item) => !ids.includes(item.id)).length
  return {
    draft: [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)],
    selection: moving.map((item) => item.id),
  }
}

const splitPoint = (draft: Draft, clock: number) => {
  const placed = layoutDraft(draft).find(
    (entry) => clock > entry.at && clock < entry.at + entry.duration,
  )
  if (placed === undefined || placed.item.kind !== 'clip') return undefined
  const clip = placed.item
  const time = roundToMs(clip.start + (clock - placed.at))
  if (time - clip.start < MIN_SPLIT_SECONDS || clip.end - time < MIN_SPLIT_SECONDS) return undefined
  return { clip, time }
}

export const canSplitAt = (draft: Draft, clock: number): boolean =>
  splitPoint(draft, clock) !== undefined

export const splitAt = (draft: Draft, clock: number): Edit | undefined => {
  const point = splitPoint(draft, clock)
  if (point === undefined) return undefined
  const { clip, time } = point
  const left = clipItem({ ...clip, end: time }, { start: clip.origin.start, end: time })
  const right = clipItem({ ...clip, start: time }, { start: time, end: clip.origin.end })
  const at = draft.indexOf(clip)
  return {
    draft: [...draft.slice(0, at), left, right, ...draft.slice(at + 1)],
    selection: [right.id],
  }
}

export const canRemove = (draft: Draft, selection: Selection): boolean => {
  const range = selectedRange(draft, selection)
  return (
    range !== undefined &&
    selection.length < draft.length &&
    draft.slice(range.from, range.to + 1).every((item) => item.kind === 'clip')
  )
}

export const removeItems = (draft: Draft, selection: Selection): Edit =>
  canRemove(draft, selection)
    ? { draft: draft.filter((item) => !selection.includes(item.id)), selection: [] }
    : { draft, selection }

export type EditOutcome =
  { kind: 'running' } | { kind: 'done'; duration: number } | { kind: 'failed'; message: string }

export const resolvePending = (
  draft: Draft,
  outcomeOf: (editJobId: string) => EditOutcome | undefined,
): { draft: Draft; failures: string[] } => {
  const failures: string[] = []
  let changed = false
  const next = draft.flatMap((item): DraftItem[] => {
    if (item.kind !== 'pending') return [item]
    const outcome = outcomeOf(item.editJobId)
    if (outcome?.kind === 'done') {
      changed = true
      return [clipItem({ sourceJobId: item.editJobId, start: 0, end: roundToMs(outcome.duration) })]
    }
    if (outcome?.kind === 'failed') {
      changed = true
      failures.push(outcome.message)
      return [...item.replaced]
    }
    return [item]
  })
  return { draft: changed ? next : draft, failures }
}

export type EditRange = {
  id: string
  rangeStartMs: number
  rangeEndMs: number
}

export const rebuildDraft = (
  segments: readonly DraftClip[],
  edits: readonly (EditRange & { createdAt: string; failed: boolean })[],
): Draft => {
  const first = segments[0]
  const last = segments.at(-1)
  if (first === undefined || last === undefined) return segments
  const accepted: { start: number; end: number }[] = []
  const newestFirst = edits.toSorted(
    (left, right) =>
      Number(left.failed) - Number(right.failed) ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      right.id.localeCompare(left.id),
  )
  for (const edit of newestFirst) {
    const start = edit.rangeStartMs / 1000
    const end = edit.rangeEndMs / 1000
    if (start < first.start || end > last.end || end <= start) continue
    if (accepted.some((taken) => start < taken.end && end > taken.start)) continue
    accepted.push({ start, end })
  }
  if (accepted.length === 0) return segments
  const cuts = [
    ...new Set([
      ...segments.map((segment) => segment.start),
      last.end,
      ...accepted.flatMap((range) => [range.start, range.end]),
    ]),
  ]
    .filter((time) => !accepted.some((range) => time > range.start && time < range.end))
    .sort((left, right) => left - right)
  return cuts
    .slice(0, -1)
    .map((start, at) =>
      clipItem({ sourceJobId: first.sourceJobId, start, end: cuts[at + 1] ?? last.end }),
    )
}

export const draftSources = (draft: Draft): Set<string> =>
  new Set(
    draft.flatMap((item) =>
      item.kind === 'clip'
        ? [item.sourceJobId]
        : [item.editJobId, ...item.replaced.map((clip) => clip.sourceJobId)],
    ),
  )

export type Snapshot = { draft: Draft; selection: Selection }

export type DraftHistory = History<Snapshot>

export const startDraftHistory = (draft: Draft): DraftHistory =>
  startHistory({ draft, selection: [] })

export const reselect = (history: DraftHistory, selection: Selection): DraftHistory =>
  amend(history, { ...history.present, selection })

export const resolveHistory = (
  history: DraftHistory,
  outcomeOf: (editJobId: string) => EditOutcome | undefined,
): { history: DraftHistory; failures: string[] } => {
  let changed = false
  const settle = (snapshot: Snapshot): Snapshot => {
    const resolved = resolvePending(snapshot.draft, outcomeOf)
    if (resolved.draft === snapshot.draft) return snapshot
    changed = true
    const ids = new Set(resolved.draft.map((item) => item.id))
    return { draft: resolved.draft, selection: snapshot.selection.filter((id) => ids.has(id)) }
  }
  const present = resolvePending(history.present.draft, outcomeOf)
  const next: DraftHistory = {
    past: history.past.map(settle),
    present: settle(history.present),
    future: history.future.map(settle),
  }
  return { history: changed ? next : history, failures: present.failures }
}

const STORAGE_VERSION = 1

const zStoredClip = z
  .object({
    sourceJobId: z.string().min(1),
    start: z.number().nonnegative(),
    end: z.number(),
    origin: z.tuple([z.number().nonnegative(), z.number()]),
  })
  .refine(
    (clip) => clip.end > clip.start && clip.origin[0] <= clip.start && clip.end <= clip.origin[1],
  )

const zStoredDraft = z.object({
  version: z.literal(STORAGE_VERSION),
  items: z
    .array(
      z.union([
        zStoredClip,
        z.object({ pending: z.string().min(1), replaced: z.array(zStoredClip).min(1) }),
      ]),
    )
    .min(1),
  composite: z.string().min(1).optional(),
})

type StoredClip = z.infer<typeof zStoredClip>

const fromStored = (clip: StoredClip): DraftClip =>
  clipItem(clip, { start: clip.origin[0], end: clip.origin[1] })

const toStored = (clip: DraftClip): StoredClip => ({
  sourceJobId: clip.sourceJobId,
  start: clip.start,
  end: clip.end,
  origin: [clip.origin.start, clip.origin.end],
})

export type StoredDraft = { draft: Draft; composite: string | undefined }

export const parseStoredDraft = (raw: string): StoredDraft | undefined => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = zStoredDraft.safeParse(json)
  if (!parsed.success) return undefined
  return {
    draft: parsed.data.items.map((item) =>
      'pending' in item
        ? pendingItem(item.pending, item.replaced.map(fromStored))
        : fromStored(item),
    ),
    composite: parsed.data.composite,
  }
}

export const serializeDraft = ({ draft, composite }: StoredDraft): string =>
  JSON.stringify({
    version: STORAGE_VERSION,
    items: draft.map((item) =>
      item.kind === 'clip'
        ? toStored(item)
        : { pending: item.editJobId, replaced: item.replaced.map(toStored) },
    ),
    ...(composite === undefined ? {} : { composite }),
  })

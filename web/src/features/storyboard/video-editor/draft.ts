import { z } from 'zod'
import { roundToMs } from '../editing/clip'
import type { Edge } from '../editing/timeline-drag'
import type { GenerationJob } from '../storyboard.api'
import { partItemId, type EditBlock, type EditPart, type Shot } from './edit-blocks'

const EPSILON = 0.001
export const MIN_USE = 0.5
const SNAP_PX = 8

export type ReadyEdit = {
  id: string
  from: number
  to: number
  mediaUrl: string
  duration: number
  parts: readonly EditPart[]
}

export const readyEditsOf = (blocks: readonly EditBlock[]): ReadyEdit[] =>
  blocks.flatMap((block): ReadyEdit[] =>
    block.state.kind === 'ready' && block.job.outputUrl !== null
      ? [
          {
            id: block.id,
            from: block.from,
            to: block.to,
            mediaUrl: block.job.outputUrl,
            duration: block.state.duration,
            parts: block.state.parts,
          },
        ]
      : [],
  )

export type DraftSource = {
  rootId: string
  rootUrl: string
  duration: number
  shots: readonly Shot[]
  edits: readonly ReadyEdit[]
}

export type DraftEntry =
  | { kind: 'shot'; no: number; t0: number; t1: number }
  | { kind: 'edit'; editId: string; seg: number; t0: number; t1: number }

export type Draft = {
  entries: readonly DraftEntry[]
  closed: readonly number[]
}

const zTime = z.number().nonnegative()
const zNumber = z.number().int().positive()
export const zDraft = z.object({
  entries: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('shot'), no: zNumber, t0: zTime, t1: zTime }),
      z.object({
        kind: z.literal('edit'),
        editId: z.string().min(1),
        seg: zNumber,
        t0: zTime,
        t1: zTime,
      }),
    ]),
  ),
  closed: z.array(zNumber),
})

const near = (left: number, right: number) => Math.abs(left - right) < EPSILON
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > EPSILON

export const shotItemId = (no: number) => `shot-${no}`

const entryId = (entry: DraftEntry) =>
  entry.kind === 'shot' ? shotItemId(entry.no) : partItemId(entry.editId, entry.seg)

const wholeShot = (shot: Shot): DraftEntry => ({
  kind: 'shot',
  no: shot.no,
  t0: shot.start,
  t1: shot.end,
})
const wholePart = (edit: ReadyEdit, part: EditPart): DraftEntry => ({
  kind: 'edit',
  editId: edit.id,
  seg: part.seg,
  t0: part.b0,
  t1: part.b1,
})

export const defaultDraft = (source: DraftSource): Draft => ({
  entries: source.shots.map(wholeShot),
  closed: [],
})

const editOf = (source: DraftSource, id: string) => source.edits.find((edit) => edit.id === id)
const partOf = (edit: ReadyEdit, seg: number) => edit.parts.find((part) => part.seg === seg)
const covers = (edit: { from: number; to: number }, no: number) => edit.from <= no && no <= edit.to
const isShot = (entry: DraftEntry, no: number) => entry.kind === 'shot' && entry.no === no
const isPart = (entry: DraftEntry, editId: string, seg: number) =>
  entry.kind === 'edit' && entry.editId === editId && entry.seg === seg
const hasPick = (draft: Draft, editId: string) =>
  draft.entries.some((entry) => entry.kind === 'edit' && entry.editId === editId)

export const shotOn = (draft: Draft, no: number): boolean =>
  draft.entries.some((entry) => isShot(entry, no))

export const isPicked = (draft: Draft, editId: string, seg: number) =>
  draft.entries.some((entry) => isPart(entry, editId, seg))

const shotOfPart = (edit: ReadyEdit, seg: number) => Math.min(edit.from + seg - 1, edit.to)

const placeOf = (source: DraftSource, entry: DraftEntry): number | undefined => {
  if (entry.kind === 'shot') return entry.no
  const edit = editOf(source, entry.editId)
  return edit === undefined ? undefined : shotOfPart(edit, entry.seg)
}

const enter = (
  source: DraftSource,
  entries: readonly DraftEntry[],
  joiner: DraftEntry,
  place: number,
): DraftEntry[] => {
  let after = -1
  let nearest = -Infinity
  entries.forEach((entry, index) => {
    const at = placeOf(source, entry)
    if (at === undefined || at > place || at < nearest) return
    nearest = at
    after = index
  })
  return [...entries.slice(0, after + 1), joiner, ...entries.slice(after + 1)]
}

export const putShot = (source: DraftSource, draft: Draft, no: number, on: boolean): Draft => {
  const shot = source.shots.find((item) => item.no === no)
  if (shot === undefined) return draft
  const closed = draft.closed.filter((item) => item !== no)
  if (!on)
    return { entries: draft.entries.filter((entry) => !isShot(entry, no)), closed: [...closed, no] }
  if (shotOn(draft, no)) return draft
  return { entries: enter(source, draft.entries, wholeShot(shot), no), closed }
}

export const pickPart = (source: DraftSource, draft: Draft, editId: string, seg: number): Draft => {
  const edit = editOf(source, editId)
  const part = edit === undefined ? undefined : partOf(edit, seg)
  if (edit === undefined || part === undefined || isPicked(draft, editId, seg)) return draft
  const entries = enter(source, draft.entries, wholePart(edit, part), shotOfPart(edit, seg))
  return {
    ...draft,
    entries: hasPick(draft, editId)
      ? entries
      : entries.filter((entry) => !(entry.kind === 'shot' && covers(edit, entry.no))),
  }
}

const coveredByPick = (source: DraftSource, draft: Draft, no: number) =>
  source.edits.some((edit) => covers(edit, no) && hasPick(draft, edit.id))

export const unpickPart = (
  source: DraftSource,
  draft: Draft,
  editId: string,
  seg: number,
): Draft => {
  if (!isPicked(draft, editId, seg)) return draft
  const left: Draft = {
    ...draft,
    entries: draft.entries.filter((entry) => !isPart(entry, editId, seg)),
  }
  const edit = editOf(source, editId)
  if (edit === undefined || hasPick(left, editId)) return left
  const back = source.shots.filter(
    (shot) =>
      covers(edit, shot.no) &&
      !draft.closed.includes(shot.no) &&
      !shotOn(draft, shot.no) &&
      !coveredByPick(source, left, shot.no),
  )
  const entries = back.reduce(
    (next, shot) => enter(source, next, wholeShot(shot), shot.no),
    draft.entries,
  )
  return { ...draft, entries: entries.filter((entry) => !isPart(entry, editId, seg)) }
}

type ItemFields = {
  id: string
  sourceJobId: string
  mediaUrl: string
  t0: number
  t1: number
  b0: number
  b1: number
} & ({ kind: 'shot'; no: number } | { kind: 'edit'; edit: ReadyEdit; seg: number })

export type DraftItem = ItemFields & { at: number; d: number }

const fieldsOf = (source: DraftSource, entry: DraftEntry): ItemFields | undefined => {
  const { t0, t1 } = entry
  if (entry.kind === 'shot') {
    const shot = source.shots.find((item) => item.no === entry.no)
    return shot === undefined
      ? undefined
      : {
          kind: 'shot',
          id: entryId(entry),
          no: shot.no,
          sourceJobId: source.rootId,
          mediaUrl: source.rootUrl,
          t0,
          t1,
          b0: shot.start,
          b1: shot.end,
        }
  }
  const edit = editOf(source, entry.editId)
  const part = edit === undefined ? undefined : partOf(edit, entry.seg)
  return edit === undefined || part === undefined
    ? undefined
    : {
        kind: 'edit',
        id: entryId(entry),
        edit,
        seg: part.seg,
        sourceJobId: edit.id,
        mediaUrl: edit.mediaUrl,
        t0,
        t1,
        b0: part.b0,
        b1: part.b1,
      }
}

export const draftItemsOf = (source: DraftSource, draft: Draft): DraftItem[] => {
  let at = 0
  return draft.entries.flatMap((entry): DraftItem[] => {
    const fields = fieldsOf(source, entry)
    if (fields === undefined) return []
    const d = roundToMs(fields.t1 - fields.t0)
    const placed = { ...fields, at, d }
    at = roundToMs(at + d)
    return [placed]
  })
}

export const previewPick = (
  source: DraftSource,
  draft: Draft,
  editId: string,
  seg: number,
): DraftItem[] | undefined => {
  const edit = editOf(source, editId)
  const part = edit === undefined ? undefined : partOf(edit, seg)
  if (edit === undefined || part === undefined || isPicked(draft, editId, seg)) return undefined
  const entries = enter(source, draft.entries, wholePart(edit, part), shotOfPart(edit, seg))
  return draftItemsOf(source, { ...draft, entries })
}

export const totalOf = (items: readonly { d: number }[]) =>
  roundToMs(items.reduce((sum, item) => sum + item.d, 0))

export type Piece = { sourceJobId: string; mediaUrl: string; start: number; end: number }

export const outputOf = (items: readonly DraftItem[]): Piece[] => {
  const pieces: Piece[] = []
  for (const item of items) {
    const last = pieces.at(-1)
    if (last?.sourceJobId === item.sourceJobId && near(last.end, item.t0)) {
      last.end = item.t1
      continue
    }
    pieces.push({
      sourceJobId: item.sourceJobId,
      mediaUrl: item.mediaUrl,
      start: item.t0,
      end: item.t1,
    })
  }
  return pieces
}

const inside = (item: DraftItem, clock: number) =>
  clock >= item.at - EPSILON && clock < item.at + item.d - EPSILON

export const keepPlace = (
  before: readonly DraftItem[],
  after: readonly DraftItem[],
  clock: number,
): number => {
  const was = before.find((item) => inside(item, clock))
  if (was === undefined) return clock <= EPSILON ? 0 : totalOf(after)
  const same = after.find((item) => item.id === was.id)
  if (same !== undefined) return roundToMs(same.at + Math.min(clock - was.at, same.d))
  return after.find((item) => inside(item, was.at))?.at ?? totalOf(after)
}

const secondsText = (value: number) => value.toFixed(1)

export const draftLineOf = (item: DraftItem): string => {
  const cut = item.t0 > item.b0 + EPSILON || item.t1 < item.b1 - EPSILON
  const whole = item.kind === 'edit' ? '这一段' : '这个镜头'
  const prefix = item.kind === 'edit' && item.edit.parts.length > 1 ? `第 ${item.seg} 段 · ` : ''
  const length = cut
    ? `${secondsText(item.d)} 秒（${whole} ${secondsText(item.b1 - item.b0)} 秒）`
    : `${secondsText(item.d)} 秒 `
  return `${prefix}${length}· ${item.kind === 'edit' ? '已选用' : '原片'}`
}

export type TrimSpec = {
  t0: number
  t1: number
  lo: number
  hi: number
  min: number
  snaps: readonly number[]
}

export const trimSpecOf = (item: DraftItem): TrimSpec => ({
  t0: item.t0,
  t1: item.t1,
  lo: item.b0,
  hi: item.b1,
  min: Math.min(MIN_USE, item.b1 - item.b0),
  snaps: [item.b0, item.b1],
})

const MIN_RUN = 1

export const runTrimSpecOf = (
  run: { start: number; end: number },
  shots: readonly { start: number }[],
  duration: number,
): TrimSpec => ({
  t0: run.start,
  t1: run.end,
  lo: 0,
  hi: duration,
  min: Math.min(MIN_RUN, run.end - run.start),
  snaps: [...shots.map((shot) => shot.start), duration],
})

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))

export const snapNear =
  (bounds: readonly number[], pps: number) =>
  (time: number): number =>
    bounds
      .filter((bound) => Math.abs(bound - time) * pps <= SNAP_PX)
      .sort((left, right) => Math.abs(left - time) - Math.abs(right - time))[0] ?? time

export const snapAhead =
  (bounds: readonly number[], current: number, direction: -1 | 1, pps: number) =>
  (time: number): number =>
    bounds
      .filter(
        (bound) =>
          (bound - current) * direction > EPSILON &&
          ((time - bound) * direction >= 0 || Math.abs(time - bound) * pps <= SNAP_PX),
      )
      .sort((left, right) => Math.abs(left - current) - Math.abs(right - current))[0] ?? time

export const trimTo = (
  spec: TrimSpec,
  edge: Edge,
  time: number,
  snap: (time: number) => number,
): { t0: number; t1: number } =>
  edge === 'end'
    ? { t0: spec.t0, t1: roundToMs(clamp(snap(time), spec.t0 + spec.min, spec.hi)) }
    : { t0: roundToMs(clamp(snap(time), spec.lo, spec.t1 - spec.min)), t1: spec.t1 }

export const trimItem = (
  draft: Draft,
  item: DraftItem,
  { t0, t1 }: { t0: number; t1: number },
): Draft => ({
  ...draft,
  entries: draft.entries.map((entry) =>
    entryId(entry) === item.id ? { ...entry, t0, t1 } : entry,
  ),
})

const unique = (keys: readonly (string | number)[]) => new Set(keys).size === keys.length

export const isUsableDraft = (source: DraftSource, draft: Draft): boolean =>
  draft.entries.every((entry) => {
    const fields = fieldsOf(source, entry)
    return (
      fields !== undefined &&
      entry.t0 >= fields.b0 - EPSILON &&
      entry.t1 <= fields.b1 + EPSILON &&
      entry.t1 - entry.t0 > EPSILON
    )
  }) &&
  unique(draft.entries.map(entryId)) &&
  draft.closed.every((no) => source.shots.some((shot) => shot.no === no) && !shotOn(draft, no)) &&
  unique(draft.closed)

export type Segment = { sourceJobId: string; start: number; end: number }

const zCompositeRequest = z.object({
  segments: z
    .array(
      z.object({
        sourceJobId: z.string().min(1),
        start: z.number().nonnegative(),
        end: z.number().nullable().optional(),
      }),
    )
    .min(1),
})

export const compositeSegmentsOf = (
  composite: GenerationJob,
  lengthOf: (jobId: string) => number | undefined,
): Segment[] | undefined => {
  const parsed = zCompositeRequest.safeParse(composite.request)
  if (!parsed.success) return undefined
  const segments: Segment[] = []
  for (const { sourceJobId, start, end } of parsed.data.segments) {
    const until = end ?? lengthOf(sourceJobId)
    if (until === undefined) return undefined
    segments.push({ sourceJobId, start, end: until })
  }
  return segments
}

const lengthIn = (source: DraftSource, jobId: string) =>
  jobId === source.rootId ? source.duration : editOf(source, jobId)?.duration

const normalize = (source: DraftSource, segments: readonly Segment[]): Segment[] | undefined => {
  const spans: Segment[] = []
  for (const { sourceJobId, start, end } of segments) {
    const length = lengthIn(source, sourceJobId)
    if (length === undefined) return undefined
    const until = Math.min(end, length)
    if (until - start <= EPSILON) continue
    const last = spans.at(-1)
    if (last?.sourceJobId === sourceJobId && near(last.end, start)) last.end = until
    else spans.push({ sourceJobId, start, end: until })
  }
  return spans
}

const sameSpans = (left: readonly Segment[], right: readonly Segment[]) =>
  left.length === right.length &&
  left.every((span, at) => {
    const other = right[at]
    return (
      other !== undefined &&
      span.sourceJobId === other.sourceJobId &&
      near(span.start, other.start) &&
      near(span.end, other.end)
    )
  })

export const restoreDraft = (
  source: DraftSource,
  segments: readonly Segment[],
): Draft | undefined => {
  const spans = normalize(source, segments)
  if (spans === undefined) return undefined
  const entries = segments.flatMap(({ sourceJobId, start, end }): DraftEntry[] => {
    const until = Math.min(end, lengthIn(source, sourceJobId) ?? 0)
    const used = (b0: number, b1: number) => ({
      t0: start > b0 + EPSILON ? roundToMs(start) : b0,
      t1: until < b1 - EPSILON ? roundToMs(until) : b1,
    })
    if (sourceJobId === source.rootId)
      return source.shots
        .filter((shot) => overlap(start, until, shot.start, shot.end))
        .map((shot) => ({ kind: 'shot', no: shot.no, ...used(shot.start, shot.end) }))
    return (editOf(source, sourceJobId)?.parts ?? [])
      .filter((part) => overlap(start, until, part.b0, part.b1))
      .map((part) => ({
        kind: 'edit',
        editId: sourceJobId,
        seg: part.seg,
        ...used(part.b0, part.b1),
      }))
  })
  if (!unique(entries.map(entryId))) return undefined
  const picked: Draft = { entries, closed: [] }
  const draft: Draft = {
    entries,
    closed: source.shots
      .filter((shot) => !shotOn(picked, shot.no) && !coveredByPick(source, picked, shot.no))
      .map((shot) => shot.no),
  }
  return sameSpans(outputOf(draftItemsOf(source, draft)), spans) ? draft : undefined
}

export const composeSegmentsOf = (pieces: readonly Piece[]) =>
  pieces.map(({ sourceJobId, start, end }) => ({
    sourceJobId,
    start: roundToMs(start),
    end: roundToMs(end),
  }))

type ComposeCheck = {
  source: DraftSource
  pieces: readonly Piece[]
  latest: readonly Segment[] | undefined
  composing: boolean
  busy: boolean
}

export const canCompose = ({ source, pieces, latest, composing, busy }: ComposeCheck): boolean => {
  if (busy || composing || pieces.length === 0) return false
  const current = normalize(source, pieces)
  if (current === undefined) return false
  const original = [{ sourceJobId: source.rootId, start: 0, end: source.duration }]
  if (sameSpans(current, original)) return false
  const previous = latest === undefined ? undefined : normalize(source, latest)
  return previous === undefined || !sameSpans(current, previous)
}

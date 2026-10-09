/** 剪辑草稿：一版成片上的一串有序片段，每段记出自哪条记录、取它自己媒体
 * 时间里的哪一截。初始是这一版按关键帧分的段；裁剪、调序、拆分、删除改它，AI 改把几段换成占位、
 * 结果回来再换成那条编辑段。草稿的片段与合成请求的片段同形。纯函数，不持有状态。 */

import { z } from 'zod'

/** AI 改选区的最短时长，秒。 */
export const MIN_RANGE_SECONDS = 1

/** 裁剪后一段的最短时长，秒。裁剪只是剪掉画面，没有模型那样的时长下限；留几帧，免得裁成零长。 */
const MIN_TRIM_SECONDS = 0.2

/** 拆分后每一半至少多长：再短只剩一两帧，看不清也剪不动。 */
const MIN_SPLIT_SECONDS = 0.1

/** 秒取整到毫秒：草稿里的时刻一律是毫秒精度，同一时刻处处相等。 */
const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** 一段素材：出自哪条记录，取它自己媒体时间里的 `[start, end)`，秒。即合成请求里的一段。 */
export type Clip = { sourceJobId: string; start: number; end: number }

/** 草稿里的一段素材。 */
export type DraftClip = Clip & {
  kind: 'clip'
  /** 由内容定：出处与起止。草稿里不会有两段一样的素材，选中跟着它走。 */
  id: string
  /** 这段原有的范围：关键帧段、拆出来的那一半，或 AI 结果整条。裁剪只能在里面收缩。 */
  origin: { start: number; end: number }
}

/** 交给 AI 改、结果还没回来的那几段：锁着，不能裁、拖、删、选。 */
export type DraftPending = {
  kind: 'pending'
  id: string
  editJobId: string
  /** 被换下来的段；失败时原样放回去。 */
  replaced: readonly DraftClip[]
}

export type DraftItem = DraftClip | DraftPending
export type Draft = readonly DraftItem[]

/** 选中的段：草稿里相邻的一串，按先后排的 id。 */
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

/** 一版按关键帧分的段：`[k_i, k_{i+1})`，最后一段到片尾；第一个关键帧不在 0 上时片头那截也算一段。 */
export const keyframeSegments = (
  versionJobId: string,
  index: { keyframes: readonly number[]; duration: number },
): DraftClip[] => {
  const cuts = [
    ...new Set([0, ...index.keyframes.filter((time) => time > 0 && time < index.duration)]),
  ].sort((left, right) => left - right)
  return cuts.map((start, at) =>
    clipItem({ sourceJobId: versionJobId, start, end: cuts[at + 1] ?? index.duration }),
  )
}

/** 草稿等于这一版的分段：没有改动。 */
export const isUnchanged = (draft: Draft, segments: readonly DraftClip[]): boolean =>
  draft.length === segments.length && draft.every((item, at) => item.id === segments[at]?.id)

/** 这一项是这一版没动过的一个关键帧段（顺序不论）。 */
export const isBaseSegment = (item: DraftItem, segments: readonly DraftClip[]): boolean =>
  item.kind === 'clip' && segments.some((segment) => segment.id === item.id)

export const itemDuration = (item: DraftItem): number =>
  item.kind === 'clip'
    ? item.end - item.start
    : item.replaced.reduce((sum, clip) => sum + clip.end - clip.start, 0)

/** 排在时间线上的一项：`at` 是它在草稿里的起点。占位按被换下的段占位置。 */
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

/** 合成请求的片段列表，就是草稿本身；有占位时还合成不了，返回 `undefined`。 */
export const compositeSegments = (draft: Draft): Clip[] | undefined =>
  draft.every((item) => item.kind === 'clip')
    ? draft.map(({ sourceJobId, start, end }) => ({ sourceJobId, start, end }))
    : undefined

// ---------- 选中 ----------

/** 选中的那一串在草稿里的位置；选中为空、有段不在了或不相邻都算没选。 */
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

/**
 * 点一段：没选时选中它；点紧挨着选区的段把它连进来；点选区两端的段把它去掉；点别处从那段重新选。
 * 占位点不动。
 */
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

/**
 * 键盘：左右键把焦点挪到相邻的段并只选它；加 Shift 时以选区另一端为锚点扩展或收缩选区。
 * 碰到占位或到头就不动。返回新的焦点与选区。
 */
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
  // 焦点在选区一端时，另一端是锚点；焦点不在选区里，就从焦点那段起。
  const anchor =
    range === undefined || (focus !== range.from && focus !== range.to)
      ? focus
      : focus === range.from
        ? range.to
        : range.from
  return { focus: target.id, selection: idsBetween(draft, anchor, focus + direction) }
}

// ---------- 编辑操作：都返回新的草稿与选区 ----------

export type Edit = { draft: Draft; selection: Selection }

/** 这段的一端最远能拖到哪：不超过它原有的范围，也不短于 {@link MIN_TRIM_SECONDS}（本来就更短的
 * 只能拉长、不能再缩）。 */
export const trimBounds = (clip: DraftClip, edge: 'start' | 'end'): { min: number; max: number } =>
  edge === 'start'
    ? { min: clip.origin.start, max: Math.max(clip.start, roundToMs(clip.end - MIN_TRIM_SECONDS)) }
    : { min: Math.min(clip.end, roundToMs(clip.start + MIN_TRIM_SECONDS)), max: clip.origin.end }

/** 把一段的一端拖到 `value`（这段素材自己的时间，秒），夹在 {@link trimBounds} 里。 */
export const trimClip = (draft: Draft, id: string, edge: 'start' | 'end', value: number): Edit => {
  const at = draft.findIndex((item) => item.id === id)
  const clip = draft[at]
  if (clip === undefined || clip.kind !== 'clip') return { draft, selection: [id] }
  const { min, max } = trimBounds(clip, edge)
  const bounded = roundToMs(Math.min(max, Math.max(min, value)))
  const trimmed = clipItem({ ...clip, [edge]: bounded }, clip.origin)
  return { draft: draft.with(at, trimmed), selection: [trimmed.id] }
}

/** 把相邻的几段挪到 `before` 之前（`before` 是挪之前草稿里的位置，等于长度就是挪到最后）。 */
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

/** 草稿时钟 `clock` 处能不能拆：落在一段素材里面，两边都不短于 {@link MIN_SPLIT_SECONDS}。 */
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

/** 在草稿时钟 `clock` 处把所在的那段一分为二；两半各自的原有范围以拆点为界，选中后一半。 */
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

/** 删选中的段，后面的跟上。要删光或选中里有占位时不删。 */
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

/** 把选中的几段换成一个占位，记着编辑段与被换下的段。 */
export const replaceWithPending = (
  draft: Draft,
  selection: Selection,
  editJobId: string,
): Draft => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return draft
  const replaced = draft
    .slice(range.from, range.to + 1)
    .filter((item): item is DraftClip => item.kind === 'clip')
  return [
    ...draft.slice(0, range.from),
    pendingItem(editJobId, replaced),
    ...draft.slice(range.to + 1),
  ]
}

/** 一条编辑段此刻的结论：还在跑、完成了（结果多长）、失败了（为什么）。 */
export type EditOutcome =
  { kind: 'running' } | { kind: 'done'; duration: number } | { kind: 'failed'; message: string }

/**
 * 有结论的占位落定：完成的换成那条编辑段整条，失败的换回原来的段。还在跑、或一时找不到那条记录
 * （刚提交、还没进列表）的照旧锁着。没有可落定的就原样返回同一个草稿。
 */
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

// ---------- AI 改 ----------

/** 编辑段在基底上改的那一段，毫秒，记在编辑段上；`duration` 是结果多长（秒），还不知道时没有。 */
export type EditRange = {
  id: string
  rangeStartMs: number
  rangeEndMs: number
  duration?: number | undefined
}

export type AiTarget =
  /** 能交给 AI：基底上的区间（秒，正好落在关键帧上），以及它们在草稿里是第几段（从 1 起）。 */
  | { kind: 'ready'; range: { start: number; end: number }; first: number; last: number }
  | { kind: 'empty' }
  /** 选区里有裁过、拆过、调过序或来自 AI 结果的段。 */
  | { kind: 'modified' }
  /** 不足最短时长。 */
  | { kind: 'short' }

const toSeconds = (ms: number): number => ms / 1000

/**
 * 选区能不能交给 AI 改。能改的是一串未改动的基底关键帧段：来源是这一版、起止正好是它的关键帧、
 * 按基底时间连续相邻。另外，单独选中一整条没动过的 AI 结果，可以在它当初那一段上再生成一次。
 */
export const aiTarget = (
  draft: Draft,
  selection: Selection,
  segments: readonly DraftClip[],
  edits: readonly EditRange[],
): AiTarget => {
  const range = selectedRange(draft, selection)
  if (range === undefined) return { kind: 'empty' }
  const items = draft.slice(range.from, range.to + 1)
  const position = { first: range.from + 1, last: range.to + 1 }
  const order = items.map((item) => segments.findIndex((segment) => segment.id === item.id))
  const contiguous = order.every((at, offset) => at >= 0 && at === (order[0] ?? -1) + offset)
  if (contiguous) {
    const start = segments[order[0] ?? 0]?.start ?? 0
    const end = segments[order.at(-1) ?? 0]?.end ?? 0
    return end - start < MIN_RANGE_SECONDS
      ? { kind: 'short' }
      : { kind: 'ready', range: { start, end }, ...position }
  }
  const only = items.length === 1 ? items[0] : undefined
  const edit =
    only?.kind === 'clip' ? edits.find((item) => item.id === only.sourceJobId) : undefined
  if (
    only?.kind === 'clip' &&
    edit?.duration !== undefined &&
    only.start === 0 &&
    only.end === roundToMs(edit.duration)
  ) {
    return {
      kind: 'ready',
      range: { start: toSeconds(edit.rangeStartMs), end: toSeconds(edit.rangeEndMs) },
      ...position,
    }
  }
  return { kind: 'modified' }
}

// ---------- 草稿丢了：按服务端重建 ----------

/**
 * 按基底分段重建草稿：每个（这一版，区间）位置放最新提交的那条编辑段，区间要正好落在这一版的
 * 关键帧上，位置重叠时新的优先；失败的不算。这里一律先放成占位，完成的由 {@link resolvePending}
 * 换成结果，与提交后结果回来走同一条路。
 */
export const rebuildDraft = (
  segments: readonly DraftClip[],
  edits: readonly (EditRange & { createdAt: string; failed: boolean })[],
): Draft => {
  const accepted: { from: number; to: number; editJobId: string }[] = []
  const newestFirst = edits
    .filter((edit) => !edit.failed)
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id),
    )
  for (const edit of newestFirst) {
    const from = segments.findIndex((segment) => segment.start === toSeconds(edit.rangeStartMs))
    const to = segments.findIndex((segment) => segment.end === toSeconds(edit.rangeEndMs))
    if (from < 0 || to < from) continue
    if (accepted.some((taken) => from <= taken.to && to >= taken.from)) continue
    accepted.push({ from, to, editJobId: edit.id })
  }
  const draft: DraftItem[] = []
  for (let at = 0; at < segments.length; at += 1) {
    const taken = accepted.find((entry) => entry.from === at)
    const segment = segments[at]
    if (taken !== undefined) {
      draft.push(pendingItem(taken.editJobId, segments.slice(taken.from, taken.to + 1)))
      at = taken.to
    } else if (segment !== undefined) {
      draft.push(segment)
    }
  }
  return draft
}

/** 草稿引用的所有记录：各段的出处与占位的编辑段。 */
export const draftSources = (draft: Draft): Set<string> =>
  new Set(
    draft.flatMap((item) =>
      item.kind === 'clip'
        ? [item.sourceJobId]
        : [item.editJobId, ...item.replaced.map((clip) => clip.sourceJobId)],
    ),
  )

// ---------- 撤销栈 ----------

/** 撤销的一步：草稿连同当时的选中。 */
export type Snapshot = { draft: Draft; selection: Selection }

export type DraftHistory = {
  past: readonly Snapshot[]
  present: Snapshot
  future: readonly Snapshot[]
}

export const startHistory = (draft: Draft): DraftHistory => ({
  past: [],
  present: { draft, selection: [] },
  future: [],
})

/** 一次编辑进栈，清掉重做。 */
export const commit = (history: DraftHistory, next: Snapshot): DraftHistory => ({
  past: [...history.past, history.present],
  present: next,
  future: [],
})

/** 只改选中，不进栈。 */
export const reselect = (history: DraftHistory, selection: Selection): DraftHistory => ({
  ...history,
  present: { ...history.present, selection },
})

export const undo = (history: DraftHistory): DraftHistory => {
  const previous = history.past.at(-1)
  return previous === undefined
    ? history
    : {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
}

export const redo = (history: DraftHistory): DraftHistory => {
  const next = history.future[0]
  return next === undefined
    ? history
    : { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
}

/** 栈里每一步都落定占位，各步的选中只留还在的段；失败原因只取当前这一步的，同一件事只说一次。 */
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

// ---------- 存放 ----------

/** 存进浏览器的格式版本；格式一改就加一，旧的读不出来按重建处理。 */
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
  /** 草稿已提交合成，等的是哪条合成。 */
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

/** 读存着的草稿；不是 JSON、格式版本不对、形状不对都返回 `undefined`。 */
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

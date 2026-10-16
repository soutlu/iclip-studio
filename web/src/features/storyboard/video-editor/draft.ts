/** 剪辑草稿：一版成片上的一串有序片段，每段记出自哪条记录、取它自己媒体时间里的哪一截。
 * 裁剪、调序、拆分、删除与选用版本改变它；AI 生成只增加候选。片段与合成请求同形。 */

import { z } from 'zod'
import { amend, startHistory, type History } from '../edit-history'

/** 裁剪后一段的最短时长，秒。裁剪只是剪掉画面，没有模型那样的时长下限；留几帧，免得裁成零长。 */
const MIN_TRIM_SECONDS = 0.2

/** 拆分后每一半至少多长：再短只剩一两帧，看不清也剪不动。 */
const MIN_SPLIT_SECONDS = 0.1

/** 秒取整到毫秒：草稿里的时刻一律是毫秒精度，同一时刻处处相等。 */
export const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

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

/** 先前已提交的占位：保留浏览器里仍在等待结果的剪辑，新提交不再创建占位。 */
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

/** 比较实际播放内容；仅拆分或合并同来源的连续片段不算内容修改。 */
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

/** 为同一次 AI 编辑把连续同来源的选区归成一段；保留当前画面与选中，不代选生成结果。 */
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

/** 编辑段在基底上改的那一段，毫秒，记在编辑段上。 */
export type EditRange = {
  id: string
  rangeStartMs: number
  rangeEndMs: number
}

// ---------- 初次进入：根据已有编辑区间组织原片 ----------

/**
 * 将已有编辑的区间组织为一段，仍选用基底 V1；按精确区间切分，重叠时较新的区间优先。
 * 成功或在途区间优先于仅有失败的区间，不根据生成状态自动选择结果。
 */
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

export type DraftHistory = History<Snapshot>

/** 从这份草稿起算的撤销栈，没有选中。 */
export const startDraftHistory = (draft: Draft): DraftHistory =>
  startHistory({ draft, selection: [] })

/** 只改选中，不进栈。 */
export const reselect = (history: DraftHistory, selection: Selection): DraftHistory =>
  amend(history, { ...history.present, selection })

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

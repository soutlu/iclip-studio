import { z } from 'zod'
import { roundToMs } from '../editing/clip'
import type { Edge } from '../editing/timeline-drag'
import type { GenerationJob } from '../storyboard.api'
import { partItemId, type EditBlock, type EditPart, type Shot } from './edit-blocks'

/**
 * 草稿：要合成的内容，由开着的原片镜头与选用了的编辑段（编辑片段按它自己的关键帧切成的段）组成，
 * 两种都可以有多块、可以同时在。这里是纯函数，关键帧与编辑记录都由调用方读好传进来。
 */

/** 比较时间用的容差（秒）：渲染与关键帧读数取到毫秒。 */
const EPSILON = 0.001
/** 修剪后一块至少用这么久（秒）。 */
export const MIN_USE = 0.5
/** 拖修剪把手时离边界这么近（像素）就吸上去。 */
const SNAP_PX = 8

/** 可以选用的编辑片段：完成、读到了关键帧。 */
export type ReadyEdit = {
  id: string
  /** 在编辑轨上按生成先后的位次：同一位置、同一序号时按它排。 */
  order: number
  /** 区间碰到的镜头。 */
  from: number
  to: number
  mediaUrl: string
  duration: number
  parts: readonly EditPart[]
}

/** 编辑轨上能选用的编辑片段，`order` 是它在编辑轨上按生成先后的位次。 */
export const readyEditsOf = (blocks: readonly EditBlock[]): ReadyEdit[] =>
  blocks.flatMap((block, order): ReadyEdit[] =>
    block.state.kind === 'ready' && block.job.outputUrl !== null
      ? [
          {
            id: block.id,
            order,
            from: block.from,
            to: block.to,
            mediaUrl: block.job.outputUrl,
            duration: block.state.duration,
            parts: block.state.parts,
          },
        ]
      : [],
  )

/** 算草稿要用的东西：原片、它的镜头和能选用的编辑片段。 */
export type DraftSource = {
  rootId: string
  rootUrl: string
  duration: number
  shots: readonly Shot[]
  edits: readonly ReadyEdit[]
}

/** 选用的一段：`t0`–`t1` 是这一段实际用到的起止，按编辑片段自己的时间，初始是这一段的关键帧边界。 */
export type UsedPart = { editId: string; seg: number; t0: number; t1: number; seq: number }
/** 用户对原片镜头的明确开关；打开时记下序号，重新打开的镜头按它排在同一位置已有的块后面。 */
export type ShotToggle = { no: number; on: false } | { no: number; on: true; seq: number }
/** 原片镜头的修剪：原片时间，限在这个镜头内。 */
export type Cut = { no: number; t0: number; t1: number }

export type Draft = {
  picks: readonly UsedPart[]
  toggles: readonly ShotToggle[]
  cuts: readonly Cut[]
  /** 放进草稿的递增序号，最近一次用到的那个。 */
  seq: number
}

/** 默认草稿：全部原片镜头开着、没有选用。 */
export const EMPTY_DRAFT: Draft = { picks: [], toggles: [], cuts: [], seq: 0 }

const zTime = z.number().nonnegative()
export const zDraft = z.object({
  picks: z.array(
    z.object({
      editId: z.string().min(1),
      seg: z.number().int().positive(),
      t0: zTime,
      t1: zTime,
      seq: z.number().int().nonnegative(),
    }),
  ),
  toggles: z.array(
    z.discriminatedUnion('on', [
      z.object({ no: z.number().int().positive(), on: z.literal(false) }),
      z.object({
        no: z.number().int().positive(),
        on: z.literal(true),
        seq: z.number().int().nonnegative(),
      }),
    ]),
  ),
  cuts: z.array(z.object({ no: z.number().int().positive(), t0: zTime, t1: zTime })),
  seq: z.number().int().nonnegative(),
})

const near = (left: number, right: number) => Math.abs(left - right) < EPSILON
const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > EPSILON

export const shotItemId = (no: number) => `shot-${no}`

const editOf = (source: DraftSource, id: string) => source.edits.find((edit) => edit.id === id)
const partOf = (edit: ReadyEdit, seg: number) => edit.parts.find((part) => part.seg === seg)
const covers = (edit: { from: number; to: number }, no: number) => edit.from <= no && no <= edit.to
const hasPick = (draft: Draft, editId: string) => draft.picks.some((pick) => pick.editId === editId)

/** 原片镜头 `no` 开不开：有用户的明确开关就用它；没有时，有选用的编辑片段覆盖它就关，否则开。 */
export const shotOn = (source: DraftSource, draft: Draft, no: number): boolean => {
  const toggle = draft.toggles.find((item) => item.no === no)
  if (toggle !== undefined) return toggle.on
  return !source.edits.some((edit) => covers(edit, no) && hasPick(draft, edit.id))
}

/** 镜头一离开草稿就丢掉它的修剪，再回来是整个镜头。 */
const pruneCuts = (source: DraftSource, draft: Draft): Draft => ({
  ...draft,
  cuts: draft.cuts.filter((cut) => shotOn(source, draft, cut.no)),
})

/** 用户开关原片镜头：记明确开关，打开时记下序号。 */
export const putShot = (source: DraftSource, draft: Draft, no: number, on: boolean): Draft => {
  const seq = on ? draft.seq + 1 : draft.seq
  const toggle: ShotToggle = on ? { no, on, seq } : { no, on }
  return pruneCuts(source, {
    ...draft,
    toggles: [...draft.toggles.filter((item) => item.no !== no), toggle],
    seq,
  })
}

export const isPicked = (draft: Draft, editId: string, seg: number) =>
  draft.picks.some((pick) => pick.editId === editId && pick.seg === seg)

/**
 * 选用一段，用到的起止回到这一段的边界。这条编辑片段还没有段在草稿里时，清掉它覆盖的镜头上用户「开」的
 * 明确开关，默认关闭重新生效；用户关掉的不动。
 */
export const pickPart = (source: DraftSource, draft: Draft, editId: string, seg: number): Draft => {
  const edit = editOf(source, editId)
  const part = edit === undefined ? undefined : partOf(edit, seg)
  if (edit === undefined || part === undefined || isPicked(draft, editId, seg)) return draft
  const toggles = hasPick(draft, editId)
    ? draft.toggles
    : draft.toggles.filter((toggle) => !(toggle.on && covers(edit, toggle.no)))
  const seq = draft.seq + 1
  return pruneCuts(source, {
    ...draft,
    toggles,
    picks: [...draft.picks, { editId, seg, t0: part.b0, t1: part.b1, seq }],
    seq,
  })
}

/** 取消选用一段；这条编辑片段的段都拿掉后，它覆盖的镜头回到默认。 */
export const unpickPart = (draft: Draft, editId: string, seg: number): Draft => ({
  ...draft,
  picks: draft.picks.filter((pick) => !(pick.editId === editId && pick.seg === seg)),
})

type ItemFields = {
  id: string
  sourceJobId: string
  mediaUrl: string
  t0: number
  t1: number
  b0: number
  b1: number
  seq: number
} & ({ kind: 'shot'; no: number } | { kind: 'edit'; edit: ReadyEdit; seg: number })

/** 草稿里的一块：`t0`–`t1` 是它用到的起止、`b0`–`b1` 是它能用的边界（都按来源自己的时间），`at`、`d` 是它在合成里的位置。 */
export type DraftItem = ItemFields & { at: number; d: number }

/** 排序时比较的一块：原片镜头或编辑段，带放进草稿的序号。 */
type Probe =
  | { kind: 'shot'; no: number; seq: number }
  | { kind: 'edit'; edit: ReadyEdit; seg: number; seq: number }

/** 编辑段的位置：第 k 段对应覆盖到的第 k 个镜头，段比镜头多时多出来的都算最后一个镜头。 */
const shotOfPart = (edit: ReadyEdit, seg: number) => Math.min(edit.from + seg - 1, edit.to)

/** 先按镜头位置，同一位置上按放进草稿的先后；同序号时编辑段在原片前，再按编辑片段生成先后、段号。 */
const rankOf = (probe: Probe): readonly number[] =>
  probe.kind === 'edit'
    ? [shotOfPart(probe.edit, probe.seg), probe.seq, 0, probe.edit.order, probe.seg]
    : [probe.no, probe.seq, 1, 0, 0]

const compareRank = (left: Probe, right: Probe) => {
  const [a, b] = [rankOf(left), rankOf(right)]
  for (let at = 0; at < a.length; at += 1) {
    const x = a[at] ?? 0
    const y = b[at] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 草稿里的块按排序首尾相接，从 0 起。 */
export const draftItemsOf = (source: DraftSource, draft: Draft): DraftItem[] => {
  const items: ItemFields[] = []
  for (const shot of source.shots) {
    if (!shotOn(source, draft, shot.no)) continue
    const cut = draft.cuts.find((item) => item.no === shot.no)
    const toggle = draft.toggles.find((item) => item.no === shot.no)
    items.push({
      kind: 'shot',
      id: shotItemId(shot.no),
      no: shot.no,
      sourceJobId: source.rootId,
      mediaUrl: source.rootUrl,
      t0: cut?.t0 ?? shot.start,
      t1: cut?.t1 ?? shot.end,
      b0: shot.start,
      b1: shot.end,
      seq: toggle?.on === true ? toggle.seq : 0,
    })
  }
  for (const pick of draft.picks) {
    const edit = editOf(source, pick.editId)
    const part = edit === undefined ? undefined : partOf(edit, pick.seg)
    if (edit === undefined || part === undefined) continue
    items.push({
      kind: 'edit',
      id: partItemId(edit.id, pick.seg),
      edit,
      seg: pick.seg,
      sourceJobId: edit.id,
      mediaUrl: edit.mediaUrl,
      t0: pick.t0,
      t1: pick.t1,
      b0: part.b0,
      b1: part.b1,
      seq: pick.seq,
    })
  }
  items.sort(compareRank)
  let at = 0
  return items.map((item) => {
    const d = roundToMs(item.t1 - item.t0)
    const placed = { ...item, at, d }
    at = roundToMs(at + d)
    return placed
  })
}

/**
 * 把编辑段拖到草稿上、还没松手时的草稿：这一段按排序插进去，此刻开着的镜头和它们的修剪都留着（松手选用后
 * 它覆盖的镜头才按默认关掉），别的块只是给它让位。这一段已在草稿里、或不能选用时为 undefined。
 */
export const previewPick = (
  source: DraftSource,
  draft: Draft,
  editId: string,
  seg: number,
): DraftItem[] | undefined => {
  const picked = pickPart(source, draft, editId, seg)
  if (picked === draft) return undefined
  const kept = draftItemsOf(source, draft).flatMap((item): ShotToggle[] =>
    item.kind === 'shot' ? [{ no: item.no, on: true, seq: item.seq }] : [],
  )
  const toggles = [
    ...picked.toggles.filter((toggle) => !kept.some((item) => item.no === toggle.no)),
    ...kept,
  ]
  return draftItemsOf(source, { ...picked, toggles, cuts: draft.cuts })
}

export const totalOf = (items: readonly { d: number }[]) =>
  roundToMs(items.reduce((sum, item) => sum + item.d, 0))

/** 合成里的一段：出自原片或一条编辑片段的 `start`–`end`（按它自己的时间）。 */
export type Piece = { sourceJobId: string; mediaUrl: string; start: number; end: number }

/** 合成内容：草稿按顺序拼，同一来源里时间相接的相邻块并成一段。 */
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

/**
 * 改草稿后播放头放在哪：留在原来那一块的同一位置；那一块没了，停在原来位置上现在那一块的开头；
 * 原来在末尾（不在任何一块里）就留在新的末尾。
 */
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

/**
 * 草稿里一块的说明：没剪过写时长；剪过写实际用到的秒数和它的边界有多长。编辑段多于一段时前面写第几段。
 * 如「第 2 段 · 1.0 秒（这一段 1.3 秒）· 已选用」「3.2 秒 · 原片」。
 */
export const draftLineOf = (item: DraftItem): string => {
  const cut = item.t0 > item.b0 + EPSILON || item.t1 < item.b1 - EPSILON
  const whole = item.kind === 'edit' ? '这一段' : '这个镜头'
  const prefix = item.kind === 'edit' && item.edit.parts.length > 1 ? `第 ${item.seg} 段 · ` : ''
  const length = cut
    ? `${secondsText(item.d)} 秒（${whole} ${secondsText(item.b1 - item.b0)} 秒）`
    : `${secondsText(item.d)} 秒 `
  return `${prefix}${length}· ${item.kind === 'edit' ? '已选用' : '原片'}`
}

/** 一块的修剪范围：用到的起止、能到的边界与最短长度，都按来源自己的时间。 */
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
  // 这一段本身不到最短长度时，只能整段用。
  min: Math.min(MIN_USE, item.b1 - item.b0),
  snaps: [item.b0, item.b1],
})

/** 原片轨上的选区（生成用）至少这么长（秒）。 */
const MIN_RUN = 1

/**
 * 原片轨上选区 `run` 的修剪范围：整条原片之内，可以停在镜头中间、越过镜头分界，吸附每个镜头分界与片尾。
 * 选区本身不到最短长度时（点了一个很短的镜头）只能拉长。
 */
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

/** 拖动：离边界 8px 以内吸到边界上。`pps` 是每秒多少像素。 */
export const snapNear =
  (bounds: readonly number[], pps: number) =>
  (time: number): number =>
    bounds
      .filter((bound) => Math.abs(bound - time) * pps <= SNAP_PX)
      .sort((left, right) => Math.abs(left - time) - Math.abs(right - time))[0] ?? time

/** 方向键：只吸往前方的边界（越过它，或停在它前面 8px 以内），不吸回刚离开的那条，免得一步不够 8px 时卡住。 */
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

/** 把手 `edge` 落到 `time` 时的新起止：先吸附，再停在边界与最短长度上。 */
export const trimTo = (
  spec: TrimSpec,
  edge: Edge,
  time: number,
  snap: (time: number) => number,
): { t0: number; t1: number } =>
  edge === 'end'
    ? { t0: spec.t0, t1: roundToMs(clamp(snap(time), spec.t0 + spec.min, spec.hi)) }
    : { t0: roundToMs(clamp(snap(time), spec.lo, spec.t1 - spec.min)), t1: spec.t1 }

/** 写回一块的修剪；原片镜头拉回整段时删掉修剪记录。 */
export const trimItem = (
  draft: Draft,
  item: DraftItem,
  { t0, t1 }: { t0: number; t1: number },
): Draft => {
  if (item.kind === 'edit')
    return {
      ...draft,
      picks: draft.picks.map((pick) =>
        pick.editId === item.edit.id && pick.seg === item.seg ? { ...pick, t0, t1 } : pick,
      ),
    }
  const cuts = draft.cuts.filter((cut) => cut.no !== item.no)
  const whole = near(t0, item.b0) && near(t1, item.b1)
  return { ...draft, cuts: whole ? cuts : [...cuts, { no: item.no, t0, t1 }] }
}

/** 存着的草稿能不能用：每一处都对得上现在的原片与编辑片段。 */
export const isUsableDraft = (source: DraftSource, draft: Draft): boolean => {
  const shotOf = (no: number) => source.shots.find((shot) => shot.no === no)
  const within = (t0: number, t1: number, b0: number, b1: number) =>
    t0 >= b0 - EPSILON && t1 <= b1 + EPSILON && t1 - t0 > EPSILON
  const unique = (keys: readonly string[]) => new Set(keys).size === keys.length
  return (
    draft.picks.every((pick) => {
      const edit = editOf(source, pick.editId)
      const part = edit === undefined ? undefined : partOf(edit, pick.seg)
      return part !== undefined && within(pick.t0, pick.t1, part.b0, part.b1)
    }) &&
    unique(draft.picks.map((pick) => partItemId(pick.editId, pick.seg))) &&
    draft.toggles.every((toggle) => shotOf(toggle.no) !== undefined) &&
    unique(draft.toggles.map((toggle) => String(toggle.no))) &&
    draft.cuts.every((cut) => {
      const shot = shotOf(cut.no)
      return shot !== undefined && within(cut.t0, cut.t1, shot.start, shot.end)
    }) &&
    unique(draft.cuts.map((cut) => String(cut.no)))
  )
}

/** 合成请求里的一段，起止按出处自己的时间（秒）。 */
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

/**
 * 读一次合成请求里的片段。`end: null` 是用到出处结尾，在这里按 `lengthOf` 给的出处时长换成实际值；
 * 读不懂、或有这样的一段而出处不知道多长时为 undefined。
 */
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

/**
 * 合成片段统一成可比较的样子：限在出处之内，同一出处时间相接的段并成一段；
 * 有出处不是原片、也不是能选用的编辑片段时为 undefined。
 */
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

/**
 * 从一次合成还原草稿，让它的合成内容正好等于这串片段：原片片段拆到镜头上，编辑片段拆到它的段上，
 * 盖到一部分的记成修剪；片段里没出现的原片镜头关着；序号按片段在请求里的先后给。
 * 造出来的合成内容和请求对不上（比如顺序不符合排序规则）时为 undefined，不硬凑。
 */
export const restoreDraft = (
  source: DraftSource,
  segments: readonly Segment[],
): Draft | undefined => {
  const spans = normalize(source, segments)
  if (spans === undefined) return undefined
  const shown = new Map<number, { t0: number; t1: number; seq: number }>()
  const picks: UsedPart[] = []
  let failed = false
  segments.forEach(({ sourceJobId, start, end }, at) => {
    const seq = at + 1
    const until = Math.min(end, lengthIn(source, sourceJobId) ?? 0)
    if (sourceJobId === source.rootId) {
      for (const shot of source.shots) {
        if (!overlap(start, until, shot.start, shot.end)) continue
        if (shown.has(shot.no)) failed = true
        shown.set(shot.no, {
          t0: Math.max(start, shot.start),
          t1: Math.min(until, shot.end),
          seq,
        })
      }
      return
    }
    const edit = editOf(source, sourceJobId)
    for (const part of edit?.parts ?? []) {
      if (!overlap(start, until, part.b0, part.b1)) continue
      if (picks.some((pick) => pick.editId === sourceJobId && pick.seg === part.seg)) failed = true
      picks.push({
        editId: sourceJobId,
        seg: part.seg,
        t0: roundToMs(Math.max(start, part.b0)),
        t1: roundToMs(Math.min(until, part.b1)),
        seq,
      })
    }
  })
  if (failed) return undefined
  const picked: Draft = { ...EMPTY_DRAFT, picks, seq: segments.length }
  const toggles: ShotToggle[] = []
  const cuts: Cut[] = []
  for (const shot of source.shots) {
    const use = shown.get(shot.no)
    const byDefault = shotOn(source, picked, shot.no)
    if (use === undefined) {
      if (byDefault) toggles.push({ no: shot.no, on: false })
      continue
    }
    if (!byDefault) toggles.push({ no: shot.no, on: true, seq: use.seq })
    if (!near(use.t0, shot.start) || !near(use.t1, shot.end))
      cuts.push({ no: shot.no, t0: roundToMs(use.t0), t1: roundToMs(use.t1) })
  }
  const draft: Draft = { ...picked, toggles, cuts }
  return sameSpans(outputOf(draftItemsOf(source, draft)), spans) ? draft : undefined
}

/** 提交合成用的片段：编辑段写明用到的起止。 */
export const composeSegmentsOf = (pieces: readonly Piece[]) =>
  pieces.map(({ sourceJobId, start, end }) => ({
    sourceJobId,
    start: roundToMs(start),
    end: roundToMs(end),
  }))

type ComposeCheck = {
  source: DraftSource
  pieces: readonly Piece[]
  /** 最近一次完成的合成的片段。 */
  latest: readonly Segment[] | undefined
  composing: boolean
  busy: boolean
}

/** 能不能「合成新版本」：内容为空、就是整条原片、和最近一次合成一样，或正在合成、正在提交时都不能。 */
export const canCompose = ({ source, pieces, latest, composing, busy }: ComposeCheck): boolean => {
  if (busy || composing || pieces.length === 0) return false
  const current = normalize(source, pieces)
  if (current === undefined) return false
  const original = [{ sourceJobId: source.rootId, start: 0, end: source.duration }]
  if (sameSpans(current, original)) return false
  const previous = latest === undefined ? undefined : normalize(source, latest)
  return previous === undefined || !sameSpans(current, previous)
}

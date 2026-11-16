import { SPLIT_BOUNDARY_EPSILON_S } from '@hyperframes/core/composition-contract'
import type { Edge } from '../editing/timeline-drag'
import { isMediaClip, MIN_CLIP_MS, type FilmClip, type MediaClip } from './composition/film'
import { onRow, topTrack, zoneOf, type RowKey } from './placement'
import { movingWith } from './selection'
import { resolveNearestFreeStart } from './vendor/hyperframes-studio/player/components/timelineCollision'
import {
  resolveAllTrackGaps,
  resolveCloseGapShifts,
  resolveTrackGapAt,
} from './vendor/hyperframes-studio/player/components/timelineGaps'

/**
 * 一个片段在 final-cut 里的起止和它的入点（毫秒）。入点是从素材的哪里开始放，
 * 组件或块的片段是从组件自己的第几毫秒开始播（`playbackStart`），「其他」片段和字幕没有入点，是 0。
 */
export type Timing = { start: number; duration: number; mediaStart: number }

/** 片段有没有入点：视频片段、音频片段和组件或块的片段有。 */
const hasInPoint = (clip: FilmClip) => isMediaClip(clip) || clip.kind === 'host'

export const timingOf = (clip: FilmClip): Timing => ({
  start: clip.start,
  duration: clip.duration,
  mediaStart: isMediaClip(clip) ? clip.mediaStart : clip.kind === 'host' ? clip.playbackStart : 0,
})

const endOf = (clip: Pick<FilmClip, 'start' | 'duration'>) => clip.start + clip.duration

const rowKeyOf = (clip: FilmClip): RowKey => ({ zone: zoneOf(clip), track: clip.track })

/** 片段的速度：final-cut 里的 1 毫秒用掉素材的几毫秒。组件或块的片段是 1。 */
export const rateOf = (clip: FilmClip): number => (isMediaClip(clip) ? clip.playbackRate : 1)

/**
 * 裁 `edge` 这一端时，这一端能到的范围（final-cut 的毫秒）：不压到同一行的邻居，片段不短于最短长度；
 * 开头往前不早于入点 0（「其他」片段和字幕没有入点，只受邻居限制），结尾往后不超出素材剩下的长度（音频开着
 * 循环也一样）。素材按片段的速度用，照参照的工作台：剩下的素材在 final-cut 里能放（素材长 − 入点）÷ 速度。
 * `sourceMs` 是视频片段、音频片段素材的总长，还不知道时结尾不许往外拉；别的片段不看它，结尾不设上限。
 */
export const trimBounds = (
  clip: FilmClip,
  edge: Edge,
  clips: readonly FilmClip[],
  sourceMs: number | undefined,
): { min: number; max: number } => {
  const row = clips.filter((other) => onRow(other, rowKeyOf(clip)) && other.id !== clip.id)
  const { mediaStart } = timingOf(clip)
  const rate = rateOf(clip)
  if (edge === 'start') {
    const previousEnd = Math.max(0, ...row.filter((other) => endOf(other) <= clip.start).map(endOf))
    const inPoint = hasInPoint(clip) ? Math.ceil(clip.start - mediaStart / rate) : 0
    return {
      min: Math.max(previousEnd, inPoint),
      max: endOf(clip) - MIN_CLIP_MS,
    }
  }
  // 后面没有片段时是无穷大：只受素材长度限制
  const nextStart = Math.min(
    ...row.filter((other) => other.start >= endOf(clip)).map((other) => other.start),
  )
  // 组件的长度属于组件自己的时间线，不拿来卡裁剪
  const sourceEnd = !isMediaClip(clip)
    ? Infinity
    : sourceMs === undefined
      ? endOf(clip)
      : Math.floor(clip.start + (sourceMs - mediaStart) / rate)
  return {
    min: clip.start + MIN_CLIP_MS,
    max: Math.max(endOf(clip), Math.min(nextStart, sourceEnd)),
  }
}

/**
 * 把 `edge` 这一端裁到 `timeMs`（先收进 `bounds`）之后，片段的起止和入点；裁开头时入点跟着动，
 * 动的是挪过的时间 × 速度（取整到毫秒，不小于 0）。
 */
export const trimmed = (
  clip: FilmClip,
  edge: Edge,
  timeMs: number,
  bounds: { min: number; max: number },
): Timing => {
  const at = Math.min(bounds.max, Math.max(bounds.min, timeMs))
  const { mediaStart } = timingOf(clip)
  if (edge === 'end') return { start: clip.start, duration: at - clip.start, mediaStart }
  const delta = at - clip.start
  return {
    start: at,
    duration: clip.duration - delta,
    mediaStart: Math.max(0, Math.round(mediaStart + delta * rateOf(clip))),
  }
}

/** 「原片截取」条上拖的是哪里：入点的抓手、出点的抓手，或整段（换一截素材）。 */
export type SlipGrip = Edge | 'body'

/**
 * 在「原片截取」条上拖 `grip`、指针对着素材的 `sourceAt` 毫秒时，片段的起止和入点（`sourceMs` 是素材总长）。
 * 片段在 final-cut 里的开始不动，不推后面的片段：
 * - 入点：出点不动，时长 =（出点 − 入点）÷ 速度；往前最多到时长碰上同一行后面的片段、不早于 0，往后留够最短时长；
 * - 出点：入点不动，按裁结尾（`trimBounds`）收住；
 * - 整段：时长不变，框的正中对到指针处，入点收在 0 到「素材总长 − 用掉的长度」之间。
 */
export const slipped = (
  clip: MediaClip,
  grip: SlipGrip,
  sourceAt: number,
  clips: readonly FilmClip[],
  sourceMs: number,
): Timing => {
  const { mediaStart } = clip
  const rate = rateOf(clip)
  const used = clip.duration * rate
  const outPoint = mediaStart + used
  if (grip === 'end') {
    const bounds = trimBounds(clip, 'end', clips, sourceMs)
    return trimmed(clip, 'end', Math.round(clip.start + (sourceAt - mediaStart) / rate), bounds)
  }
  if (grip === 'body') {
    const at = Math.min(sourceMs - used, sourceAt - used / 2)
    return { start: clip.start, duration: clip.duration, mediaStart: Math.max(0, Math.round(at)) }
  }
  // 出点不动，素材剩下的长度卡不住入点往前拉：按入点在 0 处算裁结尾的上限，只剩后面片段的限制
  const { max } = trimBounds({ ...clip, mediaStart: 0 }, 'end', clips, sourceMs)
  const earliest = Math.max(0, Math.ceil(outPoint - (max - clip.start) * rate))
  const latest = Math.floor(outPoint - MIN_CLIP_MS * rate)
  const inPoint = Math.max(earliest, Math.min(latest, Math.round(sourceAt)))
  return {
    start: clip.start,
    duration: Math.round((outPoint - inPoint) / rate),
    mediaStart: inPoint,
  }
}

const edgeOf = (clip: FilmClip, edge: Edge) => (edge === 'start' ? clip.start : endOf(clip))

/** 视频片段、音频片段素材的总长（毫秒）：还不知道时是 undefined。组件或块的片段不看它。 */
export type SourceLength = (clip: FilmClip) => number | undefined

/**
 * 几个片段一起裁 `edge` 这一端、挪同一个量时，这个量能取的范围（毫秒）：
 * 每个片段这一端按 `trimBounds` 能到哪里，取最受限的那个。
 */
export const groupTrimRange = (
  members: readonly FilmClip[],
  edge: Edge,
  clips: readonly FilmClip[],
  sourceMs: SourceLength,
): { min: number; max: number } => {
  const ranges = members.map((member) => {
    const bounds = trimBounds(member, edge, clips, sourceMs(member))
    return { min: bounds.min - edgeOf(member, edge), max: bounds.max - edgeOf(member, edge) }
  })
  return {
    min: Math.max(...ranges.map((range) => range.min)),
    max: Math.min(...ranges.map((range) => range.max)),
  }
}

/** 几个片段一起把 `edge` 这一端挪 `delta` 毫秒（先收进 `groupTrimRange`）之后，各自的起止和入点。 */
export const groupTrimmed = (
  members: readonly FilmClip[],
  edge: Edge,
  delta: number,
  clips: readonly FilmClip[],
  sourceMs: SourceLength,
): Map<string, Timing> => {
  const range = groupTrimRange(members, edge, clips, sourceMs)
  const shift = Math.min(range.max, Math.max(range.min, delta))
  return new Map(
    members.map((member) => [
      member.id,
      trimmed(
        member,
        edge,
        edgeOf(member, edge) + shift,
        trimBounds(member, edge, clips, sourceMs(member)),
      ),
    ]),
  )
}

/** `clip` 联动着的别的片段：链接名（`data-link`）和它相同的。 */
export const linkedWith = (clip: FilmClip, clips: readonly FilmClip[]): FilmClip[] =>
  clip.link === null
    ? []
    : clips.filter((other) => other.id !== clip.id && other.link === clip.link)

/** `ids` 这些片段联动着的、不在 `ids` 里的片段（删除、改速度时一起改）。 */
export const linkedPartners = (ids: Iterable<string>, clips: readonly FilmClip[]): string[] => {
  const own = new Set(ids)
  const partners = clips
    .filter((clip) => own.has(clip.id))
    .flatMap((clip) => linkedWith(clip, clips))
    .map((clip) => clip.id)
  return [...new Set(partners)].filter((id) => !own.has(id))
}

// 两端算对齐的误差：和引擎带着链接的片段改时长时一样，1 毫秒以内
const ALIGNED_MS = 1

/**
 * 一起动的片段（`group`）加上联动的伙伴：挪动（`move`）时伙伴都跟着；裁一端时只有这一端原来和
 * 组里联动的片段对齐的伙伴跟着，这样裁完口型不乱（裁开头时入点由 `groupTrimmed` 一起算）。
 */
export const linkedGroup = (
  group: ReadonlySet<string>,
  clips: readonly FilmClip[],
  kind: 'move' | Edge,
): ReadonlySet<string> => {
  const joined = new Set(group)
  for (const member of clips.filter((clip) => group.has(clip.id)))
    for (const partner of linkedWith(member, clips))
      if (kind === 'move' || Math.abs(edgeOf(partner, kind) - edgeOf(member, kind)) < ALIGNED_MS)
        joined.add(partner.id)
  return joined
}

/**
 * 在时间线上拖 `clip` 挪动（`move`）或裁 `edge` 这一端时一起动的片段，含它自己和跟着动的联动伙伴（见
 * `linkedGroup`）：它在不止一个片段的选中（`selected`）里时是整个选中，不然只有它。裁剪只裁同类的：
 * 拖的是字幕时只有选中的字幕一起裁，拖的是别的片段时选中的字幕不跟着裁。
 */
export const editGroup = (
  clip: FilmClip,
  selected: ReadonlySet<string>,
  clips: readonly FilmClip[],
  kind: 'move' | Edge,
): ReadonlySet<string> => {
  const group = movingWith(selected, clip.id)
  const isCaption = (each: FilmClip) => each.kind === 'caption'
  const own =
    kind === 'move'
      ? group
      : new Set(
          clips
            .filter((other) => group.has(other.id) && isCaption(other) === isCaption(clip))
            .map((other) => other.id),
        )
  return linkedGroup(own, clips, kind)
}

/**
 * 几个片段各自挪到新起点（合拢空档、波纹删除补位）时，联动的伙伴挪同样的时间差；伙伴自己也在
 * `starts` 里时按它自己的。挪到 0 秒之前的收在 0。
 */
export const withLinkedStarts = (
  starts: ReadonlyMap<string, number>,
  clips: readonly FilmClip[],
): Map<string, number> => {
  const result = new Map(starts)
  for (const clip of clips) {
    const start = starts.get(clip.id)
    if (start === undefined) continue
    for (const partner of linkedWith(clip, clips))
      if (!result.has(partner.id))
        result.set(partner.id, Math.max(0, partner.start + start - clip.start))
  }
  return result
}

const sameMediaTiming = (left: MediaClip, right: MediaClip) =>
  left.start === right.start &&
  left.duration === right.duration &&
  left.mediaStart === right.mediaStart &&
  left.playbackRate === right.playbackRate

/**
 * 在「原片截取」上改完 `clip` 以后要写的时间（`next` 由 `slipped` 算好）：
 * - 只拖了出点：就是裁结尾，联动的伙伴照时间线上一起裁的规则跟着；
 * - 改了入点、换了一截素材：联动的伙伴里开始、时长、入点、速度都和它一样的做同样的改动（口型不乱），
 *   别的伙伴不动。改入点让结尾往后延时，不压到任何一段那一行后面的片段。
 */
export const sourceTrimmed = (
  clip: MediaClip,
  next: Timing,
  clips: readonly FilmClip[],
  sourceMs: SourceLength,
): Map<string, Timing> => {
  if (next.start === clip.start && next.mediaStart === clip.mediaStart) {
    const group = linkedGroup(new Set([clip.id]), clips, 'end')
    return groupTrimmed(
      clips.filter((other) => group.has(other.id)),
      'end',
      next.duration - clip.duration,
      clips,
      sourceMs,
    )
  }
  const twins = linkedWith(clip, clips).filter(
    (other): other is MediaClip => isMediaClip(other) && sameMediaTiming(other, clip),
  )
  if (twins.length === 0) return new Map([[clip.id, next]])
  // 出点不动、入点往前时片段变长：素材剩下的长度由 `slipped` 卡过，这里只看各自那一行后面的片段
  const latestEnd = Math.min(
    ...[clip, ...twins].map((member) => trimBounds(member, 'end', clips, Infinity).max),
  )
  const outPoint = clip.mediaStart + clip.duration * clip.playbackRate
  const timing =
    next.start + next.duration <= latestEnd
      ? next
      : {
          start: next.start,
          duration: latestEnd - next.start,
          mediaStart: Math.round(outPoint - (latestEnd - next.start) * clip.playbackRate),
        }
  return new Map([clip, ...twins].map((member) => [member.id, timing]))
}

/** 挪动的结果：一起挪的片段共用的时间差（毫秒），被抓的片段最后在它那个区的哪一行（null 是新开的一行）。 */
export type GroupShift = { delta: number; track: number | null }

/**
 * 挪动（一个片段也是一组）：`group` 里的片段（含被抓的 `grabbed`）挪同一个时间差，取离 `wantedDelta` 最近的，
 * 一样近取靠后的。被抓的片段去它那个区的 `track` 这一行（null 是新开的一行，上面没有别的片段），
 * 别的片段留在各自的行。整组不早于 0；每个片段都不和它那一行上没在挪的片段重叠，同组的片段互不挡路。
 * `track` 上有和被抓的片段时间重叠的同组片段（挪同一个时间差也分不开），或者在那里找不到时间差时，
 * 被抓的片段留在自己那一行重新找。
 */
export const groupShift = (
  grabbed: FilmClip,
  group: ReadonlySet<string>,
  clips: readonly FilmClip[],
  wantedDelta: number,
  track: number | null,
): GroupShift => {
  const members = clips.filter((clip) => group.has(clip.id))
  const zone = zoneOf(grabbed)
  // 按被抓的片段的起点算：整组能挪到的最早的位置
  const lowest = grabbed.start - Math.min(...members.map((member) => member.start))
  const wanted = Math.max(lowest, grabbed.start + wantedDelta)
  const shiftOn = (row: number | null): number => {
    // 某个片段压到它那一行上一个没在挪的片段时，被抓的片段的起点有一段不能去；
    // 把这些段当成一行上的片段，被抓的片段当成长度为 0 的片段，找离想要的位置最近的空处
    const busy = members.flatMap((member) => {
      const on: RowKey | null =
        member.id === grabbed.id ? (row === null ? null : { zone, track: row }) : rowKeyOf(member)
      const offset = member.start - grabbed.start
      return clips
        .filter((other) => on !== null && onRow(other, on) && !group.has(other.id))
        .map((other) => ({
          id: `${member.id}:${other.id}`,
          start: (other.start - offset - member.duration) / 1000,
          duration: (other.duration + member.duration) / 1000,
          track: 0,
        }))
    })
    const start = resolveNearestFreeStart(busy, 0, wanted / 1000, 0, null, lowest / 1000)
    return Math.round(start * 1000) - grabbed.start
  }
  const overlapsGrabbed = (member: FilmClip) =>
    member.start < endOf(grabbed) && grabbed.start < endOf(member)
  const blocked =
    track !== null &&
    track !== grabbed.track &&
    members.some(
      (member) =>
        member.id !== grabbed.id && onRow(member, { zone, track }) && overlapsGrabbed(member),
    )
  return blocked
    ? { delta: shiftOn(grabbed.track), track: grabbed.track }
    : { delta: shiftOn(track), track }
}

/** 合拢空档之后要挪的片段各自的新起点（毫秒）；没有可合拢的是空表。 */
export type GapClosing = {
  /** 只合拢指针所在的这一个空档：它后面这一行的片段都往前挪这个空档的宽度。 */
  one: ReadonlyMap<string, number>
  /** 合拢这一行所有的空档：片段从 0 起一个接一个。 */
  all: ReadonlyMap<string, number>
}

const NO_CLOSING: GapClosing = { one: new Map(), all: new Map() }

/**
 * 在 `row` 这一行的 `timeMs` 处点右键时，两种合拢各自要挪哪些片段。字幕那一行不合拢：合拢会把字幕从说话的
 * 时间上挪开。
 */
export const gapClosing = (clips: readonly FilmClip[], row: RowKey, timeMs: number): GapClosing => {
  if (row.zone === 'caption') return NO_CLOSING
  const members = clips
    .filter((clip) => onRow(clip, row))
    .map((clip) => ({
      id: clip.id,
      start: clip.start / 1000,
      duration: clip.duration / 1000,
      track: row.track,
    }))
  const starts = (shifts: readonly { key: string; newStart: number }[]) =>
    new Map(shifts.map((shift) => [shift.key, Math.round(shift.newStart * 1000)]))
  const gap = resolveTrackGapAt(members, timeMs / 1000)
  return {
    one: starts(gap === null ? [] : resolveCloseGapShifts(members, gap)),
    all: starts(resolveAllTrackGaps(members)),
  }
}

/**
 * 切点离片段两端至少这么远（毫秒）。参照的工作台只留 0.03 秒，这里不照它：切出比最短片段还短的半段，
 * 之后裁开头时能到的范围上下颠倒（`trimBounds`），所以取两者里大的那个，实际是 `MIN_CLIP_MS`。
 */
export const SPLIT_MARGIN_MS = Math.max(MIN_CLIP_MS, Math.round(SPLIT_BOUNDARY_EPSILON_S * 1000))

/** 片段的链接名（`data-link`）：同名的片段一起切。没有链接的片段不在表里。 */
export type Links = ReadonlyMap<string, string>

/** 一个片段切开后两半的起止和入点：前半段还是原来那个片段（`id`），后半段是它的整份复制。 */
export type Cut = { id: string; first: Timing; second: Timing }

/** 切不了的原因：没选中、选中了多个、这种片段不能切、切点不在片段里、离两端太近、链接的片段切不了。 */
export type SplitRefusal = 'none' | 'many' | 'kind' | 'outside' | 'edge' | 'partner'

export const SPLIT_REFUSAL_TEXT: Readonly<Record<SplitRefusal, string>> = {
  none: '尚未选中片段，无法切开；请先选中一个片段',
  many: '选中了多个片段，无法切开；请只选中一个片段',
  kind: '只有视频、音频、贴片和场景片段可以切开',
  outside: '播放头不在片段里，无法切开；请把播放头移到片段里面',
  edge: `播放头离片段两端不足 ${SPLIT_MARGIN_MS / 1000} 秒，无法切开；请把播放头移到片段里面`,
  partner: '与它链接的片段无法在同一处切开',
}

/** 切开的打算：能切时是要切的片段（含链接的片段），切不了时是原因。 */
export type SplitPlan = { cuts: readonly Cut[] } | { refusal: SplitRefusal }

/** `atMs` 在不在片段里、离两端够不够远；够时是 undefined。 */
const placeRefusal = (clip: FilmClip, atMs: number): SplitRefusal | undefined => {
  if (atMs <= clip.start || atMs >= endOf(clip)) return 'outside'
  return atMs < clip.start + SPLIT_MARGIN_MS || atMs > endOf(clip) - SPLIT_MARGIN_MS
    ? 'edge'
    : undefined
}

const cutOf = (clip: FilmClip, atMs: number): Cut => {
  const timing = timingOf(clip)
  const head = atMs - clip.start
  return {
    id: clip.id,
    first: { ...timing, duration: head },
    second: {
      start: atMs,
      duration: endOf(clip) - atMs,
      mediaStart: Math.round(timing.mediaStart + head * rateOf(clip)),
    },
  }
}

/**
 * 在 final-cut 的 `atMs`（取整到毫秒）处切开 `clip`：「其他」片段和字幕不切，切点离两端各至少 `SPLIT_MARGIN_MS`。
 * 它带着链接时，同名的片段在同一处一起切，其中有一个切不了就都不切。
 */
export const splitAt = (
  clip: FilmClip,
  atMs: number,
  clips: readonly FilmClip[],
  links: Links,
): SplitPlan => {
  const at = Math.round(atMs)
  if (clip.kind === 'other' || clip.kind === 'caption') return { refusal: 'kind' }
  const own = placeRefusal(clip, at)
  if (own !== undefined) return { refusal: own }
  const link = links.get(clip.id)
  const partners =
    link === undefined
      ? []
      : clips.filter((other) => other.id !== clip.id && links.get(other.id) === link)
  if (
    partners.some((partner) => partner.kind === 'other' || placeRefusal(partner, at) !== undefined)
  )
    return { refusal: 'partner' }
  return { cuts: [clip, ...partners].map((each) => cutOf(each, at)) }
}

/** 在播放头处切开 `targets`（选中的片段，或点右键的那一个）：只能是一个片段。 */
export const playheadSplit = (
  targets: readonly FilmClip[],
  playheadMs: number,
  clips: readonly FilmClip[],
  links: Links,
): SplitPlan => {
  const [target] = targets
  if (target === undefined) return { refusal: 'none' }
  if (targets.length > 1) return { refusal: 'many' }
  return splitAt(target, playheadMs, clips, links)
}

/** 剃刀点在 `clip` 的 `atMs` 处：太靠边时夹进离两端 `SPLIT_MARGIN_MS` 以内；切不了时什么都不切。 */
export const razorSplit = (
  clip: FilmClip,
  atMs: number,
  clips: readonly FilmClip[],
  links: Links,
): readonly Cut[] => {
  const at = Math.min(
    endOf(clip) - SPLIT_MARGIN_MS,
    Math.max(clip.start + SPLIT_MARGIN_MS, Math.round(atMs)),
  )
  const plan = splitAt(clip, at, clips, links)
  return 'cuts' in plan ? plan.cuts : []
}

/** 按着 Shift 用剃刀点：在 `atMs` 处把所有能切的片段一起切开（不夹，切不了的跳过）。 */
export const splitAllAt = (
  atMs: number,
  clips: readonly FilmClip[],
  links: Links,
): readonly Cut[] => {
  const cuts = new Map<string, Cut>()
  for (const clip of clips) {
    if (cuts.has(clip.id)) continue
    const plan = splitAt(clip, atMs, clips, links)
    if ('cuts' in plan) for (const cut of plan.cuts) cuts.set(cut.id, cut)
  }
  return [...cuts.values()]
}

/**
 * 开着波纹编辑时删掉 `removed` 这些片段之后，主轨（画面区最上面那一行）里剩下的片段各自往前挪到哪里：
 * 每个片段挪的是它前面被删掉的主轨上的片段的总长。别的行不动。
 */
export const rippleStarts = (
  clips: readonly FilmClip[],
  removed: ReadonlySet<string>,
): Map<string, number> => {
  const main = clips.filter((clip) => onRow(clip, { zone: 'visual', track: topTrack(clips) }))
  const gone = main.filter((clip) => removed.has(clip.id))
  const starts = new Map<string, number>()
  for (const clip of main) {
    if (removed.has(clip.id)) continue
    const shift = gone
      .filter((deleted) => deleted.start < clip.start)
      .reduce((sum, deleted) => sum + deleted.duration, 0)
    if (shift > 0) starts.set(clip.id, clip.start - shift)
  }
  return starts
}

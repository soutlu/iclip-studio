import { versionNameOf, type ConversationVideoGroup } from '../conversation-videos/video-groups'
import type { SecondsRange } from '../editing/clip'
import { versionLabel } from '../editing/version-lineage'
import type { Edge } from '../editing/timeline-drag'
import { MIN_CLIP_MS, type VideoClip } from './composition/film'

/** 选区加入轨道时拆成的一个片段：从素材的哪里开始放、放多长（毫秒）。一个镜头一个。 */
export type MaterialPiece = { mediaStart: number; duration: number }

export type Material = {
  jobId: string
  url: string
  durationMs: number | null
  groupId: string
  groupLabel: string
  takeId: string
  /** 原作在组里的字母：A、B… */
  takeLetter: string
  takeLabel: string
  /** 版本的完整名字，如「V1 原片」。 */
  version: string
  /** 只有版本号那一截：V1、V2… */
  versionNumber: string
}

export type MaterialTake = {
  id: string
  label: string
  versions: readonly Material[]
  latest: Material
}

export type MaterialGroup = {
  id: string
  label: string
  takes: readonly MaterialTake[]
}

/** 素材里的一段（毫秒）：一个镜头，或选区里的一段。 */
export type MediaSpan = { startMs: number; endMs: number }

/** 选区里的一段。`id` 只用来在界面上认出它：平移、裁剪时起止在变，并段时留下靠前那段的。 */
export type PickSpan = MediaSpan & { id: string }

/** 一条原作上选中的几段：选在哪个版本上；各段按时间排、互不重叠，相邻两段之间至少空出 `PICK_GAP_MS`。 */
export type TakePicks = { jobId: string; spans: readonly PickSpan[] }

/** 「镜头」页签里的选区：可以同时选在几条原作上，按原作 id 分。 */
export type MaterialPicks = ReadonlyMap<string, TakePicks>

export const NO_PICKS: MaterialPicks = new Map()

/** 两段之间空出不到一个最短片段时并成一段：那么短的空档放不出片段，分开也没有用。 */
const PICK_GAP_MS = MIN_CLIP_MS

/** 换掉 `takeId` 这条原作上的选区；一段都不剩时这条原作不再记着。 */
export const withTakePicks = (
  picks: MaterialPicks,
  takeId: string,
  next: TakePicks,
): MaterialPicks => {
  const updated = new Map(picks)
  if (next.spans.length === 0) updated.delete(takeId)
  else updated.set(takeId, next)
  return updated
}

/** 把 `added` 并进选区：和已有的段重叠、或空档不到 `PICK_GAP_MS` 的连成一段。 */
export const addSpan = <T extends MediaSpan>(spans: readonly T[], added: T): T[] => {
  const merged: T[] = []
  for (const span of [...spans, added].toSorted((left, right) => left.startMs - right.startMs)) {
    const last = merged.at(-1)
    if (last !== undefined && span.startMs < last.endMs + PICK_GAP_MS)
      merged[merged.length - 1] = { ...last, endMs: Math.max(last.endMs, span.endMs) }
    else merged.push(span)
  }
  return merged
}

/** Shift 点一个镜头：从这条原作上最靠后的一段连到这个镜头（照稿子），没有选区时只选它。 */
export const extendToShot = <T extends MediaSpan>(spans: readonly T[], shot: T): T[] => {
  const last = spans.at(-1)
  return addSpan(
    spans,
    last === undefined
      ? shot
      : {
          ...last,
          startMs: Math.min(last.startMs, shot.startMs),
          endMs: Math.max(last.endMs, shot.endMs),
        },
  )
}

/** 盖着 `ms` 这一刻的那一段是第几段；没有时是 undefined。 */
export const spanIndexAt = (spans: readonly MediaSpan[], ms: number): number | undefined => {
  const index = spans.findIndex((span) => span.startMs <= ms && ms < span.endMs)
  return index < 0 ? undefined : index
}

export const removeSpan = <T extends MediaSpan>(spans: readonly T[], index: number): T[] =>
  spans.filter((_, at) => at !== index)

/** 第 `index` 段能伸到哪里：不出素材的头尾，和相邻的段之间留着 `PICK_GAP_MS`。 */
const roomOf = (spans: readonly MediaSpan[], index: number, durationMs: number) => {
  const before = spans[index - 1]
  const after = spans[index + 1]
  return {
    min: before === undefined ? 0 : before.endMs + PICK_GAP_MS,
    max: after === undefined ? durationMs : after.startMs - PICK_GAP_MS,
  }
}

/** 第 `index` 段的 `edge` 这一端能挪到哪里：可以越过镜头切口，不压到相邻的段，两端之间至少留一个最短片段。 */
export const edgeLimits = (
  spans: readonly MediaSpan[],
  index: number,
  edge: Edge,
  durationMs: number,
): { min: number; max: number } => {
  const span = spans[index]
  const room = roomOf(spans, index, durationMs)
  if (span === undefined) return room
  return edge === 'start'
    ? { min: room.min, max: span.endMs - MIN_CLIP_MS }
    : { min: span.startMs + MIN_CLIP_MS, max: room.max }
}

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, value))

/** 把第 `index` 段的 `edge` 这一端挪 `deltaMs`，挪不过去时停在能到的地方。 */
export const trimSpan = <T extends MediaSpan>(
  spans: readonly T[],
  index: number,
  edge: Edge,
  deltaMs: number,
  durationMs: number,
): readonly T[] => {
  const span = spans[index]
  if (span === undefined) return spans
  const limits = edgeLimits(spans, index, edge, durationMs)
  return spans.with(
    index,
    edge === 'start'
      ? { ...span, startMs: clamp(span.startMs + deltaMs, limits) }
      : { ...span, endMs: clamp(span.endMs + deltaMs, limits) },
  )
}

/** 把第 `index` 段整段平移 `deltaMs`，长短不变；碰到相邻的段或素材的头尾就停下。 */
export const slideSpan = <T extends MediaSpan>(
  spans: readonly T[],
  index: number,
  deltaMs: number,
  durationMs: number,
): readonly T[] => {
  const span = spans[index]
  if (span === undefined) return spans
  const length = span.endMs - span.startMs
  const room = roomOf(spans, index, durationMs)
  const startMs = clamp(span.startMs + deltaMs, { min: room.min, max: room.max - length })
  return spans.with(index, { ...span, startMs, endMs: startMs + length })
}

/**
 * 加入轨道时一段拆成的片段：在段里的镜头切口处切开，一个镜头一个片段。
 * 离一端或上一个切口不到一个最短片段的切口不切，那一小截并进旁边的片段。
 */
export const spanPieces = (span: MediaSpan, shots: readonly MediaSpan[]): MaterialPiece[] => {
  const edges = [span.startMs]
  for (const { startMs: cut } of shots) {
    const last = edges.at(-1) ?? span.startMs
    if (cut - last >= MIN_CLIP_MS && span.endMs - cut >= MIN_CLIP_MS) edges.push(cut)
  }
  edges.push(span.endMs)
  return edges.slice(1).map((end, at) => {
    const start = edges[at] ?? span.startMs
    return { mediaStart: start, duration: end - start }
  })
}

export type PickedSpan = { material: Material; span: MediaSpan }

/** 选区里的各段，按加入轨道的先后排：原作按在「镜头」页签里的顺序，同一条原作里按时间。 */
export const orderedPicks = (
  groups: readonly MaterialGroup[],
  picks: MaterialPicks,
): PickedSpan[] =>
  groups.flatMap((group) =>
    group.takes.flatMap((take) => {
      const picked = picks.get(take.id)
      const material = take.versions.find((item) => item.jobId === picked?.jobId)
      return picked === undefined || material === undefined
        ? []
        : picked.spans.map((span) => ({ material, span }))
    }),
  )

/** 选区一共几段、多长（毫秒）。 */
export const picksSummary = (picks: MaterialPicks): { count: number; durationMs: number } => {
  const spans = [...picks.values()].flatMap((picked) => picked.spans)
  return {
    count: spans.length,
    durationMs: spans.reduce((total, span) => total + span.endMs - span.startMs, 0),
  }
}

export type UsedSpan = { clipId: string; startMs: number; endMs: number }

/** 视频片段用掉的素材段，按素材地址分：素材区按版本的地址对上这段对话的素材。 */
export const usedSpans = (
  videos: readonly VideoClip[],
): ReadonlyMap<string, readonly UsedSpan[]> => {
  const used = new Map<string, UsedSpan[]>()
  for (const clip of videos) {
    const span = {
      clipId: clip.id,
      startMs: clip.mediaStart,
      endMs: clip.mediaStart + clip.duration * clip.playbackRate,
    }
    used.set(clip.src, [...(used.get(clip.src) ?? []), span])
  }
  return used
}

/** 一条原作算不算已入轨：只要有一个版本被时间线上的视频片段用着。`used` 见 `usedSpans`。 */
export const takeInTrack = (
  take: MaterialTake,
  used: ReadonlyMap<string, readonly UsedSpan[]>,
): boolean => take.versions.some((item) => used.has(item.url))

/** 「镜头」页签按入轨筛选：全部、未入轨、已入轨。 */
export type TakeFilter = 'all' | 'unused' | 'used'

/** 按 `filter` 筛出各组的原作；一条都不剩的组不要。 */
export const filterTakes = (
  groups: readonly MaterialGroup[],
  filter: TakeFilter,
  used: ReadonlyMap<string, readonly UsedSpan[]>,
): MaterialGroup[] =>
  groups.flatMap((group) => {
    const takes =
      filter === 'all'
        ? group.takes
        : group.takes.filter((take) => takeInTrack(take, used) === (filter === 'used'))
    return takes.length === 0 ? [] : [{ ...group, takes }]
  })

export const shotAt = (shots: readonly SecondsRange[], seconds: number): number | undefined => {
  const index = shots.findIndex((shot) => seconds >= shot.start - 0.001 && seconds < shot.end)
  return index < 0 ? undefined : index + 1
}

export type MaterialCatalog = {
  groups: readonly MaterialGroup[]
  byJob: ReadonlyMap<string, Material>
}

const takeLetter = (index: number): string => {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  return result
}

export const materialCatalog = (groups: readonly ConversationVideoGroup[]): MaterialCatalog => {
  const catalog = groups.map((group): MaterialGroup => {
    const byTake = new Map<string, typeof group.videos>()
    for (const video of group.videos) {
      const takeId = video.operation === 'compose' ? (video.rootJobId ?? video.id) : video.id
      const videos = byTake.get(takeId)
      if (videos === undefined) byTake.set(takeId, [video])
      else videos.push(video)
    }
    const takes = [...byTake].flatMap(([takeId, videos], index): MaterialTake[] => {
      const letter = takeLetter(index)
      const takeLabel = `出片 ${letter}`
      // 版本号按出片各自排（组里按完成时间排好，原片在前）：V1 是原片，合成接着 V2、V3…；
      // 和版本组按整个镜头组编的号不是一回事
      const versions = videos.map((video, index) => ({
        jobId: video.id,
        url: video.outputUrl,
        durationMs: video.durationMs,
        groupId: group.id,
        groupLabel: group.label,
        takeId,
        takeLetter: letter,
        takeLabel,
        version: versionNameOf(video, index + 1),
        versionNumber: versionLabel(index + 1),
      }))
      const latest = versions.at(-1)
      return latest === undefined ? [] : [{ id: takeId, label: takeLabel, versions, latest }]
    })
    return { id: group.id, label: group.label, takes }
  })
  return {
    groups: catalog,
    byJob: new Map(
      catalog.flatMap((group) =>
        group.takes.flatMap((take) => take.versions.map((item) => [item.jobId, item] as const)),
      ),
    ),
  }
}

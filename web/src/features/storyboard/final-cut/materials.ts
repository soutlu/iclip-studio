import { versionNameOf, type ConversationVideoGroup } from '../conversation-videos/video-groups'
import type { SecondsRange } from '../editing/clip'
import { versionLabel } from '../editing/version-lineage'
import type { Edge } from '../editing/timeline-drag'
import { MIN_CLIP_MS, type VideoClip } from './composition/film'

/** 选区加入轨道时拆分出的单个视频片段参数：素材入点与时长（毫秒），对应单个镜头。 */
export type MaterialPiece = { mediaStart: number; duration: number }

export type Material = {
  jobId: string
  url: string
  durationMs: number | null
  groupId: string
  groupLabel: string
  takeId: string
  /** 原作在镜头组内的字母序号：A、B… */
  takeLetter: string
  takeLabel: string
  /** 版本完整名称，如「V1 原片」。 */
  version: string
  /** 仅含版本号前缀的短标签：V1、V2… */
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

/** 素材时间区间（毫秒）：可表示单个镜头或选区中的一段。 */
export type MediaSpan = { startMs: number; endMs: number }

/** 选区中的单段区间。`id` 仅作界面稳定键（平移、裁剪时起止变更，合并时保留靠前段的 `id`）。 */
export type PickSpan = MediaSpan & { id: string }

/** 单条原作下的选区集合：绑定至特定版本；各段按时间升序且互不重叠，相邻段间距不小于 `PICK_GAP_MS`。 */
export type TakePicks = { jobId: string; spans: readonly PickSpan[] }

/** 「镜头」页签的跨原作选区映射（按原作 ID 索引）。 */
export type MaterialPicks = ReadonlyMap<string, TakePicks>

export const NO_PICKS: MaterialPicks = new Map()

/** 相邻选区间隔不足最短片段时长时自动合并，避免产生无法独立入轨的无效空档。 */
const PICK_GAP_MS = MIN_CLIP_MS

/** 更新指定原作 `takeId` 的选区；区间清空时移除该原作条目。 */
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

/** 将 `added` 合入现有选区：与已有区间重叠或间距小于 `PICK_GAP_MS` 时合并。 */
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

/** Shift 点击镜头扩展选区：从当前原作最后一段连选至目标镜头；尚无选区时直接选中该镜头。 */
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

/** 查找包含时刻 `ms` 的选区下标；未命中时返回 `undefined`。 */
export const spanIndexAt = (spans: readonly MediaSpan[], ms: number): number | undefined => {
  const index = spans.findIndex((span) => span.startMs <= ms && ms < span.endMs)
  return index < 0 ? undefined : index
}

export const removeSpan = <T extends MediaSpan>(spans: readonly T[], index: number): T[] =>
  spans.filter((_, at) => at !== index)

/** 计算第 `index` 段允许延伸的时间边界：受素材起止与相邻选区间隔 `PICK_GAP_MS` 约束。 */
const roomOf = (spans: readonly MediaSpan[], index: number, durationMs: number) => {
  const before = spans[index - 1]
  const after = spans[index + 1]
  return {
    min: before === undefined ? 0 : before.endMs + PICK_GAP_MS,
    max: after === undefined ? durationMs : after.startMs - PICK_GAP_MS,
  }
}

/** 计算第 `index` 段 `edge` 端可拖动的边界：允许跨越镜头切点，不侵占相邻选区且保留最短片段时长。 */
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

/** 将第 `index` 段的 `edge` 端调整 `deltaMs`，超出边界时钳制至极限值。 */
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

/** 将第 `index` 段整体平移 `deltaMs`（保持时长不变），碰触相邻选区或素材边界时停止。 */
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
 * 将选区按内部镜头切点拆分为待入轨片段（每个镜头对应一个片段）。
 * 距首尾或前一有效切点不足最短片段时长的切点跳过拆分，并入相邻片段。
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

/** 按入轨顺序展平全部选区：原作遵循「镜头」页签排列顺序，同一原作内按时间升序。 */
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

/** 汇总当前选区的总段数与总时长（毫秒）。 */
export const picksSummary = (picks: MaterialPicks): { count: number; durationMs: number } => {
  const spans = [...picks.values()].flatMap((picked) => picked.spans)
  return {
    count: spans.length,
    durationMs: spans.reduce((total, span) => total + span.endMs - span.startMs, 0),
  }
}

export type UsedSpan = { clipId: string; startMs: number; endMs: number }

/** 统计时间线视频片段已使用的素材区间（按素材 URL 索引），供素材区按版本地址匹配入轨状态。 */
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

/** 判断原作是否已入轨：任一版本被时间线视频片段引用即视为已入轨（`used` 见 `usedSpans`）。 */
export const takeInTrack = (
  take: MaterialTake,
  used: ReadonlyMap<string, readonly UsedSpan[]>,
): boolean => take.versions.some((item) => used.has(item.url))

/** 「镜头」页签入轨状态筛选条件：全部、未入轨、已入轨。 */
export type TakeFilter = 'all' | 'unused' | 'used'

/** 按入轨筛选条件过滤各镜头组原作，剔除过滤后为空的分组。 */
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
      // 版本号按原作独立编号（组内已按完成时间排序，原片居首）：V1 为原片，后续合成依次为 V2、V3…，
      // 与版本历史中按整个镜头组统一编号相互独立
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

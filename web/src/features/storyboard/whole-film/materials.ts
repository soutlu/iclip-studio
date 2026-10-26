import type { ConversationVideoGroup } from '../conversation-videos/video-groups'
import type { SecondsRange } from '../editing/clip'
import type { Edge } from '../editing/timeline-drag'
import { shiftSelect } from '../editing/range-select'
import { labelLineage } from '../editing/version-lineage'
import { MIN_CLIP_MS, type Layer0Clip } from './editing/draft'
import type { MaterialPiece } from './editing/layer0'

/** 视频素材区里的一版素材片：出自哪个镜头组、哪条原作，叫什么版本。 */
export type Material = {
  jobId: string
  url: string
  /** 记录上的时长（毫秒）；没记的要从文件读 */
  durationMs: number | null
  groupId: string
  groupLabel: string
  takeId: string
  /** 「生成 A」「生成 B」……按原作在组里的先后 */
  takeLabel: string
  /** 「原片」「V1」…… */
  version: string
}

export type MaterialTake = {
  id: string
  label: string
  versions: readonly Material[]
  /** 最新完成的一版，素材区默认显示它 */
  latest: Material
}

export type MaterialGroup = {
  id: string
  label: string
  takes: readonly MaterialTake[]
}

/** 素材里的一个镜头：关键帧切出的起止（素材时间，毫秒） */
export type ShotSpan = { startMs: number; endMs: number }

/**
 * 素材区里选中的一段：哪一版素材片里连着的哪几个镜头（shots，镜头原本的起止，按先后、至少一个），
 * 以及两端修剪后的范围 startMs–endMs（素材时间，毫秒）。镜头之间的边界就是加入成片时拆段的地方。
 */
export type MaterialRange = {
  jobId: string
  takeId: string
  startMs: number
  endMs: number
  shots: readonly ShotSpan[]
}

/** 只选一个镜头 */
export const shotRange = (jobId: string, takeId: string, shot: ShotSpan): MaterialRange => ({
  jobId,
  takeId,
  startMs: shot.startMs,
  endMs: shot.endMs,
  shots: [shot],
})

/** 选区里镜头之间的边界（素材时间），按先后；只有一个镜头时为空 */
const cutsOf = (range: MaterialRange): number[] => range.shots.slice(1).map((shot) => shot.startMs)

/**
 * 选区一端能挪到的范围（毫秒）：往外不出素材的头尾；往里不越过最近的镜头边界（只有一个镜头时是
 * 另一端），并至少留 MIN_CLIP_MS
 */
export const trimLimits = (
  range: MaterialRange,
  edge: Edge,
  durationMs: number,
): { min: number; max: number } => {
  const cuts = cutsOf(range)
  return edge === 'start'
    ? { min: 0, max: (cuts[0] ?? range.endMs) - MIN_CLIP_MS }
    : { min: (cuts.at(-1) ?? range.startMs) + MIN_CLIP_MS, max: durationMs }
}

/** 把选区的一端挪 deltaMs，收进 {@link trimLimits} */
export const trimRange = (
  range: MaterialRange,
  edge: Edge,
  deltaMs: number,
  durationMs: number,
): MaterialRange => {
  const { min, max } = trimLimits(range, edge, durationMs)
  const key = edge === 'start' ? 'startMs' : 'endMs'
  return { ...range, [key]: Math.min(max, Math.max(min, range[key] + deltaMs)) }
}

/** 加入成片时拆成的段：每个镜头一段，第一段、最后一段带上两端的修剪 */
export const rangePieces = (range: MaterialRange): MaterialPiece[] =>
  range.shots.map((shot, at) => {
    const start = at === 0 ? range.startMs : shot.startMs
    const end = at === range.shots.length - 1 ? range.endMs : shot.endMs
    return { playbackStart: start, duration: end - start }
  })

/**
 * Shift 点镜头 clicked（同一版素材里全部镜头是 shots，按先后），规则见 {@link shiftSelect}；别的
 * 素材、别的版本里的镜头只选它，全部去掉时为 null。没变的一端保留修剪，换了镜头的一端取镜头原本的
 * 起止；保留的修剪越过了新的镜头边界时收回到边界以内。
 */
export const shiftShot = (
  range: MaterialRange | null,
  clicked: MaterialRange,
  shots: readonly ShotSpan[],
): MaterialRange | null => {
  if (range === null || range.jobId !== clicked.jobId) return clicked
  const keys = shots.map((shot) => shot.startMs)
  const picked = shiftSelect(
    keys,
    range.shots.map((shot) => shot.startMs),
    clicked.startMs,
  ).flatMap((key) => shots.filter((shot) => shot.startMs === key))
  const first = picked[0]
  const last = picked.at(-1)
  if (first === undefined || last === undefined) return null
  const next = { ...range, shots: picked }
  const cuts = cutsOf(next)
  return {
    ...next,
    startMs: Math.min(
      first.startMs === range.shots[0]?.startMs ? range.startMs : first.startMs,
      (cuts[0] ?? Infinity) - MIN_CLIP_MS,
    ),
    endMs: Math.max(
      last.endMs === range.shots.at(-1)?.endMs ? range.endMs : last.endMs,
      (cuts.at(-1) ?? -Infinity) + MIN_CLIP_MS,
    ),
  }
}

/** 画面轨上的一段视频用了素材里的哪一段（毫秒） */
export type UsedSpan = { clipId: string; startMs: number; endMs: number }

/** 画面轨上每版素材片已经用了哪些段，按画面轨上的先后，以 jobId 分 */
export const usedSpans = (
  layer0: readonly Layer0Clip[],
): ReadonlyMap<string, readonly UsedSpan[]> => {
  const used = new Map<string, UsedSpan[]>()
  for (const clip of layer0) {
    if (clip.type !== 'video') continue
    const span = {
      clipId: clip.id,
      startMs: clip.playbackStart,
      endMs: clip.playbackStart + clip.duration,
    }
    used.set(clip.sourceJobId, [...(used.get(clip.sourceJobId) ?? []), span])
  }
  return used
}

/** 素材里 seconds 这一刻落在第几个镜头（从 1 数）；不在任何镜头里时 undefined */
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

/** 按镜头组、组里的原作排好这段对话的素材片；一条原作的合成跟着它，按完成先后编版本。 */
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
      const takeLabel = `生成 ${takeLetter(index)}`
      const versions = labelLineage(videos).map(({ job, label }) => ({
        jobId: job.id,
        url: job.outputUrl,
        durationMs: job.durationMs,
        groupId: group.id,
        groupLabel: group.label,
        takeId,
        takeLabel,
        version: label,
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

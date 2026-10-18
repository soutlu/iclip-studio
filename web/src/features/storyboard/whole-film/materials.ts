import type { ConversationVideoGroup } from '../conversation-videos/video-groups'
import type { SecondsRange } from '../editing/clip'
import type { Edge } from '../editing/timeline-drag'
import { labelLineage } from '../editing/version-lineage'
import { MIN_CLIP_MS, type Layer0Clip } from './editing/draft'

/** 视频素材区里的一版成片：出自哪个镜头组、哪条原作，叫什么版本。 */
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

/** 素材区里选中的一段：哪一版成片的哪个范围（素材时间，毫秒） */
export type MaterialRange = { jobId: string; takeId: string; startMs: number; endMs: number }

/** 把选区的一端挪 deltaMs：不出素材的头尾，选区至少留 MIN_CLIP_MS */
export const trimRange = (
  range: MaterialRange,
  edge: Edge,
  deltaMs: number,
  durationMs: number,
): MaterialRange =>
  edge === 'start'
    ? {
        ...range,
        startMs: Math.min(Math.max(0, range.startMs + deltaMs), range.endMs - MIN_CLIP_MS),
      }
    : {
        ...range,
        endMs: Math.max(Math.min(durationMs, range.endMs + deltaMs), range.startMs + MIN_CLIP_MS),
      }

/** 成片轨上的一段视频用了素材里的哪一段（毫秒） */
export type UsedSpan = { clipId: string; startMs: number; endMs: number }

/** 成片轨上每版成片已经用了哪些段，按成片轨上的先后，以 jobId 分 */
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

/** 按镜头组、组里的原作排好这段对话的成片；一条原作的合成跟着它，按完成先后编版本。 */
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

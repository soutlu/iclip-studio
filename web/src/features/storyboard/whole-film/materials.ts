import { versionNameOf, type ConversationVideoGroup } from '../conversation-videos/video-groups'
import type { SecondsRange } from '../editing/clip'
import type { Edge } from '../editing/timeline-drag'
import { shiftSelect } from '../editing/range-select'
import { MIN_BLOCK_MS, type PictureBlock } from './composition/film'

/** 选中范围里的一段：从素材的哪里开始放、放多长（毫秒）。一个镜头一段。 */
export type MaterialPiece = { mediaStart: number; duration: number }

export type Material = {
  jobId: string
  url: string
  durationMs: number | null
  groupId: string
  groupLabel: string
  takeId: string
  takeLabel: string
  version: string
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

export type ShotSpan = { startMs: number; endMs: number }

export type MaterialRange = {
  jobId: string
  takeId: string
  startMs: number
  endMs: number
  shots: readonly ShotSpan[]
}

export const shotRange = (jobId: string, takeId: string, shot: ShotSpan): MaterialRange => ({
  jobId,
  takeId,
  startMs: shot.startMs,
  endMs: shot.endMs,
  shots: [shot],
})

const cutsOf = (range: MaterialRange): number[] => range.shots.slice(1).map((shot) => shot.startMs)

export const trimLimits = (
  range: MaterialRange,
  edge: Edge,
  durationMs: number,
): { min: number; max: number } => {
  const cuts = cutsOf(range)
  return edge === 'start'
    ? { min: 0, max: (cuts[0] ?? range.endMs) - MIN_BLOCK_MS }
    : { min: (cuts.at(-1) ?? range.startMs) + MIN_BLOCK_MS, max: durationMs }
}

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

export const rangePieces = (range: MaterialRange): MaterialPiece[] =>
  range.shots.map((shot, at) => {
    const start = at === 0 ? range.startMs : shot.startMs
    const end = at === range.shots.length - 1 ? range.endMs : shot.endMs
    return { mediaStart: start, duration: end - start }
  })

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
      (cuts[0] ?? Infinity) - MIN_BLOCK_MS,
    ),
    endMs: Math.max(
      last.endMs === range.shots.at(-1)?.endMs ? range.endMs : last.endMs,
      (cuts.at(-1) ?? -Infinity) + MIN_BLOCK_MS,
    ),
  }
}

export type UsedSpan = { clipId: string; startMs: number; endMs: number }

export const usedSpans = (
  pictures: readonly PictureBlock[],
): ReadonlyMap<string, readonly UsedSpan[]> => {
  const used = new Map<string, UsedSpan[]>()
  for (const block of pictures) {
    const span = {
      clipId: block.id,
      startMs: block.mediaStart,
      endMs: block.mediaStart + block.duration * block.playbackRate,
    }
    used.set(block.jobId, [...(used.get(block.jobId) ?? []), span])
  }
  return used
}

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
      const takeLabel = `生成 ${takeLetter(index)}`
      const versions = videos.map((video) => ({
        jobId: video.id,
        url: video.outputUrl,
        durationMs: video.durationMs,
        groupId: group.id,
        groupLabel: group.label,
        takeId,
        takeLabel,
        version: versionNameOf(video),
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

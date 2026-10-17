import type { ConversationVideoGroup } from '../conversation-videos/video-groups'
import { labelLineage } from '../editing/version-lineage'

export type Material = {
  jobId: string
  url: string
  knownDuration: number | undefined
  groupId: string
  groupLabel: string
  takeId: string
  takeLabel: string
  version: string
}

export type MaterialDuration = number | null | undefined

export type MaterialTake = { id: string; label: string; versions: readonly Material[] }
export type MaterialGroup = {
  id: string
  label: string
  takes: readonly MaterialTake[]
  versions: readonly Material[]
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
    const takeVideos = new Map<string, typeof group.videos>()
    for (const video of group.videos) {
      const takeId = video.operation === 'compose' ? (video.rootJobId ?? video.id) : video.id
      const videos = takeVideos.get(takeId)
      if (videos === undefined) takeVideos.set(takeId, [video])
      else videos.push(video)
    }
    const takes = [...takeVideos].map(([takeId, videos], index): MaterialTake => {
      const takeLabel = `生成 ${takeLetter(index)}`
      return {
        id: takeId,
        label: takeLabel,
        versions: labelLineage(videos).map(({ job: video, label }) => ({
          jobId: video.id,
          url: video.outputUrl,
          knownDuration: video.durationMs === null ? undefined : video.durationMs / 1000,
          groupId: group.id,
          groupLabel: group.label,
          takeId,
          takeLabel,
          version: label,
        })),
      }
    })
    return {
      id: group.id,
      label: group.label,
      takes,
      versions: takes.flatMap((take) => take.versions),
    }
  })
  return {
    groups: catalog,
    byJob: new Map(catalog.flatMap((group) => group.versions.map((item) => [item.jobId, item]))),
  }
}

export const materialName = (material: Material): string =>
  `${material.groupLabel} · ${material.takeLabel} · ${material.version}`

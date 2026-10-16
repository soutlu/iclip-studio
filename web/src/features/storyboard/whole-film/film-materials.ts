/** 整片素材按镜头组归类，每次独立生成各占一轨，轨内只切换该原作的原版与编辑版。 */

import type { ConversationVideoGroup } from '../conversation-videos/video-groups'

/** 一条素材：一版完整视频。 */
export type Material = {
  jobId: string
  url: string
  /** 记录上的时长，秒；没记时是 `undefined`，由编辑器去探。 */
  knownDuration: number | undefined
  groupId: string
  /** 镜头组 N，或「视频 N」。 */
  groupLabel: string
  /** 最初独立生成的视频 id；同原作的编辑合成共用一条素材轨。 */
  takeId: string
  /** 组内依生成顺序编号：生成 A、生成 B…… */
  takeLabel: string
  /** 原版，或按完成顺序编号的编辑版。 */
  version: string
}

/** 一版多长，秒：`undefined` 是还没读到，`null` 是读不出来。 */
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
      let edit = 0
      return {
        id: takeId,
        label: takeLabel,
        versions: videos.map((video) => ({
          jobId: video.id,
          url: video.outputUrl,
          knownDuration: video.durationMs === null ? undefined : video.durationMs / 1000,
          groupId: group.id,
          groupLabel: group.label,
          takeId,
          takeLabel,
          version: video.operation === 'compose' ? `编辑版 ${++edit}` : '原版',
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

/** 段卡、字幕卡上的出处：镜头组 2 · 生成 A · 编辑版 1。 */
export const materialName = (material: Material): string =>
  `${material.groupLabel} · ${material.takeLabel} · ${material.version}`

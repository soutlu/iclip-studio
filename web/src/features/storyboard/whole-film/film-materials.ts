/** 整片的素材：这段对话读得到的成片，按版本组分好（见 conversation-videos/video-groups），每一版带上组名与版本号。 */

import type { ConversationVideo, ConversationVideoGroup } from '../conversation-videos/video-groups'

/** 一条素材：一版成片。 */
export type Material = {
  jobId: string
  url: string
  /** 记录上的时长，秒；没记时是 `undefined`，由编辑器去探。 */
  knownDuration: number | undefined
  /** 归属的需求单，手动识别字幕时跟着它。 */
  taskId: string | null
  groupId: string
  /** 镜头组 N，或「视频 N」。 */
  groupLabel: string
  /** V1、V2……按完成时刻编。 */
  version: string
}

/** 一版多长，秒：`undefined` 是还没读到，`null` 是读不出来。 */
export type MaterialDuration = number | null | undefined

export type MaterialGroup = { id: string; label: string; versions: readonly Material[] }

export type MaterialCatalog = {
  groups: readonly MaterialGroup[]
  byJob: ReadonlyMap<string, Material>
}

const materialOf = (group: ConversationVideoGroup, video: ConversationVideo, at: number) => ({
  jobId: video.id,
  url: video.outputUrl,
  knownDuration: video.durationMs === null ? undefined : video.durationMs / 1000,
  taskId: video.taskId,
  groupId: group.id,
  groupLabel: group.label,
  version: `V${at + 1}`,
})

export const materialCatalog = (groups: readonly ConversationVideoGroup[]): MaterialCatalog => {
  const catalog = groups.map((group) => ({
    id: group.id,
    label: group.label,
    versions: group.videos.map((video, at) => materialOf(group, video, at)),
  }))
  return {
    groups: catalog,
    byJob: new Map(catalog.flatMap((group) => group.versions.map((item) => [item.jobId, item]))),
  }
}

/** 段卡、字幕卡上的出处：镜头组 2 · V3。 */
export const materialName = (material: Material): string =>
  `${material.groupLabel} · ${material.version}`

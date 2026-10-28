import { byFinish, isComposite, ORIGINAL_LABEL, versionLabel } from '../editing/version-lineage'
import { isTake } from '../shots'
import type { GenerationJob } from '../storyboard.api'

type FinishedVideo = GenerationJob & { outputUrl: string }

/** 版本组里的一条素材片；`version` 是它在组里的版本号，各页面都用这一个。 */
export type ConversationVideo = FinishedVideo & { version: number }

export type ConversationVideoGroup = {
  id: string
  label: string
  videos: ConversationVideo[]
}

const hasOutput = (job: GenerationJob): job is FinishedVideo =>
  job.status === 'completed' && Boolean(job.outputUrl?.trim())

const isFinishedVideo = (job: GenerationJob): job is FinishedVideo =>
  hasOutput(job) && (isTake(job) || isComposite(job))

const groupKeyOf = (video: FinishedVideo): string => {
  if (video.shotIndex != null) return `shot-${video.shotIndex}`
  return `video-${isTake(video) ? video.id : (video.rootJobId ?? video.id)}`
}

/**
 * 把素材片分成版本组并编版本号（见 CONTEXT「镜头组」）：按镜号分组，没有镜号的出片各自一组、同原作的合成
 * 跟着它；组内出片与合成一起按完成时刻编 V1、V2……。有镜号的组按镜号排在前，其余按出现先后。
 */
export const groupConversationVideos = (
  jobs: readonly GenerationJob[],
): ConversationVideoGroup[] => {
  const shots = new Map<number, ConversationVideoGroup>()
  const standalone = new Map<string, ConversationVideoGroup>()

  for (const video of jobs.filter(isFinishedVideo).sort(byFinish)) {
    const key = groupKeyOf(video)
    const shot = video.shotIndex
    if (shot != null) {
      const group = shots.get(shot)
      if (group === undefined)
        shots.set(shot, { id: key, label: `镜头组 ${shot}`, videos: [{ ...video, version: 1 }] })
      else group.videos.push({ ...video, version: group.videos.length + 1 })
      continue
    }
    const group = standalone.get(key)
    if (group === undefined)
      standalone.set(key, {
        id: key,
        label: `视频 ${standalone.size + 1}`,
        videos: [{ ...video, version: 1 }],
      })
    else group.videos.push({ ...video, version: group.videos.length + 1 })
  }

  return [
    ...[...shots].sort(([left], [right]) => left - right).map(([, group]) => group),
    ...standalone.values(),
  ]
}

/** 素材片的版本名：出片带「原片」，如「V1 原片」；合成只有版本号，如「V2」。 */
export const versionNameOf = (video: ConversationVideo): string =>
  isTake(video) ? `${versionLabel(video.version)} ${ORIGINAL_LABEL}` : versionLabel(video.version)

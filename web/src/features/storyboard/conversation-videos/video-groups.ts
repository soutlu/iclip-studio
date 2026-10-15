/** 版本组：一段对话读得到的成片（自己的加继承来的）按镜头组分组、组内按完成时刻编 V1、V2……
 * 规则见 CONTEXT「镜头组」：同镜号一组；没有镜号的出片各自一组，同原作的合成跟着它。
 * 需求单面板与整片编辑器共用这一份分组。 */

import { isTake } from '../shots'
import type { GenerationJob } from '../storyboard.api'

export type ConversationVideo = GenerationJob & { outputUrl: string }

export type ConversationVideoGroup = {
  id: string
  /** 镜头组 N；没有镜号的组叫「视频 N」。 */
  label: string
  /** 从旧到新排列，数组位置对应版本号（V1 在最前）。 */
  videos: ConversationVideo[]
}

const hasOutput = (job: GenerationJob): job is ConversationVideo =>
  job.status === 'completed' && Boolean(job.outputUrl?.trim())

/** 有基底的合成：在一条成片上拼出来的新的一版，跟着它的原作归组。没有来源的合成（整片）不是版本。 */
const isBasedComposite = (job: GenerationJob): boolean =>
  job.kind === 'video' && job.operation === 'compose' && job.sourceJobId != null

/** 成片：完成、有地址的出片或有基底的合成。编辑段、上传与图片都不算。 */
const isFinishedVideo = (job: GenerationJob): job is ConversationVideo =>
  hasOutput(job) && (isTake(job) || isBasedComposite(job))

/** 成片按到终态的时刻排；缺了这个时刻就退回创建时刻。 */
const byFinish = (left: GenerationJob, right: GenerationJob): number =>
  Date.parse(left.finishedAt ?? left.createdAt) - Date.parse(right.finishedAt ?? right.createdAt) ||
  left.id.localeCompare(right.id)

/** 这条成片归哪一组：有镜号按镜号；没有镜号的出片自成一组，合成跟着它的原作。 */
const groupKeyOf = (video: ConversationVideo): string => {
  if (video.shotIndex != null) return `shot-${video.shotIndex}`
  return `video-${isTake(video) ? video.id : (video.rootJobId ?? video.id)}`
}

/** 按版本组分好的成片：先是各镜号组（按镜号），再是没有镜号的组（按它最早那一版完成的先后）。 */
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
        shots.set(shot, { id: key, label: `镜头组 ${shot}`, videos: [video] })
      else group.videos.push(video)
      continue
    }
    const group = standalone.get(key)
    if (group === undefined)
      standalone.set(key, { id: key, label: `视频 ${standalone.size + 1}`, videos: [video] })
    else group.videos.push(video)
  }

  return [
    ...[...shots].sort(([left], [right]) => left - right).map(([, group]) => group),
    ...standalone.values(),
  ]
}

import { byFinish, isComposite } from '../editing/version-lineage'
import { isTake } from '../shots'
import type { GenerationJob } from '../storyboard.api'

export type ConversationVideo = GenerationJob & { outputUrl: string }

export type ConversationVideoGroup = {
  id: string
  label: string
  videos: ConversationVideo[]
}

const hasOutput = (job: GenerationJob): job is ConversationVideo =>
  job.status === 'completed' && Boolean(job.outputUrl?.trim())

const isFinishedVideo = (job: GenerationJob): job is ConversationVideo =>
  hasOutput(job) && (isTake(job) || isComposite(job))

const groupKeyOf = (video: ConversationVideo): string => {
  if (video.shotIndex != null) return `shot-${video.shotIndex}`
  return `video-${isTake(video) ? video.id : (video.rootJobId ?? video.id)}`
}

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

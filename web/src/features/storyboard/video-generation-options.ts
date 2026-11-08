import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const

export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

export type VideoGenerationOptions = {
  model: VideoGenerationIn['model'] | undefined
  resolution: VideoResolution
  generateAudio: NonNullable<VideoGenerationIn['generate_audio']>
}

export const DEFAULT_GENERATE_AUDIO = true

export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = '720p'

export type VideoModelsStatus = 'loading' | 'ready' | 'unavailable'

export const MODELS_PENDING_TEXT: Record<Exclude<VideoModelsStatus, 'ready'>, string> = {
  loading: '正在读取视频模型',
  unavailable: '视频模型读取失败',
}

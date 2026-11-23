import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

export const VIDEO_RESOLUTIONS = ['480p', '720p'] as const

export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

export const DRAFT_QUALITY = 'draft'

export type VideoQuality = VideoResolution | typeof DRAFT_QUALITY

export const DRAFT_LABEL = '样片'

const DRAFT_RESOLUTION: VideoResolution = '480p'

export type VideoGenerationOptions = {
  model: VideoGenerationIn['model'] | undefined
  quality: VideoQuality
  generateAudio: NonNullable<VideoGenerationIn['generate_audio']>
}

export type VideoChoice = {
  model: string
  resolution: VideoResolution
  generateAudio: boolean
  draft?: true
}

export const DEFAULT_GENERATE_AUDIO = true

export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = '720p'

export type DraftSupport = 'off' | 'unsupported' | 'supported'

export const draftSupportOf = (
  draftModels: readonly string[],
  model: string | undefined,
): DraftSupport =>
  draftModels.length === 0
    ? 'off'
    : model !== undefined && draftModels.includes(model)
      ? 'supported'
      : 'unsupported'

export const usableQuality = (quality: VideoQuality, support: DraftSupport): VideoQuality =>
  quality === DRAFT_QUALITY && support !== 'supported' ? DEFAULT_VIDEO_RESOLUTION : quality

export const choiceOf = (
  model: string,
  { generateAudio, quality }: Omit<VideoGenerationOptions, 'model'>,
): VideoChoice =>
  quality === DRAFT_QUALITY
    ? { draft: true, generateAudio, model, resolution: DRAFT_RESOLUTION }
    : { generateAudio, model, resolution: quality }

export type VideoModelsStatus = 'loading' | 'ready' | 'unavailable'

export const MODELS_PENDING_TEXT: Record<Exclude<VideoModelsStatus, 'ready'>, string> = {
  loading: '正在读取视频模型',
  unavailable: '视频模型读取失败',
}

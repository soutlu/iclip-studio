import type { VideoGenerationIn } from '@/shared/api/generated/types.gen'

/** 出片分辨率的档位。服务端原样转给上游、不校验，模型清单也不给各家支持的档位，前端就只开这两档。 */
export const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const

export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number]

/** 出片入口上用户可调的几项。模型清单由服务端配置给出，还没读到时 model 为空。 */
export type VideoGenerationOptions = {
  model: VideoGenerationIn['model'] | undefined
  resolution: VideoResolution
  generateAudio: NonNullable<VideoGenerationIn['generate_audio']>
}

export const DEFAULT_GENERATE_AUDIO = true

export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = '720p'

/** 视频模型清单的读取状态。 */
export type VideoModelsStatus = 'loading' | 'ready' | 'unavailable'

/** 清单没到手时怎么说：模型下拉的占位与出片按钮的置灰原因都用这一句。 */
export const MODELS_PENDING_TEXT: Record<Exclude<VideoModelsStatus, 'ready'>, string> = {
  loading: '正在读取视频模型',
  unavailable: '无法读取视频模型',
}

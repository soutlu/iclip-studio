import type { VideoClipModelOut, VideoModelsOut } from '@/shared/api/generated/types.gen'

export const VIDEO_CLIP_MODELS: VideoClipModelOut[] = [
  {
    id: 'vendor-a-seedance-2-0',
    image: { minSeconds: 4, maxSeconds: 15, defaultSeconds: 5 },
    edit: null,
  },
  {
    id: 'vendor-a-seedance-2-5',
    image: { minSeconds: 4, maxSeconds: 30, defaultSeconds: 5 },
    edit: { minSeconds: 4, maxSeconds: 30 },
  },
  {
    id: 'wan3.0-video',
    image: { minSeconds: 2, maxSeconds: 30, defaultSeconds: 5 },
    edit: { minSeconds: 1, maxSeconds: 15 },
  },
]

export const VIDEO_MODELS: VideoModelsOut = {
  default: 'vendor-a-seedance-2-5',
  items: VIDEO_CLIP_MODELS.map((model) => model.id),
  clipModels: VIDEO_CLIP_MODELS,
}

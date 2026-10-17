import type { VideoClipModelOut } from '@/shared/api/generated/types.gen'
import type { ComposerPart } from '@/shared/ui/composer'
import { imageSlotsOf } from '../edit-prompt'

export type ClipGenerationMode = 'image' | 'edit'

export const referenceImageCountOf = (parts: readonly ComposerPart[]): number =>
  new Set(imageSlotsOf(parts).map((slot) => slot.key)).size

export type ClipGenerationInput = {
  mode: ClipGenerationMode
  seconds: number
  referenceImageCount: number
}

export type ClipGenerationBlock = { cause: 'selection' | 'references'; message: string }

const selection = (message: string): ClipGenerationBlock => ({ cause: 'selection', message })

export const clipGenerationBlock = (
  model: VideoClipModelOut,
  { mode, seconds, referenceImageCount }: ClipGenerationInput,
): ClipGenerationBlock | undefined => {
  const limits = model[mode]
  if (limits === null) return selection('该模型不支持视频编辑，无法生成视频；请选择其他模型')
  if (!Number.isFinite(seconds) || (mode === 'image' && !Number.isInteger(seconds)))
    return selection('生成时长无效，无法生成视频；请重新选择生成时长')
  const milliseconds = Math.round(seconds * 1000)
  const outOfRange =
    milliseconds < limits.minSeconds * 1000 || milliseconds > limits.maxSeconds * 1000
  if (mode === 'image' && outOfRange)
    return selection(
      `图生时长须为 ${limits.minSeconds}–${limits.maxSeconds} 秒，无法生成视频；请重新选择生成时长`,
    )
  if (milliseconds < limits.minSeconds * 1000)
    return selection(
      `该模型编辑至少需要 ${limits.minSeconds} 秒，无法生成视频；请按住 Shift 选择相邻片段`,
    )
  if (milliseconds > limits.maxSeconds * 1000)
    return selection(`该模型编辑最多支持 ${limits.maxSeconds} 秒，无法生成视频；请缩小选区`)
  if (mode === 'image' && referenceImageCount === 0)
    return {
      cause: 'references',
      message: '尚未引用图片，无法生成视频；请在描述中引用至少一张图片',
    }
  return undefined
}

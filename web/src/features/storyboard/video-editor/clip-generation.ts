import type { VideoClipModelOut } from '@/shared/api/generated/types.gen'

export type ClipGenerationMode = 'image' | 'edit'

/** 时间范围属于基底；这里校验的编辑时长是当前选用素材拼接后的长度。 */
export const clipDurationError = (
  model: VideoClipModelOut,
  mode: ClipGenerationMode,
  seconds: number,
): string | undefined => {
  const limits = model[mode]
  if (limits === null) return '该模型不支持视频编辑，请选择其他模型'
  if (!Number.isFinite(seconds) || (mode === 'image' && !Number.isInteger(seconds)))
    return '请选择有效的生成时长'
  // 草稿精度是毫秒；先还原整数毫秒，避免 4.1 - 0.1 的浮点误差误拒四秒选区。
  const value = mode === 'edit' ? Math.round(seconds * 1000) : seconds * 1000
  if (value < limits.minSeconds * 1000)
    return mode === 'edit'
      ? `该模型编辑至少需要 ${limits.minSeconds} 秒；请按住 Shift 选择相邻片段`
      : `该模型图生时长须为 ${limits.minSeconds}–${limits.maxSeconds} 秒，请重新选择`
  if (value > limits.maxSeconds * 1000)
    return mode === 'edit'
      ? `该模型编辑最多支持 ${limits.maxSeconds} 秒，请缩小选区`
      : `该模型图生时长须为 ${limits.minSeconds}–${limits.maxSeconds} 秒，请重新选择`
  return undefined
}

import type { SaveState } from './use-shots-draft'
import { MODELS_PENDING_TEXT, type VideoModelsStatus } from './video-generation-options'
import { supportsAspectRatio } from './video-model-support'

export type GenerationFacts = {
  readOnly: boolean
  saveState: SaveState['kind']
  uploading: boolean
  modelsStatus: VideoModelsStatus
}

export type GenerationBlocker = { reason: string; transient: boolean }

const blocker = (reason: string, transient = false): GenerationBlocker => ({ reason, transient })

export const generationBlockerOf = (facts: GenerationFacts): GenerationBlocker | undefined => {
  if (facts.readOnly) return blocker('只读任务，无法出片')
  if (facts.saveState === 'conflict') return blocker('分镜存在版本冲突，无法出片；请处理冲突')
  if (facts.saveState === 'error') return blocker('分镜保存失败，请重试保存')
  if (facts.modelsStatus === 'unavailable') return blocker(MODELS_PENDING_TEXT.unavailable)
  if (facts.saveState === 'saving') return blocker('分镜保存中', true)
  if (facts.uploading) return blocker('图片上传中', true)
  if (facts.modelsStatus === 'loading') return blocker(MODELS_PENDING_TEXT.loading, true)
  return undefined
}

export type GenerationStatusLine = { tone: 'blocked' | 'error'; text: string }

export const generationStatusOf = (
  blocked: GenerationBlocker | undefined,
  notice: string | undefined,
): { line: GenerationStatusLine | undefined; hiddenReason: string | undefined } => {
  if (blocked !== undefined && !blocked.transient)
    return { hiddenReason: undefined, line: { text: blocked.reason, tone: 'blocked' } }
  const line: GenerationStatusLine | undefined =
    notice === undefined ? undefined : { text: notice, tone: 'error' }
  return { hiddenReason: blocked?.reason, line }
}

export const generationNoticeOf = (facts: {
  submitError: string | undefined
  model: string | undefined
  aspectRatio: string
}): string | undefined => {
  if (facts.submitError !== undefined) return facts.submitError
  if (supportsAspectRatio(facts.model, facts.aspectRatio)) return undefined
  return `${facts.model} 不支持 ${facts.aspectRatio} 画幅`
}

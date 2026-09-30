/** 出片栏的两条规则：出片按钮为什么置灰，以及挨着按钮常显的那句提示。 */

import type { SaveState } from './use-shots-draft'
import { MODELS_PENDING_TEXT, type VideoModelsStatus } from './video-generation-options'
import { supportsAspectRatio } from './video-model-support'

export type GenerationFacts = {
  readOnly: boolean
  saveState: SaveState['kind']
  /** 本页有图片还在上传。 */
  uploading: boolean
  modelsStatus: VideoModelsStatus
}

/** 出片按钮置灰的原因，能出片时为 undefined。出片发的是描述的当前版本，还在存或没存下就先别发，
 * 免得发出去的和文件里的不一样。一次只说一条：要用户动手的排在前，等一下就好的暂态在后。 */
export const generationBlockerOf = (facts: GenerationFacts): string | undefined => {
  if (facts.readOnly) return '只读对话，不能出片'
  if (facts.saveState === 'conflict') return '先处理分镜的版本冲突'
  if (facts.saveState === 'error') return '分镜没存下，先重试保存'
  if (facts.saveState === 'saving') return '分镜保存中'
  if (facts.uploading) return '图片还在上传'
  if (facts.modelsStatus !== 'ready') return MODELS_PENDING_TEXT[facts.modelsStatus]
  return undefined
}

/** 出片栏常显的一句，没有就为 undefined：上次提交失败的原话优先；其次是选中的模型做不了
 * 这份分镜的画幅——只提醒不拦，真拒还是由上游拒。 */
export const generationNoticeOf = (facts: {
  submitError: string | undefined
  model: string | undefined
  aspectRatio: string
}): string | undefined => {
  if (facts.submitError !== undefined) return facts.submitError
  if (supportsAspectRatio(facts.model, facts.aspectRatio)) return undefined
  return `${facts.model} 做不了 ${facts.aspectRatio}`
}

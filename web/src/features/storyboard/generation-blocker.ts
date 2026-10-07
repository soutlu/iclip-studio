/** 出片栏的规则：出片按钮为什么置灰、要提醒的错误，以及两者怎么分配到状态行与主按钮的说明上。 */

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

/** 出片按钮置灰的原因。`transient` 是等一下自己就好的暂态（保存中、上传中、模型清单在读），
 * 不用用户动手，状态行不显示它，免得每次自动保存都让出片栏多出一行、跳一下。 */
export type GenerationBlocker = { reason: string; transient: boolean }

const blocker = (reason: string, transient = false): GenerationBlocker => ({ reason, transient })

/** 出片按钮置灰的原因，能出片时为 undefined。出片发的是描述的当前版本，还在存或没存下就先别发，
 * 免得发出去的和文件里的不一样。一次只说一条：要用户动手或一直挡着的排在前，等一下就好的暂态在后。 */
export const generationBlockerOf = (facts: GenerationFacts): GenerationBlocker | undefined => {
  if (facts.readOnly) return blocker('只读任务，不能出片')
  if (facts.saveState === 'conflict') return blocker('先处理分镜的版本冲突')
  if (facts.saveState === 'error') return blocker('分镜没存下，先重试保存')
  if (facts.modelsStatus === 'unavailable') return blocker(MODELS_PENDING_TEXT.unavailable)
  if (facts.saveState === 'saving') return blocker('分镜保存中', true)
  if (facts.uploading) return blocker('图片还在上传', true)
  if (facts.modelsStatus === 'loading') return blocker(MODELS_PENDING_TEXT.loading, true)
  return undefined
}

/** 出片栏上方状态行写的一句；tone 决定配色与是否播报：错误播报，置灰原因由主按钮的说明关联读出。 */
export type GenerationStatusLine = { tone: 'blocked' | 'error'; text: string }

/** 置灰原因与错误提醒怎么摆：
 * - `line`：状态行看得见的一句。一直挡着的置灰原因优先（主按钮的说明就指向它），其次是错误提醒；暂态原因不上状态行。
 * - `hiddenReason`：暂态的置灰原因，不显示，只给主按钮当说明，读屏照样读得到为什么点不了。 */
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

/** 出片栏要提醒的错误，没被一直挡着时写在状态行上，没有就为 undefined：上次提交失败的原话优先；其次是选中的模型做不了
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

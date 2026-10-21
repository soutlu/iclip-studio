/** 爆款素材给人看的文字：不能入选的原因与 AI 维度旁的提示。只按原因代码出一句话，不展示文件名与原始报错。 */

import type { HitCaseIneligible } from './hit-cases.api'

/** 「加入爆款素材库」置灰时的提示。 */
export const INELIGIBLE_HINTS: Record<HitCaseIneligible, string> = {
  no_conversation: '该视频不属于任何对话，没有新片执行方案，无法加入爆款素材库',
  no_treatment: '所在对话没有新片执行方案，无法加入爆款素材库',
  not_material: '该视频不是成片素材，无法加入爆款素材库',
}

/** AI 维度旁的提示：爆款只在入选与重新打标时重写这一维度。 */
export const HIT_CASE_AI_HINT = '由 AI 自动打标，重新打标时会重写该项标签'

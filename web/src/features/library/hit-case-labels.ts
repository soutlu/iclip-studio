import type { HitCaseIneligible } from './hit-cases.api'

export const INELIGIBLE_HINTS: Record<HitCaseIneligible, string> = {
  no_conversation: '该视频不属于任何对话，没有新片执行方案，无法加入爆款素材库',
  no_treatment: '所在对话没有新片执行方案，无法加入爆款素材库',
  not_material: '该视频不是成片素材，无法加入爆款素材库',
}

export const HIT_CASE_AI_HINT = '由 AI 自动打标，重新打标时会重写该项标签'

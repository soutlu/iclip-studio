import { tagNamesOf, type TagIndex } from './library-tags'
import {
  isBreakdownBusy,
  isTaggingBusy,
  type BreakdownError,
  type ReferenceItem,
  type TagError,
} from './references.api'

export const UNTAGGED_YET = '拆解完成后自动打标签'

const TAGGING_YET = '打标完成后自动显示标签'

export const referenceTitleOf = (
  item: Pick<ReferenceItem, 'breakdownStatus' | 'tagIds' | 'tagStatus'>,
  index: TagIndex,
): { text: string; placeholder: boolean } => {
  const names = tagNamesOf(index, item.tagIds)
  if (names.length > 0) return { placeholder: false, text: names.join(' · ') }
  if (isBreakdownBusy(item.breakdownStatus)) return { placeholder: true, text: UNTAGGED_YET }
  if (isTaggingBusy(item.tagStatus)) return { placeholder: true, text: TAGGING_YET }
  return { placeholder: true, text: '未标注' }
}

const FAILURE_HINTS: Record<BreakdownError, string> = {
  model_call_failed: '拆解服务连接失败，请稍后点击「重新拆解」重试。',
  model_failed: '模型未能拆解该视频，请稍后点击「重新拆解」重试。',
  model_unavailable: '没启用拆解模型，请联系管理员启用后点击「重新拆解」重试。',
  timeout: '拆解超时，请稍后点击「重新拆解」重试。',
  video_unreadable: '视频读取失败，请上传其他视频。',
}

export const failureMessageOf = (
  errorCode: BreakdownError | null,
  hasDocument: boolean,
): string => {
  const hint = errorCode === null ? '请稍后点击「重新拆解」重试。' : FAILURE_HINTS[errorCode]
  return hasDocument ? `重新拆解失败，下方仍是上一次的拆解。${hint}` : `拆解失败。${hint}`
}

const TAG_FAILURES: Record<TagError, { reason: string; retry: string }> = {
  model_call_failed: { reason: '打标服务连接失败', retry: '请稍后点击「重新打标」重试' },
  model_failed: { reason: '模型未能完成打标', retry: '请稍后点击「重新打标」重试' },
  model_unavailable: {
    reason: '没启用打标模型',
    retry: '请联系管理员启用后点击「重新打标」重试',
  },
  no_source_text: { reason: '暂无可读的拆解，无法打标', retry: '请点击「重新打标」重试' },
  timeout: { reason: '打标超时', retry: '请稍后点击「重新打标」重试' },
}

const HIT_CASE_NO_SOURCE_TEXT = {
  reason: '所在对话暂无可读的新片执行方案，无法打标',
  retry: '请在补充新片执行方案后点击「重新打标」重试',
}

export const taggingFailureOf = (
  tagError: TagError | null,
  canRetag: boolean,
  library: 'references' | 'hit-cases' = 'references',
): string => {
  const failure =
    tagError === null
      ? { reason: '打标失败', retry: '请稍后点击「重新打标」重试' }
      : tagError === 'no_source_text' && library === 'hit-cases'
        ? HIT_CASE_NO_SOURCE_TEXT
        : TAG_FAILURES[tagError]
  return canRetag
    ? `${failure.reason}，AI 打的标签已清空；${failure.retry}。`
    : `${failure.reason}，AI 打的标签已清空。`
}

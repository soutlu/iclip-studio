/** 参考视频给人看的文字：卡片的标签行、没拆成的原因。只按 errorCode 出一句话，不展示原始报错。 */

import {
  isBreakdownBusy,
  type BreakdownError,
  type ReferenceFilters,
  type ReferenceItem,
  type VideoType,
} from './references.api'

/** 片子类型的名称表，取自 /references/filters。 */
export type VideoTypeLabels = ReadonlyMap<VideoType, string>

export const videoTypeLabelsOf = (filters: ReferenceFilters): VideoTypeLabels =>
  new Map(filters.videoTypes.map((type) => [type.value, type.label]))

/** 卡片与详情的标签：先片子类型再品类。名称表里没有的取值不显示，不把取值原文给人看。 */
export const tagsOf = (
  item: Pick<ReferenceItem, 'videoTypes' | 'categories'>,
  labels: VideoTypeLabels,
): string[] => [
  ...item.videoTypes.flatMap((type) => {
    const label = labels.get(type)
    return label === undefined ? [] : [label]
  }),
  ...item.categories,
]

/** 还没拆完时标签处的说明。 */
export const UNTAGGED_YET = '拆解完成后自动打标签'

/** 卡片标题：拆完了是标签，没有标签是「未标注」；还没拆完说明拆完会自动打。`placeholder` 的用浅色字。 */
export const referenceTitleOf = (
  item: Pick<ReferenceItem, 'breakdownStatus' | 'videoTypes' | 'categories'>,
  labels: VideoTypeLabels,
): { text: string; placeholder: boolean } => {
  if (isBreakdownBusy(item.breakdownStatus)) return { placeholder: true, text: UNTAGGED_YET }
  const tags = tagsOf(item, labels)
  return tags.length === 0
    ? { placeholder: true, text: '未标注' }
    : { placeholder: false, text: tags.join(' · ') }
}

/** 每种失败原因让人怎么办。 */
const FAILURE_HINTS: Record<BreakdownError, string> = {
  model_call_failed: '拆解服务连接失败，请稍后点击「重新拆解」重试。',
  model_failed: '模型未能拆解该视频，请稍后点击「重新拆解」重试。',
  timeout: '拆解超时，请稍后点击「重新拆解」重试。',
  video_unreadable: '视频读取失败，请上传其他视频。',
}

/** 详情顶上那句话：有上一次的拆解时说明下面还是上一次的；原因缺失时只请人稍后再试。 */
export const failureMessageOf = (
  errorCode: BreakdownError | null,
  hasDocument: boolean,
): string => {
  const hint = errorCode === null ? '请稍后点击「重新拆解」重试。' : FAILURE_HINTS[errorCode]
  return hasDocument ? `重新拆解失败，下方仍是上一次的拆解。${hint}` : `拆解失败。${hint}`
}

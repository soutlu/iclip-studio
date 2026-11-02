/** 模型思考档位的中文名称。档位取值与先后跟合同 `AgentModelSettings.thinking` 一致。 */

import type { AgentModelSettings } from '@/shared/api/generated/types.gen'

export type ThinkingLevel = NonNullable<AgentModelSettings['thinking']>

/** 从不思考到想得最多。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const LABEL: Record<ThinkingLevel, string> = {
  none: '不思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
}

export const thinkingLabel = (level: ThinkingLevel): string => LABEL[level]

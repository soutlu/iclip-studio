/** 模型思考档位的显示：系统 emoji 加中文档名。档位取值与先后跟合同 `AgentModelSettings.thinking` 一致。 */

import type { AgentModelSettings } from '@/shared/api/generated/types.gen'
import { cn } from '@/shared/lib/utils'

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

// 只有四张脸：不思考睡着、低微笑、中想事、高脑子炸了；最低一档并进「低」，最高两档并进「高」。
const EMOJI: Record<ThinkingLevel, string> = {
  none: '😴',
  minimal: '🙂',
  low: '🙂',
  medium: '🤔',
  high: '🤯',
  xhigh: '🤯',
  max: '🤯',
}

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

/** 档位 emoji；装饰用，档名由所在控件的文字或可访问名给出。 */
export function ThinkingEmoji({ className, level }: { className?: string; level: ThinkingLevel }) {
  return (
    <span aria-hidden className={cn('inline-block shrink-0 leading-none', className)}>
      {EMOJI[level]}
    </span>
  )
}

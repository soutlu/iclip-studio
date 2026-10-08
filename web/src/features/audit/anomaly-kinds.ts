/** 四种异常给人看的名字、轻重与悬停说明；说明里的门槛取自接口，门槛改了文字跟着变。 */

import type { ExecutionAnomalyKind, ExecutionThresholds } from './audit.api'
import { fmtTokens } from './overview-format'

export type AnomalyTone = 'bad' | 'warn'

type AnomalyMeta = {
  label: string
  tone: AnomalyTone
  describe: (thresholds: ExecutionThresholds) => string
}

export const ANOMALY_META: Record<ExecutionAnomalyKind, AnomalyMeta> = {
  retry: {
    label: '反复重试',
    tone: 'bad',
    describe: ({ retryAtLeast }) => `单镜成功生成 ${retryAtLeast} 次及以上`,
  },
  stuck: {
    label: '视频悬挂',
    tone: 'bad',
    describe: ({ stuckHours }) => `提交上游超过 ${stuckHours} 小时尚未返回结果`,
  },
  spend: {
    label: '消耗离群',
    tone: 'warn',
    // 本期没有成片时算不出门槛的 token 数，只说倍数。
    describe: ({ spendTimes, spendTokens }) =>
      `单段对话的 token 超过所选时间范围内每件成片平均消耗的 ${spendTimes} 倍${spendTokens === null ? '' : `（${fmtTokens(spendTokens)} token）`}`,
  },
  task_stuck: {
    label: '需求单卡住',
    tone: 'warn',
    describe: ({ taskConversations }) => `已关联 ${taskConversations} 段以上对话，尚无成片`,
  },
}

/** 悬停与读屏用的一句话：「反复重试：单镜成功生成 3 次及以上」。 */
export const anomalyText = (kind: ExecutionAnomalyKind, thresholds: ExecutionThresholds) =>
  `${ANOMALY_META[kind].label}：${ANOMALY_META[kind].describe(thresholds)}`

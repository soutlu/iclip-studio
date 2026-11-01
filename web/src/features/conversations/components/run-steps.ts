/**
 * 运行过程：把一段对话的每一轮拆成一串步骤，给 Agent 配置页的测试预览看 agent 是怎么跑的。
 * 一步就是协议里的一个 step（一次模型请求连同它调起的工具），耗时取 step 自己的起止时刻；
 * 工具调用没有单独的起止时刻，所以耗时只到步骤为止。名称与图标全部来自工具卡（toolCard），不露工具名。
 */

import type { IconName } from '@/shared/icons'
import type {
  ToolCallFrame,
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTurn,
} from '@/shared/transcript/vendor'
import { promptText } from '../conversations.api'
import { toolCard, toolOutcome, type ToolOutcome } from './tool-display'

export type RunCall = {
  id: string
  icon: IconName
  label: string
  detail?: string
  outcome: ToolOutcome
}

export type RunStep = {
  id: string
  icon: IconName
  label: string
  /** 这一步调起的工具；只回复或只思考的步骤为空。 */
  calls: readonly RunCall[]
  state: TranscriptStep['state']
  /** 起止时刻都在才有。 */
  durationMs?: number
}

export type RunTurn = {
  turnId: string
  /** 开场那条消息的文字；只发了图或视频时为空串。 */
  prompt: string
  state: TranscriptTurn['state']
  durationMs?: number
  steps: readonly RunStep[]
}

const spanMs = (startedAt: string | undefined, endedAt: string | undefined) => {
  if (startedAt === undefined || endedAt === undefined) return undefined
  const span = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isNaN(span) || span < 0 ? undefined : span
}

const withDuration = <T extends object>(value: T, durationMs: number | undefined) =>
  durationMs === undefined ? value : { ...value, durationMs }

const runCall = (
  frame: ToolCallFrame,
  interactions: ReadonlyMap<string, TranscriptInteraction>,
): RunCall => {
  const card = toolCard(frame.display, frame.view)
  const call: RunCall = {
    icon: card.icon,
    id: frame.toolCallId,
    label: card.label,
    outcome: toolOutcome(frame, interactions),
  }
  return card.detail === undefined ? call : { ...call, detail: card.detail }
}

/** 一步的名字：调了工具就是工具卡的标题（多个时写第一个加总数），否则是回复或思考；什么都没有的步骤不列。 */
const runStep = (
  step: TranscriptStep,
  interactions: ReadonlyMap<string, TranscriptInteraction>,
): RunStep | undefined => {
  const calls = step.frames
    .filter((frame): frame is ToolCallFrame => frame.kind === 'tool')
    .map((frame) => runCall(frame, interactions))
  const replied = step.frames.some(
    (frame) => frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim() !== '',
  )
  const thought = step.frames.some((frame) => frame.kind === 'thinking' && frame.text.trim() !== '')
  const [first] = calls
  const head =
    first !== undefined
      ? {
          icon: first.icon,
          label: calls.length === 1 ? first.label : `${first.label} 等 ${calls.length} 项`,
        }
      : replied
        ? { icon: 'message' as const, label: '回复' }
        : thought
          ? { icon: 'thinking' as const, label: '思考' }
          : undefined
  if (head === undefined) return undefined
  return withDuration(
    { ...head, calls, id: step.stepId, state: step.state },
    spanMs(step.startedAt, step.endedAt),
  )
}

export const runTurns = (
  turns: readonly TranscriptTurn[],
  interactions: ReadonlyMap<string, TranscriptInteraction>,
): RunTurn[] =>
  turns.map((turn) =>
    withDuration(
      {
        prompt: promptText(turn.content),
        state: turn.state,
        steps: turn.steps.flatMap((step) => runStep(step, interactions) ?? []),
        turnId: turn.turnId,
      },
      spanMs(turn.startedAt, turn.endedAt),
    ),
  )

/** 不到一分钟写到十分之一秒，再长写分秒。 */
export const durationLabel = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

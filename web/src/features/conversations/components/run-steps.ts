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
  calls: readonly RunCall[]
  state: TranscriptStep['state']
  durationMs?: number
}

export type RunTurn = {
  turnId: string
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

export const durationLabel = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

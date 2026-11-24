import type {
  InteractionState,
  ToolCallFrame,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTurn,
} from '@/shared/transcript/vendor'

export type ApprovalItem = {
  interactionId: string
  frame: ToolCallFrame | undefined
  state: InteractionState
}

type ApprovalFrame = ToolCallFrame & { approvalId: string }

const approvalFrames = (frames: readonly TranscriptFrame[]): ApprovalFrame[] =>
  frames.filter(
    (frame): frame is ApprovalFrame => frame.kind === 'tool' && frame.approvalId !== undefined,
  )

export const approvalBatch = (
  turns: readonly TranscriptTurn[],
  interactions: ReadonlyMap<string, TranscriptInteraction>,
  pending: readonly TranscriptInteraction[],
): ApprovalItem[] => {
  const open = new Set(
    pending
      .filter((interaction) => interaction.interactionKind === 'approval')
      .map((interaction) => interaction.interactionId),
  )
  if (open.size === 0) return []
  const steps = turns.flatMap((turn) => turn.steps)
  const step = steps.findLast((candidate) =>
    approvalFrames(candidate.frames).some((frame) => open.has(frame.approvalId)),
  )
  const items: ApprovalItem[] = approvalFrames(step?.frames ?? []).map((frame) => ({
    frame,
    interactionId: frame.approvalId,
    state: interactions.get(frame.approvalId)?.state ?? 'pending',
  }))
  const listed = new Set(items.map((item) => item.interactionId))
  const everyFrame = approvalFrames(steps.flatMap((candidate) => candidate.frames))
  const rest = [...open]
    .filter((interactionId) => !listed.has(interactionId))
    .map((interactionId): ApprovalItem => ({
      frame: everyFrame.findLast((frame) => frame.approvalId === interactionId),
      interactionId,
      state: 'pending',
    }))
  return [...items, ...rest]
}

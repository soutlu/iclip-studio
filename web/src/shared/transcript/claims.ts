import type { PromptContentPart, TranscriptPrompt, TranscriptTurn } from './vendor'

export type PendingPrompt = {
  promptId: string
  content: readonly PromptContentPart[]
}

export const sameContent = (a: readonly PromptContentPart[], b: readonly PromptContentPart[]) =>
  a.length === b.length &&
  a.every((part, index) => {
    const other = b[index]
    if (other === undefined || other.type !== part.type) return false
    return part.type === 'text'
      ? other.type === 'text' && other.text === part.text
      : other.type !== 'text' && other.source.url === part.source.url
  })

const steeredInto = (turn: TranscriptTurn, promptId: string): boolean =>
  turn.steps.some((step) =>
    step.frames.some(
      (frame) =>
        frame.kind === 'text' &&
        frame.role === 'user' &&
        (frame.promptIds ?? []).includes(promptId),
    ),
  )

export const claimed = (
  item: PendingPrompt,
  turns: readonly TranscriptTurn[],
  prompts: ReadonlyMap<string, TranscriptPrompt>,
): boolean => {
  const prompt = prompts.get(item.promptId)
  if (prompt?.status === 'queued') return true
  if (prompt !== undefined && prompt.status !== 'running') return true
  return turns.some(
    (turn) =>
      turn.triggerPromptId === item.promptId ||
      steeredInto(turn, item.promptId) ||
      (turn.triggerPromptId === undefined && sameContent(turn.content, item.content)),
  )
}

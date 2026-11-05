import { claimed, type PendingPrompt } from './claims'
import type { TranscriptPrompt, TranscriptTurn } from './vendor'

export type { PendingPrompt }

export interface LocalTimeline {
  turns: readonly TranscriptTurn[]
  prompts: readonly TranscriptPrompt[]
  turnActive: boolean
}

export interface LocalPrompts {
  readonly pending: readonly PendingPrompt[]
  readonly inFlightPromptId: string | null
  readonly requests: readonly string[]
  readonly generation: number
}

export interface LocalTurnState {
  generation: number
  pending: number
}

export const NO_LOCAL_PROMPTS: LocalPrompts = Object.freeze({
  generation: 0,
  inFlightPromptId: null,
  pending: Object.freeze([]),
  requests: Object.freeze([]),
})

const promptsById = (prompts: readonly TranscriptPrompt[]) =>
  new Map(prompts.map((prompt) => [prompt.promptId, prompt]))

export const hasLivePrompts = (prompts: readonly TranscriptPrompt[]): boolean =>
  prompts.some((prompt) => prompt.status === 'running' || prompt.status === 'queued')

export const inFlightSettled = (state: LocalPrompts, timeline: LocalTimeline): boolean => {
  if (state.inFlightPromptId === null) return false
  const submitted = timeline.prompts.find((prompt) => prompt.promptId === state.inFlightPromptId)
  const submittedSettled =
    submitted !== undefined && submitted.status !== 'queued' && submitted.status !== 'running'
  return submittedSettled && !timeline.turnActive && !hasLivePrompts(timeline.prompts)
}

export const unclaimed = (
  state: LocalPrompts,
  timeline: Pick<LocalTimeline, 'turns' | 'prompts'>,
): readonly PendingPrompt[] => {
  const byId = promptsById(timeline.prompts)
  return state.pending.filter((item) => !claimed(item, timeline.turns, byId))
}

export class LocalPromptStore {
  private readonly states = new Map<string, LocalPrompts>()
  private readonly listeners = new Set<() => void>()

  get(conversationId: string): LocalPrompts {
    return this.states.get(conversationId) ?? NO_LOCAL_PROMPTS
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getLocalTurnState(conversationId: string): LocalTurnState {
    const state = this.get(conversationId)
    return { generation: state.generation, pending: state.requests.length }
  }

  hasPendingLocalWork(conversationId: string, timeline: LocalTimeline): boolean {
    const state = this.get(conversationId)
    if (state.requests.length > 0) return true
    if (state.inFlightPromptId !== null && !inFlightSettled(state, timeline)) return true
    return unclaimed(state, timeline).length > 0
  }

  begin(conversationId: string, item: PendingPrompt, timeline: LocalTimeline): boolean {
    const state = this.get(conversationId)
    const startsFlight = state.inFlightPromptId === null || inFlightSettled(state, timeline)
    this.write(conversationId, {
      generation: state.generation + 1,
      inFlightPromptId: startsFlight ? item.promptId : state.inFlightPromptId,
      pending: [...unclaimed(state, timeline), item],
      requests: [...state.requests, item.promptId],
    })
    return startsFlight
  }

  accepted(conversationId: string, promptId: string): void {
    const state = this.get(conversationId)
    this.write(conversationId, {
      ...state,
      generation: state.generation + 1,
      requests: state.requests.filter((id) => id !== promptId),
    })
  }

  rollback(conversationId: string, promptId: string, startedFlight: boolean): void {
    const state = this.get(conversationId)
    this.write(conversationId, {
      generation: state.generation + 1,
      inFlightPromptId:
        startedFlight && state.inFlightPromptId === promptId ? null : state.inFlightPromptId,
      pending: state.pending.filter((item) => item.promptId !== promptId),
      requests: state.requests.filter((id) => id !== promptId),
    })
  }

  settle(conversationId: string, promptId: string): void {
    const state = this.get(conversationId)
    if (state.inFlightPromptId !== promptId) return
    this.write(conversationId, {
      ...state,
      generation: state.generation + 1,
      inFlightPromptId: null,
    })
  }

  private write(conversationId: string, next: LocalPrompts): void {
    this.states.set(conversationId, next)
    for (const listener of this.listeners) listener()
  }
}

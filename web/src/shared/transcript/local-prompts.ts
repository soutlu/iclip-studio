/**
 * 按对话保存本地已发出、还没被时间线接替的消息（乐观气泡）与在途的那一轮。
 *
 * 参考 Kimi：本地发送状态不随页面卸载丢失，读取池据此判断一段对话能否淘汰、重拉基线前后本地是否又发过消息。
 * 认领由时间线推导，不是事件：已认领的条目留在列表里，直到下一次发送时清掉，与此前组件内状态一致。
 */

import { claimed, type PendingPrompt } from './claims'
import type { TranscriptPrompt, TranscriptTurn } from './vendor'

export type { PendingPrompt }

/** 判定认领与收尾所需的时间线事实，取自同一份 transcript 视图。 */
export interface LocalTimeline {
  turns: readonly TranscriptTurn[]
  prompts: readonly TranscriptPrompt[]
  /** transcript meta 的 activity 是否为 turn。 */
  turnActive: boolean
}

export interface LocalPrompts {
  /** 发出过的消息，含已被认领、尚未清掉的。 */
  readonly pending: readonly PendingPrompt[]
  /** 这一轮由哪条消息开起；收尾后清空。 */
  readonly inFlightPromptId: string | null
  /** 还没回执的发送请求，按 promptId 记，回执与失败各自只销自己那一条。 */
  readonly requests: readonly string[]
  /** 本地每发生一件事（发出、回执、失败撤回、收尾）加一。 */
  readonly generation: number
}

/** 对应 Kimi 的 getLocalTurnState：重拉前后两份不同，说明这期间本地动过。 */
export interface LocalTurnState {
  generation: number
  pending: number
}

const EMPTY: LocalPrompts = Object.freeze({
  generation: 0,
  inFlightPromptId: null,
  pending: Object.freeze([]),
  requests: Object.freeze([]),
})

const promptsById = (prompts: readonly TranscriptPrompt[]) =>
  new Map(prompts.map((prompt) => [prompt.promptId, prompt]))

/** 时间线里还有排队或在跑的消息。 */
export const hasLivePrompts = (prompts: readonly TranscriptPrompt[]): boolean =>
  prompts.some((prompt) => prompt.status === 'running' || prompt.status === 'queued')

/** 在途那一轮已经收尾：它那条消息到了终态，没有轮次在跑，也没有排队或在跑的消息。 */
export const inFlightSettled = (state: LocalPrompts, timeline: LocalTimeline): boolean => {
  if (state.inFlightPromptId === null) return false
  const submitted = timeline.prompts.find((prompt) => prompt.promptId === state.inFlightPromptId)
  const submittedSettled =
    submitted !== undefined && submitted.status !== 'queued' && submitted.status !== 'running'
  return submittedSettled && !timeline.turnActive && !hasLivePrompts(timeline.prompts)
}

/** 还没被时间线接替的那几条，即仍要画成乐观气泡的。 */
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

  /** 同一段对话在两次变化之间返回同一个对象，满足 useSyncExternalStore 的快照稳定要求。 */
  get(conversationId: string): LocalPrompts {
    return this.states.get(conversationId) ?? EMPTY
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getLocalTurnState(conversationId: string): LocalTurnState {
    const state = this.get(conversationId)
    return { generation: state.generation, pending: state.requests.length }
  }

  /** 有乐观气泡还没被接替，或在途那一轮还没收尾。对应 Kimi 的 hasPendingLocalWork；认领要看时间线，所以由调用方给。 */
  hasPendingLocalWork(conversationId: string, timeline: LocalTimeline): boolean {
    const state = this.get(conversationId)
    if (state.requests.length > 0) return true
    if (state.inFlightPromptId !== null && !inFlightSettled(state, timeline)) return true
    return unclaimed(state, timeline).length > 0
  }

  /**
   * 发出一条消息：先清掉已被接替的，再记下这条。在途那一轮为空或已收尾时，由这条开起新的一轮。
   * 返回这条是否开起了新的一轮，失败撤回时要用。
   */
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

  /** 服务端回执了这次发送；气泡仍等时间线接替。 */
  accepted(conversationId: string, promptId: string): void {
    const state = this.get(conversationId)
    this.write(conversationId, {
      ...state,
      generation: state.generation + 1,
      requests: state.requests.filter((id) => id !== promptId),
    })
  }

  /** 发送失败：撤掉这条气泡；它开起的那一轮也一并撤销。 */
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

  /** 在途那一轮收尾了；只清当前这一轮，别的轮已开起时不动。 */
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

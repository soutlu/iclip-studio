import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zConversationEnvelope, zTranscriptPage } from '@/shared/api/generated/zod.gen'
import { MAIN_AGENT_ID } from './connection'
import { agentTranscriptSnapshotSchema, type AgentTranscriptSnapshot } from './vendor'

export interface TranscriptPage {
  snapshot: AgentTranscriptSnapshot
  seq: number
  epoch: string
  hasMoreOlder: boolean
  agents: readonly AgentDescriptor[]
  title: string
  ownerUserId: string | null
  deletedAt: string | null
  forkedFrom: string | null
  forkTurn: number | null
}

export interface PageRequest {
  pageSize: number
  beforeTurn?: string
}

export type AgentDescriptor = z.output<typeof zTranscriptPage>['agents'][number]

const dropNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(dropNulls)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNulls(field)]),
  )
}

export const fetchTranscriptPage = async (
  conversationId: string,
  agentId: string,
  { beforeTurn, pageSize }: PageRequest,
): Promise<TranscriptPage> => {
  const query = new URLSearchParams({ page_size: String(pageSize) })
  if (agentId !== MAIN_AGENT_ID) query.set('agent_id', agentId)
  if (beforeTurn !== undefined) query.set('before_turn', beforeTurn)
  const page = await apiFetch(
    `/conversations/${conversationId}/transcript?${query.toString()}`,
    zTranscriptPage,
    { cache: 'no-store', fallbackErrorMessage: '读取对话内容失败' },
  )
  const snapshot = agentTranscriptSnapshotSchema.parse(
    dropNulls({
      hasMoreOlder: page.has_more,
      interactions: page.interactions,
      items: page.items,
      meta: page.meta,
      prompts: page.prompts,
      tasks: page.tasks,
      todos: page.todos,
    }),
  ) as AgentTranscriptSnapshot
  return {
    agents: page.agents,
    deletedAt: page.deleted_at ?? null,
    epoch: page.stream_epoch,
    forkedFrom: page.forked_from ?? null,
    forkTurn: page.fork_turn ?? null,
    hasMoreOlder: page.has_more,
    ownerUserId: page.owner_user_id ?? null,
    seq: page.seq,
    snapshot,
    title: page.title,
  }
}

export const fetchConversationTitle = async (
  conversationId: string,
  signal: AbortSignal,
): Promise<string> => {
  const { conversation } = await apiFetch(
    `/conversations/${conversationId}`,
    zConversationEnvelope,
    {
      cache: 'no-store',
      fallbackErrorMessage: '读取任务失败',
      signal,
    },
  )
  return conversation.title
}

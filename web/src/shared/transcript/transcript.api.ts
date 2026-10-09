/** REST 信封使用 snake_case，实体使用 camelCase；对象中的 null 转为省略字段后，再经 vendor schema 校验。类型断言仅衔接 vendor 可选字段与 zod 的 undefined 差异。 */

import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import { zTranscriptPage } from '@/shared/api/generated/zod.gen'
import { MAIN_AGENT_ID } from './connection'
import { agentTranscriptSnapshotSchema, type AgentTranscriptSnapshot } from './vendor'

/** 一页 Transcript：协议快照加 REST 信封字段（照 Kimi 的 getSessionTranscript）。 */
export interface TranscriptPage {
  snapshot: AgentTranscriptSnapshot
  /** 这一页对应的实时流水位，订阅时连同 epoch 一起带上。 */
  seq: number
  /** 水位所属的实时流。 */
  epoch: string
  /** 当前页之前是否还有更早的轮次。 */
  hasMoreOlder: boolean
  /** 子代理名册，与主页同一份。 */
  agents: readonly AgentDescriptor[]
  /** 初始标题来自基线，后续改名由 session.meta.updated 推送。 */
  title: string
  /** 属主；治理者看别人的对话时与登录人不同，页面据此进入只读。 */
  ownerUserId: string | null
  /** 属主删掉这段对话的时刻；只有治理者复盘墓碑时非空，页面据此只读并标注。 */
  deletedAt: string | null
  /** 这段对话分叉自哪一段；不是分叉来的为 null。 */
  forkedFrom: string | null
  /** 分叉自源对话的第几轮；与 forkedFrom 同时有值。 */
  forkTurn: number | null
}

export interface PageRequest {
  pageSize: number
  /** 给了就取这一轮之前的一页（向上翻）；不给取最新一页。 */
  beforeTurn?: string
}

export type AgentDescriptor = z.output<typeof zTranscriptPage>['agents'][number]

/** 仅删除对象中值为 null 的字段，数组元素和其他原始值保持不变。 */
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
  // 主流不带 agent_id，与只认 main 的请求形状一致；子代理流按它的 id 读。
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

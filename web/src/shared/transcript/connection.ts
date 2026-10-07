/** 参考 Kimi 客户端，一条连接按 session_id 分派多段对话；会话事件全局帧（改名、活动、行的新建 / 变化 / 删除、生成任务）经 watchSessions 分发。重连按各 agent 的水位与它所属的实时流整表重订。 */

import { z } from 'zod'

import { zConversationOut, zGenerationOut } from '@/shared/api/generated/zod.gen'

import { transcriptOpsEventSchema, transcriptResetEventSchema } from './vendor/contract/events'
import type { TranscriptGrade } from './vendor/granularity/grade'
import type { AgentTranscriptSnapshot } from './vendor/ops/operation'

export type { TranscriptGrade }

/** 类型从校验 schema 推导，避免重复声明造成可选字段差异。 */
type OpsEvent = z.infer<typeof transcriptOpsEventSchema>

export type TranscriptOps = OpsEvent['ops']

/** 主 agent 的 id；子代理的 id 是它的 run id，从工具卡的 agentRefs 拿。 */
export const MAIN_AGENT_ID = 'main'

const DEFAULT_HEARTBEAT_MS = 30_000

const STALE_FLOOR_MS = 30_000

const MAX_RECONNECT_DELAY_MS = 30_000

/** 加入随机抖动，避免客户端集中重连。 */
const RECONNECT_JITTER_MS = 250

/** 一条实时流的续订水位：批次号与它所属的流（ADR-0004）；两者都对得上，服务端才接着补批。 */
export interface StreamWatermark {
  seq: number
  epoch: string
}

export interface TranscriptHandlers {
  /** 我们服务端的 reset 不带历史轮；历史由 REST 分页提供，reset 只携带全局实体和水位。 */
  onReset(
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    seq: number | undefined,
    epoch: string,
  ): void
  /** seq 与 epoch 用于检测断档；返回 false 表示未应用，连接不推进水位。 */
  onOps(agentId: string, ops: TranscriptOps, seq: number | undefined, epoch: string): boolean | void
  onNotFound?(): void
}

export interface TranscriptConnectionOptions {
  url: string
  /** 连接级状态回调，不按对话分别通知。 */
  onConnectionState?: (connected: boolean) => void
  createSocket?: (url: string) => WebSocket
  now?: () => number
}

/** 全局帧单独校验，不修改 vendor 协议；放入 TranscriptMeta 会被其 schema 丢弃未知字段。 */
const titleSchema = z.object({ session_id: z.string(), title: z.string() })

// session_id 位于信封；last_turn_reason 在运行时可能省略，结束时提供。
const workChangedSchema = z.object({
  busy: z.boolean(),
  pending_interaction: z.enum(['none', 'approval', 'question']),
  last_turn_reason: z.enum(['completed', 'failed', 'aborted']).nullable().optional(),
})

// session_id 位于信封，任务没有来源对话时省略；kind、operation、status 与 shot_index（视频的镜头组编号）取生成物的 GenerationOut；metadata 是调用方自带的标签原样带出；shot_index 与 metadata 为空时服务端整个省略字段。
const generationChangedSchema = z.object({
  id: z.string(),
  kind: zGenerationOut.shape.kind,
  operation: zGenerationOut.shape.operation,
  status: zGenerationOut.shape.status,
  shot_index: zGenerationOut.shape.shotIndex,
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

/**
 * 全局帧信封（合同 §5「全局帧」）：属主与这段对话的会话事件水位。
 * 序号只在同一 epoch 里可比；没有来源对话的生成任务帧不带 seq。
 */
const sessionEnvelopeSchema = z.object({
  owner_user_id: z.string(),
  epoch: z.string(),
  seq: z.int(),
})
const generationEnvelopeSchema = sessionEnvelopeSchema.extend({ seq: z.int().optional() })

// 整行 ConversationOut 不省略空值，照生成的 schema 解析。
const rowFrameSchema = sessionEnvelopeSchema.extend({
  session_id: z.string(),
  payload: zConversationOut,
})
const deletedFrameSchema = sessionEnvelopeSchema.extend({
  session_id: z.string(),
  payload: z.object({ session_id: z.string() }),
})

type GenerationChange = z.infer<typeof generationChangedSchema>

// session_id 位于信封；版本与写入者从重新读取的文件获取。
const fsChangedSchema = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      change: z.enum(['created', 'modified', 'deleted']),
      kind: z.string(),
    }),
  ),
  coalesced_window_ms: z.number(),
})

export type FsChange = z.infer<typeof fsChangedSchema>['changes'][number]

/** 校验问题的摘要：路径加说明，zod 的说明里不带收到的值。 */
const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)

/** 一段对话的行，形状同 REST 的 ConversationOut。 */
export type SessionRow = z.output<typeof zConversationOut>

/** 全局帧的来历：这段对话的属主，与这一帧的会话事件水位（同一 epoch 里按 seq 比先后）。 */
export interface SessionEventMark {
  ownerUserId: string
  epoch: string
  seq: number
}

/** 全局事件不补发；reconnected 是本地通知，调用方据此刷新断线期间可能变化的列表。 */
export type SessionUpdate =
  | { kind: 'title'; conversationId: string; title: string; mark: SessionEventMark }
  | {
      kind: 'activity'
      conversationId: string
      busy: boolean
      pendingInteraction: 'none' | 'approval' | 'question'
      /** 未提供结束原因时为 null。 */
      lastTurnReason: 'completed' | 'failed' | 'aborted' | null
      mark: SessionEventMark
    }
  | {
      /** 行新出现了（新建或分叉）或变了；mark.seq 是这一帧的序号，行内 lastSeq 是写入之前的水位。 */
      kind: 'created' | 'updated'
      conversationId: string
      row: SessionRow
      mark: SessionEventMark
    }
  | { kind: 'deleted'; conversationId: string; mark: SessionEventMark }
  | {
      kind: 'generation'
      /** 任务没有来源对话时为 null，mark.seq 也随之为 null。 */
      conversationId: string | null
      jobId: string
      /** 生成种类与业务状态，词表同 GenerationOut。 */
      jobKind: GenerationChange['kind']
      status: GenerationChange['status']
      /** 调用方自带的坐标，原样转发；由消费方自己解释。 */
      metadata: Record<string, unknown> | null
      mark: Omit<SessionEventMark, 'seq'> & { seq: number | null }
    }
  | { kind: 'reconnected' }

const markOf = (envelope: { owner_user_id: string; epoch: string }) => ({
  epoch: envelope.epoch,
  ownerUserId: envelope.owner_user_id,
})

export interface ConnectionHealth {
  connected: boolean
  /** 超过心跳阈值未收到入站帧时为 true。 */
  stale: boolean
}

interface FsWatch {
  paths: readonly string[]
  /** 目录订阅是否看整棵；空串路径是工作区根。 */
  recursive: boolean
  handler: (changes: readonly FsChange[]) => void
}

/** 与服务端同一条匹配规则：文件要路径相同，目录看直接子项或整棵，空串是根。 */
const watchCovers = (watch: FsWatch, path: string): boolean =>
  watch.paths.some((watched) => {
    if (watched === path) return true
    if (watched !== '' && !path.startsWith(`${watched}/`)) return false
    const inside = watched === '' ? path : path.slice(watched.length + 1)
    return watch.recursive || !inside.includes('/')
  })

interface AgentSubscription {
  handlers: TranscriptHandlers
  /** 当前会话使用 delta；侧栏使用仅含轮次与审批的 turn 档。 */
  grade: TranscriptGrade
}

interface Subscription {
  /** 一段对话里各 agent 各订各的：主流与子代理流互不覆盖，同一帧 subscribe_v2 整表上行。 */
  agents: Map<string, AgentSubscription>
  /** 按 agent 保存已应用的水位，订阅与重连时带上，服务端据此补批或回 reset。 */
  watermarks: Map<string, StreamWatermark>
}

/** 一帧 subscribe_v2 问的是哪段对话、这帧新加了谁；回执 404 时只退新加的，原本订着的不动。 */
interface PendingSubscribe {
  conversationId: string
  agentIds: readonly string[]
  added: readonly string[]
}

export class TranscriptConnection {
  private socket: WebSocket | null = null
  private connected = false
  private closed = false
  private heartbeatMs = DEFAULT_HEARTBEAT_MS
  private lastActivityAt = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 0
  private everOpened = false

  private subscriptions = new Map<string, Subscription>()

  /** 请求 ID 映射到那帧问的对话与 agent，用于处理订阅拒绝回执。 */
  private pending = new Map<string, PendingSubscribe>()

  private fsWatches = new Map<string, Set<FsWatch>>()

  private sessionWatchers = new Set<(update: SessionUpdate) => void>()

  private readonly options: TranscriptConnectionOptions

  constructor(options: TranscriptConnectionOptions) {
    this.options = options
  }

  connect(): void {
    if (this.socket !== null) return
    // 允许 close 后重新 connect，兼容 React StrictMode 的清理与重挂载。
    this.closed = false
    this.lastActivityAt = this.now()
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url)
    this.socket = socket
    socket.onmessage = (event) => {
      // 所有入站消息均刷新活跃时间，独立于帧是否合法。
      this.lastActivityAt = this.now()
      this.receive(event.data)
    }
    socket.onclose = () => this.dropped()
    socket.onerror = () => this.dropped()
  }

  close(): void {
    this.closed = true
    this.clearTimer()
    // 关闭事件异步到达，先解绑，避免 StrictMode 重连后旧事件清掉新连接。
    const socket = this.socket
    this.detach()
    socket?.close(1000)
  }

  /** 立即重连并跳过退避；先移除旧 socket 回调，避免 onclose 再次排入退避。 */
  reconnect(): void {
    if (this.closed) return
    this.clearTimer()
    const stale = this.socket
    this.detach()
    stale?.close(1000)
    this.reconnectAttempts = 0
    this.connect()
  }

  /**
   * 订阅或重订一条流（照 Kimi 的 subscribeTranscript）。调用方先读基线，再带基线的水位订阅，服务端从补发日志
   * 接着发；不给水位就清掉已有水位，服务端回一帧 reset。提高粒度时服务端同样先发 reset。
   */
  subscribe(
    conversationId: string,
    handlers: TranscriptHandlers,
    grade: TranscriptGrade = 'delta',
    agentId: string = MAIN_AGENT_ID,
    watermark?: StreamWatermark,
  ): void {
    const subscription = this.subscriptions.get(conversationId) ?? {
      agents: new Map<string, AgentSubscription>(),
      watermarks: new Map<string, StreamWatermark>(),
    }
    const added = subscription.agents.has(agentId) ? [] : [agentId]
    subscription.agents.set(agentId, { grade, handlers })
    if (watermark === undefined) subscription.watermarks.delete(agentId)
    else subscription.watermarks.set(agentId, watermark)
    this.subscriptions.set(conversationId, subscription)
    if (this.connected) this.sendSubscribe(conversationId, added)
  }

  /** 退订时清除水位，重新订阅需拉取基线；给了 agentId 只退那一条流，别的照旧。 */
  unsubscribe(conversationId: string, agentId?: string): void {
    const subscription = this.subscriptions.get(conversationId)
    if (subscription === undefined) return
    if (agentId !== undefined) {
      if (!subscription.agents.delete(agentId)) return
      subscription.watermarks.delete(agentId)
      if (subscription.agents.size > 0) {
        this.send({
          type: 'unsubscribe_v2',
          id: this.mintId(),
          payload: { session_id: conversationId, agent_ids: [agentId] },
        })
        return
      }
    }
    this.subscriptions.delete(conversationId)
    this.send({
      type: 'unsubscribe_v2',
      id: this.mintId(),
      payload: { session_id: conversationId },
    })
  }

  /** 文件订阅独立于 transcript；重连重发订阅，调用方须重拉以补偿断线期间丢失的文件通知。 */
  watchFs(
    conversationId: string,
    paths: readonly string[],
    handler: (changes: readonly FsChange[]) => void,
    options: { recursive?: boolean } = {},
  ): () => void {
    const watch: FsWatch = { handler, paths, recursive: options.recursive ?? false }
    const watches = this.fsWatches.get(conversationId) ?? new Set<FsWatch>()
    watches.add(watch)
    this.fsWatches.set(conversationId, watches)
    if (this.connected) this.sendFsWatch('watch_fs_add', conversationId, watch)
    return () => {
      const current = this.fsWatches.get(conversationId)
      if (current === undefined || !current.delete(watch)) return
      if (current.size === 0) this.fsWatches.delete(conversationId)
      this.sendFsWatch('watch_fs_remove', conversationId, watch)
    }
  }

  /** 监听所有会话的全局更新，返回取消监听函数。 */
  watchSessions(watcher: (update: SessionUpdate) => void): () => void {
    this.sessionWatchers.add(watcher)
    return () => void this.sessionWatchers.delete(watcher)
  }

  health(): ConnectionHealth {
    const limit = Math.max(this.heartbeatMs * 2, STALE_FLOOR_MS)
    return {
      connected: this.connected,
      stale: this.lastActivityAt > 0 && this.now() - this.lastActivityAt > limit,
    }
  }

  watermarkOf(conversationId: string, agentId: string): StreamWatermark | undefined {
    return this.subscriptions.get(conversationId)?.watermarks.get(agentId)
  }

  private receive(raw: unknown): void {
    let frame: {
      type?: unknown
      id?: unknown
      code?: unknown
      session_id?: unknown
      stream_epoch?: unknown
      payload?: unknown
    }
    try {
      frame = JSON.parse(String(raw)) as typeof frame
    } catch {
      // 解析错误的 message 会带上一段原文，不打出来。
      this.discard(undefined, ['JSON 解析失败'])
      return
    }
    if (typeof frame.type !== 'string') return

    switch (frame.type) {
      case 'server_hello': {
        const beat = (frame.payload as { heartbeat_ms?: number })?.heartbeat_ms
        if (typeof beat === 'number' && beat > 0) this.heartbeatMs = beat
        this.opened()
        return
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: string })?.nonce
        this.send({ type: 'pong', payload: { nonce } })
        return
      }
      case 'ack': {
        this.settleAck(frame)
        return
      }
      case 'session.meta.updated': {
        const envelope = sessionEnvelopeSchema.safeParse(frame)
        if (!envelope.success) return this.discard(frame.type, issuesOf(envelope.error))
        const parsed = titleSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: parsed.data.session_id,
          kind: 'title',
          mark: { ...markOf(envelope.data), seq: envelope.data.seq },
          title: parsed.data.title,
        })
        return
      }
      case 'event.session.work_changed': {
        if (typeof frame.session_id !== 'string') return
        const envelope = sessionEnvelopeSchema.safeParse(frame)
        if (!envelope.success) return this.discard(frame.type, issuesOf(envelope.error))
        const parsed = workChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          busy: parsed.data.busy,
          conversationId: frame.session_id,
          kind: 'activity',
          lastTurnReason: parsed.data.last_turn_reason ?? null,
          mark: { ...markOf(envelope.data), seq: envelope.data.seq },
          pendingInteraction: parsed.data.pending_interaction,
        })
        return
      }
      case 'event.session.created':
      case 'event.session.updated': {
        const parsed = rowFrameSchema.safeParse(frame)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: parsed.data.session_id,
          kind: frame.type === 'event.session.created' ? 'created' : 'updated',
          mark: { ...markOf(parsed.data), seq: parsed.data.seq },
          row: parsed.data.payload,
        })
        return
      }
      case 'event.session.deleted': {
        const parsed = deletedFrameSchema.safeParse(frame)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: parsed.data.session_id,
          kind: 'deleted',
          mark: { ...markOf(parsed.data), seq: parsed.data.seq },
        })
        return
      }
      case 'event.generation.changed': {
        const envelope = generationEnvelopeSchema.safeParse(frame)
        if (!envelope.success) return this.discard(frame.type, issuesOf(envelope.error))
        const parsed = generationChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: typeof frame.session_id === 'string' ? frame.session_id : null,
          jobId: parsed.data.id,
          jobKind: parsed.data.kind,
          kind: 'generation',
          mark: { ...markOf(envelope.data), seq: envelope.data.seq ?? null },
          metadata: parsed.data.metadata ?? null,
          status: parsed.data.status,
        })
        return
      }
      case 'event.fs.changed': {
        if (typeof frame.session_id !== 'string') return
        const parsed = fsChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        const watches = this.fsWatches.get(frame.session_id)
        if (watches === undefined) return
        for (const watch of watches) {
          const mine = parsed.data.changes.filter((change) => watchCovers(watch, change.path))
          if (mine.length > 0) watch.handler(mine)
        }
        return
      }
      case 'transcript.reset':
      case 'transcript.ops': {
        if (typeof frame.session_id !== 'string') return
        if (typeof frame.stream_epoch !== 'string') {
          return this.discard(frame.type, ['stream_epoch: 缺失'])
        }
        const subscription = this.subscriptions.get(frame.session_id)
        if (subscription === undefined) return
        this.apply(frame.type, subscription, frame.stream_epoch, {
          type: frame.type,
          ...(frame.payload as object),
        })
        return
      }
      default:
        return
    }
  }

  private announce(update: SessionUpdate): void {
    for (const watcher of this.sessionWatchers) watcher(update)
  }

  /** 解析不了或形状不合协议的帧：告警后丢弃，连接照常；只记帧类型与问题摘要，不打帧正文。 */
  private discard(type: string | undefined, issues: readonly string[]): void {
    console.warn('丢弃不合协议的 WebSocket 帧', { issues, type })
  }

  private apply(type: string, subscription: Subscription, epoch: string, wrapped: object): void {
    if (type === 'transcript.reset') {
      const parsed = transcriptResetEventSchema.safeParse(wrapped)
      if (!parsed.success) return this.discard(type, issuesOf(parsed.error))
      const { agent_id, snapshot, has_more_older, seq } = parsed.data
      const agent = subscription.agents.get(agent_id)
      if (agent === undefined) return
      // 类型断言衔接 vendor 的可选字段与 zod 推导出的 undefined，见 transcript.api.ts。
      const full = { ...snapshot, hasMoreOlder: has_more_older } as AgentTranscriptSnapshot
      agent.handlers.onReset(agent_id, full, seq, epoch)
      // reset 连同 epoch 无条件覆写水位：服务端重启或重建这条流后，批次号从 1 重来。
      if (seq !== undefined) subscription.watermarks.set(agent_id, { epoch, seq })
      return
    }
    const parsed = transcriptOpsEventSchema.safeParse(wrapped)
    if (!parsed.success) return this.discard(type, issuesOf(parsed.error))
    const { agent_id, ops, seq } = parsed.data
    const agent = subscription.agents.get(agent_id)
    if (agent === undefined) return
    const accepted = agent.handlers.onOps(agent_id, ops, seq, epoch)
    // 仅已接受的批次推进水位。同一条流里只升不降：Kimi 把重复批次的号也写进水位，会把它写小，
    // 只会让续订多补发或被迫重读（ADR-0004 第 8 条）。
    if (accepted === false || seq === undefined) return
    const current = subscription.watermarks.get(agent_id)
    if (current?.epoch === epoch && current.seq >= seq) return
    subscription.watermarks.set(agent_id, { epoch, seq })
  }

  private settleAck(frame: { id?: unknown; code?: unknown; payload?: unknown }): void {
    if (typeof frame.id !== 'string') return
    const asked = this.pending.get(frame.id)
    this.pending.delete(frame.id)
    if (asked === undefined) return
    const subscription = this.subscriptions.get(asked.conversationId)
    if (subscription === undefined) return
    const refused = (frame.payload as { not_found?: unknown })?.not_found
    if (Array.isArray(refused) && refused.includes(asked.conversationId)) {
      // 整段对话看不见：移除，避免重连后重复请求。
      this.subscriptions.delete(asked.conversationId)
      for (const agent of subscription.agents.values()) agent.handlers.onNotFound?.()
      return
    }
    if (frame.code !== 404) return
    // 表里有不属于这段对话的 agent，服务端整帧不收、已有订阅不动：只退这帧新加的子代理，再把表重发。
    // 重连重发整张表时分不清是谁，就把子代理全退掉，主流照旧。
    const blamed = asked.added.length > 0 ? asked.added : asked.agentIds
    const dropped = blamed.filter((agentId) => agentId !== MAIN_AGENT_ID)
    for (const agentId of dropped) {
      const agent = subscription.agents.get(agentId)
      subscription.agents.delete(agentId)
      subscription.watermarks.delete(agentId)
      agent?.handlers.onNotFound?.()
    }
    if (dropped.length > 0 && subscription.agents.size > 0) {
      this.sendSubscribe(asked.conversationId)
    }
  }

  private opened(): void {
    const reopened = this.everOpened
    this.everOpened = true
    this.connected = true
    this.reconnectAttempts = 0
    this.options.onConnectionState?.(true)
    for (const conversationId of this.subscriptions.keys()) this.sendSubscribe(conversationId)
    for (const [conversationId, watches] of this.fsWatches) {
      for (const watch of watches) this.sendFsWatch('watch_fs_add', conversationId, watch)
    }
    if (reopened) this.announce({ kind: 'reconnected' })
  }

  /** 文件订阅不进入 transcript 的 pending 表，避免文件拒绝回执撤销对话订阅。 */
  private sendFsWatch(
    type: 'watch_fs_add' | 'watch_fs_remove',
    conversationId: string,
    watch: FsWatch,
  ): void {
    this.send({
      type,
      id: this.mintId(),
      payload: { session_id: conversationId, paths: [...watch.paths], recursive: watch.recursive },
    })
  }

  private sendSubscribe(conversationId: string, added: readonly string[] = []): void {
    const subscription = this.subscriptions.get(conversationId)
    if (subscription === undefined || subscription.agents.size === 0) return
    const transcript: Record<string, TranscriptGrade> = {}
    const since: Record<string, number> = {}
    const epochs: Record<string, string> = {}
    for (const [agentId, agent] of subscription.agents) {
      transcript[agentId] = agent.grade
      const watermark = subscription.watermarks.get(agentId)
      if (watermark === undefined) continue
      since[agentId] = watermark.seq
      epochs[agentId] = watermark.epoch
    }
    const id = this.mintId()
    this.pending.set(id, { added, agentIds: [...subscription.agents.keys()], conversationId })
    this.send({
      type: 'subscribe_v2',
      id,
      payload: {
        session_id: conversationId,
        transcript,
        // 没有水位的 agent 不出现在这两张表里，服务端对它回 reset。
        ...(Object.keys(since).length === 0
          ? {}
          : { transcript_epoch: epochs, transcript_since: since }),
      },
    })
  }

  private send(frame: unknown): void {
    if (this.socket === null || this.socket.readyState !== 1) return
    this.socket.send(JSON.stringify(frame))
  }

  private mintId(): string {
    this.nextId += 1
    return `c${this.nextId}`
  }

  private dropped(): void {
    this.detach()
    this.scheduleReconnect()
  }

  private detach(): void {
    if (this.socket !== null) {
      this.socket.onmessage = null
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket = null
    }
    this.pending.clear()
    if (this.connected) {
      this.connected = false
      this.options.onConnectionState?.(false)
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return
    const delay =
      Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts) +
      Math.floor(Math.random() * RECONNECT_JITTER_MS)
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

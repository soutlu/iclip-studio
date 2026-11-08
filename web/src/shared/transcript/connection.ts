import { z } from 'zod'

import { zConversationOut, zGenerationOut } from '@/shared/api/generated/zod.gen'

import { transcriptOpsEventSchema, transcriptResetEventSchema } from './vendor/contract/events'
import type { TranscriptGrade } from './vendor/granularity/grade'
import type { AgentTranscriptSnapshot } from './vendor/ops/operation'

export type { TranscriptGrade }

type OpsEvent = z.infer<typeof transcriptOpsEventSchema>

export type TranscriptOps = OpsEvent['ops']

export const MAIN_AGENT_ID = 'main'

const DEFAULT_HEARTBEAT_MS = 30_000

const STALE_FLOOR_MS = 30_000

const MAX_RECONNECT_DELAY_MS = 30_000

const RECONNECT_JITTER_MS = 250

export interface StreamWatermark {
  seq: number
  epoch: string
}

export interface TranscriptHandlers {
  onReset(
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    seq: number | undefined,
    epoch: string,
  ): void
  onOps(agentId: string, ops: TranscriptOps, seq: number | undefined, epoch: string): boolean | void
  onNotFound?(): void
}

export interface TranscriptConnectionOptions {
  url: string
  onConnectionState?: (connected: boolean) => void
  createSocket?: (url: string) => WebSocket
  now?: () => number
}

const titleSchema = z.object({ title: z.string() })

const workChangedSchema = z.object({
  busy: z.boolean(),
  pending_interaction: z.enum(['none', 'approval', 'question']),
  last_turn_reason: z.enum(['completed', 'failed', 'aborted']).nullable().optional(),
})

const generationChangedSchema = z.object({
  id: z.string(),
  kind: zGenerationOut.shape.kind,
  operation: zGenerationOut.shape.operation,
  status: zGenerationOut.shape.status,
  shot_index: zGenerationOut.shape.shotIndex,
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

const sessionEnvelopeSchema = z.object({ owner_user_id: z.string() })

const conversationEnvelopeSchema = sessionEnvelopeSchema.extend({ session_id: z.string() })

const rowFrameSchema = conversationEnvelopeSchema.extend({ payload: zConversationOut })

type GenerationChange = z.infer<typeof generationChangedSchema>

const fsChangedSchema = z.object({
  changes: z.array(
    z.object({
      path: z.string(),
      change: z.enum(['created', 'modified', 'deleted']),
    }),
  ),
})

export type FsChange = z.infer<typeof fsChangedSchema>['changes'][number]

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)

export type SessionRow = z.output<typeof zConversationOut>

export type SessionUpdate =
  | { kind: 'title'; conversationId: string; title: string; ownerUserId: string }
  | {
      kind: 'activity'
      conversationId: string
      busy: boolean
      pendingInteraction: 'none' | 'approval' | 'question'
      lastTurnReason: 'completed' | 'failed' | 'aborted' | null
      ownerUserId: string
    }
  | {
      kind: 'created' | 'updated'
      conversationId: string
      row: SessionRow
      ownerUserId: string
    }
  | { kind: 'deleted'; conversationId: string; ownerUserId: string }
  | {
      kind: 'generation'
      conversationId: string | null
      jobId: string
      jobKind: GenerationChange['kind']
      operation: GenerationChange['operation']
      status: GenerationChange['status']
      metadata: Record<string, unknown> | null
      ownerUserId: string
    }
  | { kind: 'reconnected' }

export interface ConnectionHealth {
  connected: boolean
  stale: boolean
}

interface FsWatch {
  paths: readonly string[]
  recursive: boolean
  handler: (changes: readonly FsChange[]) => void
}

const watchCovers = (watch: FsWatch, path: string): boolean =>
  watch.paths.some((watched) => {
    if (watched === path) return true
    if (watched !== '' && !path.startsWith(`${watched}/`)) return false
    const inside = watched === '' ? path : path.slice(watched.length + 1)
    return watch.recursive || !inside.includes('/')
  })

interface AgentSubscription {
  handlers: TranscriptHandlers
  grade: TranscriptGrade
}

interface Subscription {
  agents: Map<string, AgentSubscription>
  watermarks: Map<string, StreamWatermark>
}

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

  private pending = new Map<string, PendingSubscribe>()

  private fsWatches = new Map<string, Set<FsWatch>>()

  private sessionWatchers = new Set<(update: SessionUpdate) => void>()

  private readonly options: TranscriptConnectionOptions

  constructor(options: TranscriptConnectionOptions) {
    this.options = options
  }

  connect(): void {
    if (this.socket !== null) return
    this.closed = false
    this.lastActivityAt = this.now()
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url)
    this.socket = socket
    socket.onmessage = (event) => {
      this.lastActivityAt = this.now()
      this.receive(event.data)
    }
    socket.onclose = () => this.dropped()
    socket.onerror = () => this.dropped()
  }

  close(): void {
    this.closed = true
    this.clearTimer()
    const socket = this.socket
    this.detach()
    socket?.close(1000)
  }

  reconnect(): void {
    if (this.closed) return
    this.clearTimer()
    const stale = this.socket
    this.detach()
    stale?.close(1000)
    this.reconnectAttempts = 0
    this.connect()
  }

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
    return () => {
      const current = this.fsWatches.get(conversationId)
      if (current === undefined || !current.delete(watch)) return
      if (current.size === 0) this.fsWatches.delete(conversationId)
    }
  }

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
        const envelope = conversationEnvelopeSchema.safeParse(frame)
        if (!envelope.success) return this.discard(frame.type, issuesOf(envelope.error))
        const parsed = titleSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: envelope.data.session_id,
          kind: 'title',
          ownerUserId: envelope.data.owner_user_id,
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
          ownerUserId: envelope.data.owner_user_id,
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
          ownerUserId: parsed.data.owner_user_id,
          row: parsed.data.payload,
        })
        return
      }
      case 'event.session.deleted': {
        const parsed = conversationEnvelopeSchema.safeParse(frame)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: parsed.data.session_id,
          kind: 'deleted',
          ownerUserId: parsed.data.owner_user_id,
        })
        return
      }
      case 'event.generation.changed': {
        const envelope = sessionEnvelopeSchema.safeParse(frame)
        if (!envelope.success) return this.discard(frame.type, issuesOf(envelope.error))
        const parsed = generationChangedSchema.safeParse(frame.payload)
        if (!parsed.success) return this.discard(frame.type, issuesOf(parsed.error))
        this.announce({
          conversationId: typeof frame.session_id === 'string' ? frame.session_id : null,
          jobId: parsed.data.id,
          jobKind: parsed.data.kind,
          kind: 'generation',
          metadata: parsed.data.metadata ?? null,
          operation: parsed.data.operation,
          ownerUserId: envelope.data.owner_user_id,
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
        this.apply(frame.type, subscription, frame.stream_epoch, frame.payload)
        return
      }
      default:
        return
    }
  }

  private announce(update: SessionUpdate): void {
    for (const watcher of this.sessionWatchers) watcher(update)
  }

  private discard(type: string | undefined, issues: readonly string[]): void {
    console.warn('丢弃不合协议的 WebSocket 帧', { issues, type })
  }

  private apply(type: string, subscription: Subscription, epoch: string, event: unknown): void {
    if (type === 'transcript.reset') {
      const parsed = transcriptResetEventSchema.safeParse(event)
      if (!parsed.success) return this.discard(type, issuesOf(parsed.error))
      const { agent_id, snapshot, has_more_older, seq } = parsed.data
      const agent = subscription.agents.get(agent_id)
      if (agent === undefined) return
      const full = { ...snapshot, hasMoreOlder: has_more_older } as AgentTranscriptSnapshot
      agent.handlers.onReset(agent_id, full, seq, epoch)
      if (seq !== undefined) subscription.watermarks.set(agent_id, { epoch, seq })
      return
    }
    const parsed = transcriptOpsEventSchema.safeParse(event)
    if (!parsed.success) return this.discard(type, issuesOf(parsed.error))
    const { agent_id, ops, seq } = parsed.data
    const agent = subscription.agents.get(agent_id)
    if (agent === undefined) return
    const accepted = agent.handlers.onOps(agent_id, ops, seq, epoch)
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
      this.subscriptions.delete(asked.conversationId)
      for (const agent of subscription.agents.values()) agent.handlers.onNotFound?.()
      return
    }
    if (frame.code !== 404) return
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
    if (reopened) this.announce({ kind: 'reconnected' })
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

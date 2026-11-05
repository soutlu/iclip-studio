import { http, HttpResponse } from 'msw'
import {
  AgentTranscript,
  filterOpsForGrade,
  type AgentTranscriptSnapshot,
  type TranscriptGrade,
  type TranscriptOperation,
} from '@/shared/transcript/vendor'

interface Stream {
  epoch: string
  seq: number
  journal: { seq: number; ops: readonly TranscriptOperation[] }[]
  store: AgentTranscript
  title: string
}

export interface TranscriptAccess {
  viewer: () => string | null
  canView: (viewer: string | null, conversationId: string) => boolean
}

interface ClientFrame {
  type?: string
  id?: string
  payload?: {
    session_id?: string
    agent_ids?: string[]
    transcript?: Record<string, TranscriptGrade>
    transcript_since?: Record<string, number>
    transcript_epoch?: Record<string, string>
  }
}

const SERVER_HELLO = {
  payload: {
    capabilities: { compression: false, event_batching: false },
    heartbeat_ms: 10_000,
    protocol_version: 2,
    ws_connection_id: 'fake',
  },
  timestamp: '2026-10-30T08:00:00+00:00',
  type: 'server_hello',
}

const keyOf = (conversationId: string, agentId: string) => `${conversationId}/${agentId}`

let epochCounter = 0
const mintEpoch = () => {
  epochCounter += 1
  return `epoch-${epochCounter}`
}

class ServerSocket {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly received: ClientFrame[] = []
  readonly grades = new Map<string, TranscriptGrade>()
  readonly viewer: string | null
  private readonly server: FakeTranscriptServer

  constructor(server: FakeTranscriptServer) {
    this.server = server
    this.viewer = server.viewerNow()
    this.push(SERVER_HELLO)
  }

  send(raw: string): void {
    const frame = JSON.parse(raw) as ClientFrame
    this.received.push(frame)
    this.server.handle(this, frame)
  }

  close(): void {
    this.readyState = 3
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }

  push(frame: unknown): void {
    setTimeout(() => {
      if (this.readyState !== 1) return
      this.onmessage?.({ data: JSON.stringify(frame) })
    }, 0)
  }
}

export interface SeedStream {
  items: AgentTranscriptSnapshot['items']
  meta?: AgentTranscriptSnapshot['meta']
  prompts?: AgentTranscriptSnapshot['prompts']
  interactions?: AgentTranscriptSnapshot['interactions']
  title?: string
}

export class FakeTranscriptServer {
  private readonly streams = new Map<string, Stream>()
  private readonly sockets: ServerSocket[] = []
  readonly window: number
  readonly pageRequests: { conversationId: string; agentId: string; beforeTurn: string | null }[] =
    []

  private gate: Promise<void> | null = null
  private readonly access: TranscriptAccess | undefined

  constructor({ window = 2000, access }: { window?: number; access?: TranscriptAccess } = {}) {
    this.window = window
    this.access = access
  }

  holdPages(): () => void {
    let release = () => {}
    this.gate = new Promise<void>((resolve) => {
      release = () => {
        this.gate = null
        resolve()
      }
    })
    return release
  }

  dropConnections(): void {
    for (const socket of this.sockets) socket.drop()
  }

  seed(conversationId: string, agentId: string, seed: SeedStream): void {
    const store = new AgentTranscript(agentId)
    store.apply([
      {
        agentId,
        op: 'reset',
        snapshot: {
          attachments: [],
          interactions: seed.interactions ?? [],
          items: seed.items,
          meta: seed.meta ?? { activity: 'idle' },
          prompts: seed.prompts ?? [],
          tasks: [],
          todos: [],
        },
      },
    ])
    this.streams.set(keyOf(conversationId, agentId), {
      epoch: mintEpoch(),
      journal: [],
      seq: 0,
      store,
      title: seed.title ?? '',
    })
  }

  stream(conversationId: string, agentId = 'main'): Stream {
    const stream = this.streams.get(keyOf(conversationId, agentId))
    if (stream === undefined) throw new Error(`没有这条流：${conversationId}/${agentId}`)
    return stream
  }

  readonly createSocket = (): WebSocket => {
    const socket = new ServerSocket(this)
    this.sockets.push(socket)
    return socket as unknown as WebSocket
  }

  connections(): { viewer: string | null; open: boolean; received: readonly ClientFrame[] }[] {
    return this.sockets.map((socket) => ({
      open: socket.readyState === 1,
      received: socket.received,
      viewer: socket.viewer,
    }))
  }

  received(type?: string): ClientFrame[] {
    return this.sockets
      .flatMap((socket) => socket.received)
      .filter((frame) => type === undefined || frame.type === type)
  }

  push(
    conversationId: string,
    agentId: string,
    ops: readonly TranscriptOperation[],
    { deliver = true }: { deliver?: boolean } = {},
  ): number {
    const stream = this.stream(conversationId, agentId)
    stream.seq += 1
    const seq = stream.seq
    stream.store.apply(ops)
    stream.journal.push({ ops, seq })
    if (stream.journal.length > this.window) stream.journal.shift()
    if (!deliver) return seq
    for (const socket of this.sockets) {
      const grade = socket.grades.get(keyOf(conversationId, agentId))
      if (grade === undefined || socket.readyState !== 1) continue
      const filtered = filterOpsForGrade(grade, ops)
      if (filtered.length === 0) continue
      socket.push(this.opsFrame(conversationId, agentId, stream, seq, filtered))
    }
    return seq
  }

  broadcast(frame: unknown): void {
    for (const socket of this.sockets) if (socket.readyState === 1) socket.push(frame)
  }

  restart(): void {
    for (const stream of this.streams.values()) {
      stream.epoch = mintEpoch()
      stream.seq = 0
      stream.journal = []
    }
    for (const socket of this.sockets) {
      socket.grades.clear()
      socket.drop()
    }
  }

  handlers() {
    return [
      http.get('*/api/conversations/:conversationId/transcript', async ({ params, request }) => {
        const conversationId = String(params['conversationId'])
        const query = new URL(request.url).searchParams
        const agentId = query.get('agent_id') ?? 'main'
        const beforeTurn = query.get('before_turn')
        this.pageRequests.push({ agentId, beforeTurn, conversationId })
        if (this.gate !== null) await this.gate
        const stream = this.streams.get(keyOf(conversationId, agentId))
        if (stream === undefined || !this.visible(this.viewerNow(), conversationId)) {
          return HttpResponse.json({ detail: '这段对话不存在' }, { status: 404 })
        }
        const pageSize = Number(query.get('page_size') ?? 20)
        const snapshot = stream.store.snapshot()
        const turns = snapshot.items.filter((item) => item.kind === 'turn')
        const end =
          beforeTurn === null
            ? turns.length
            : turns.findIndex((item) => item.kind === 'turn' && item.turnId === beforeTurn)
        const start = Math.max(0, end - pageSize)
        return HttpResponse.json({
          agent_id: agentId,
          agents: [{ agentId: 'main', type: 'main' }],
          has_more: start > 0,
          interactions: snapshot.interactions,
          items: turns.slice(start, end),
          meta: snapshot.meta,
          owner_user_id: null,
          pending_interactions: stream.store.listPendingInteractions(),
          prompts: snapshot.prompts,
          seq: stream.seq,
          stream_epoch: stream.epoch,
          tasks: [],
          title: stream.title,
          todos: [],
        })
      }),
    ]
  }

  viewerNow(): string | null {
    return this.access?.viewer() ?? null
  }

  handle(socket: ServerSocket, frame: ClientFrame): void {
    if (frame.type === 'pong') return
    if (frame.type === 'unsubscribe_v2') {
      const conversationId = frame.payload?.session_id ?? ''
      const agents = frame.payload?.agent_ids
      for (const key of [...socket.grades.keys()]) {
        const [conversation, agent] = key.split('/')
        if (conversation !== conversationId) continue
        if (agents === undefined || agents.includes(agent ?? '')) socket.grades.delete(key)
      }
      socket.push({ id: frame.id, type: 'ack' })
      return
    }
    if (frame.type !== 'subscribe_v2') return
    const conversationId = frame.payload?.session_id ?? ''
    const table = frame.payload?.transcript ?? {}
    const known =
      [...this.streams.keys()].some((key) => key.startsWith(`${conversationId}/`)) &&
      this.visible(socket.viewer, conversationId)
    if (!known) {
      socket.push({ id: frame.id, payload: { not_found: [conversationId] }, type: 'ack' })
      return
    }
    const agents = Object.keys(table)
    if (agents.some((agentId) => !this.streams.has(keyOf(conversationId, agentId)))) {
      socket.push({ code: 404, id: frame.id, msg: 'agent not in session', type: 'ack' })
      return
    }
    for (const agentId of agents) {
      const stream = this.stream(conversationId, agentId)
      const grade = table[agentId] ?? 'off'
      socket.grades.set(keyOf(conversationId, agentId), grade)
      if (grade === 'off') continue
      const since = frame.payload?.transcript_since?.[agentId]
      const epoch = frame.payload?.transcript_epoch?.[agentId]
      const replay = this.since(stream, since, epoch)
      if (replay === null) {
        socket.push(this.resetFrame(conversationId, agentId, stream))
        continue
      }
      for (const batch of replay) {
        const filtered = filterOpsForGrade(grade, batch.ops)
        if (filtered.length > 0) {
          socket.push(this.opsFrame(conversationId, agentId, stream, batch.seq, filtered))
        }
      }
    }
    socket.push({ id: frame.id, payload: { accepted: [conversationId] }, type: 'ack' })
  }

  private visible(viewer: string | null, conversationId: string): boolean {
    return this.access === undefined || this.access.canView(viewer, conversationId)
  }

  private since(
    stream: Stream,
    since: number | undefined,
    epoch: string | undefined,
  ): Stream['journal'] | null {
    if (since === undefined || epoch !== stream.epoch) return null
    if (since > stream.seq) return null
    const wanted = stream.journal.filter((batch) => batch.seq > since)
    if (wanted.length === 0) return []
    return (wanted[0]?.seq ?? 0) <= since + 1 ? wanted : null
  }

  private resetFrame(conversationId: string, agentId: string, stream: Stream) {
    const snapshot = stream.store.snapshot()
    return {
      payload: {
        agent_id: agentId,
        has_more_older: snapshot.items.length > 0,
        seq: stream.seq,
        snapshot: { ...snapshot, hasMoreOlder: snapshot.items.length > 0, items: [] },
        type: 'transcript.reset',
      },
      session_id: conversationId,
      stream_epoch: stream.epoch,
      timestamp: new Date().toISOString(),
      type: 'transcript.reset',
    }
  }

  private opsFrame(
    conversationId: string,
    agentId: string,
    stream: Stream,
    seq: number,
    ops: readonly TranscriptOperation[],
  ) {
    return {
      payload: { agent_id: agentId, ops, seq, type: 'transcript.ops' },
      session_id: conversationId,
      stream_epoch: stream.epoch,
      timestamp: new Date().toISOString(),
      type: 'transcript.ops',
    }
  }
}

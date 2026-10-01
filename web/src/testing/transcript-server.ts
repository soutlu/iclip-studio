/**
 * 照后端订阅语义应答的假服务端，单测用它代替只会记帧的 FakeSocket：REST 页与 WebSocket 共用同一份流状态。
 *
 * 规则与 server/src/iclip/harness/transcript/{store,subscription}.py 一致：
 * - 不带水位、epoch 缺失或对不上、水位超前、要的批次已出日志窗口：只回一帧不带历史轮的 reset；
 * - 否则补发水位之后的批次；之后按档位过滤实时推送，筛空的批次整批不发；
 * - 表里有不属于这段对话的 agent：整帧回 ack code 404；对话不存在：ack 的 not_found 里带上它。
 * restart() 模拟服务重启：每条流换新 epoch、批次号从头编，已持久化的内容（页里的轮）保留，连接全部断开。
 */

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
  /** 服务端持有的当前内容：页由它切出来，推送的批次也先落到它上面。 */
  store: AgentTranscript
  /** 页顶层的信封字段。 */
  title: string
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
  payload: { heartbeat_ms: 10_000, protocol_version: 2, ws_connection_id: 'fake' },
  type: 'server_hello',
}

const keyOf = (conversationId: string, agentId: string) => `${conversationId}/${agentId}`

let epochCounter = 0
const mintEpoch = () => {
  epochCounter += 1
  return `epoch-${epochCounter}`
}

/** 一条连接的服务端一侧。 */
class ServerSocket {
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly received: ClientFrame[] = []
  /** 这条连接订了哪些流、各自什么档位。 */
  readonly grades = new Map<string, TranscriptGrade>()
  private readonly server: FakeTranscriptServer

  constructor(server: FakeTranscriptServer) {
    this.server = server
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

  /** 服务端断开这条连接，客户端照常退避重连。 */
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }

  /** 网络上的一帧：下一个宏任务才到，帧与帧之间微任务已清空。 */
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
  /** 每条流补发日志的窗口（后端 JOURNAL_CAPACITY）。 */
  readonly window: number
  /** 每次 GET transcript 记一条，断言请求次数用。 */
  readonly pageRequests: { conversationId: string; agentId: string; beforeTurn: string | null }[] =
    []

  /** 不为空时，页请求等它放行才回，用来制造「读取在途」。 */
  private gate: Promise<void> | null = null

  constructor({ window = 2000 }: { window?: number } = {}) {
    this.window = window
  }

  /** 之后的页请求先挂起，调返回的函数一起放行。 */
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

  /** 断开所有连接但不重启：流的 epoch 与日志都还在，客户端重连后应能接着补。 */
  dropConnections(): void {
    for (const socket of this.sockets) socket.drop()
  }

  /** 建一条流：给定已有的轮，批次号从 0 起。 */
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

  /** 给连接用的 createSocket。 */
  readonly createSocket = (): WebSocket => {
    const socket = new ServerSocket(this)
    this.sockets.push(socket)
    return socket as unknown as WebSocket
  }

  /** 所有连接收到的客户端帧。 */
  received(type?: string): ClientFrame[] {
    return this.sockets
      .flatMap((socket) => socket.received)
      .filter((frame) => type === undefined || frame.type === type)
  }

  /** 服务端产出一批：落到内容上、记进日志、推给订了这条流的连接。deliver=false 模拟这批在路上丢了。 */
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

  /** 直接给所有连接发一帧，用于构造服务端不会自己发的场景。 */
  broadcast(frame: unknown): void {
    for (const socket of this.sockets) if (socket.readyState === 1) socket.push(frame)
  }

  /** 服务重启：每条流换 epoch、批次号归零、日志清空；内容保留（已持久化），连接全部断开。 */
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

  /** REST 页：最新一页或 before_turn 之前的一页，带当前水位与 epoch。 */
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
        if (stream === undefined) {
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

  /** @internal 连接收到客户端帧。 */
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
    const known = [...this.streams.keys()].some((key) => key.startsWith(`${conversationId}/`))
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

  /** 能补就给出要补的批次，补不了（该回 reset）给 null。 */
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
      },
      seq: 0,
      session_id: conversationId,
      stream_epoch: stream.epoch,
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
      payload: { agent_id: agentId, ops, seq },
      seq: 0,
      session_id: conversationId,
      stream_epoch: stream.epoch,
      type: 'transcript.ops',
    }
  }
}

import { http, HttpResponse, ws } from 'msw'
import { mockAuthUser } from './auth-user'
import { type MockConversation, mockConversationOwner, mockSessionEnvelope } from './conversations'
import { SHOTS_MOCK_PATH, touchMockShots, watchMockGenerations } from './workspace'

const HISTORY_TURNS = 2

const HISTORY_SEQ = 10

export const MOCK_STREAM_EPOCH = 'mock-stream'

export const MOCK_LONG_CONVERSATION_ID = '0199aaaa-0000-7000-8000-0000000000aa'
const LONG_HISTORY_TURNS = 14

const DEMO_CHUNKS = [
  '好的，我先看一下这段素材：\n\n',
  '- 拆出 3 个镜头\n- 写进 `shots/storyboard.md`\n\n',
  '生成参数也定好了：\n\n```json\n{\n  "shots": 3,\n  "fps": 5,\n  "ratio": "9:16"\n}\n```\n\n',
  '**镜头表已经更新。**\n\n<details><summary>看设定</summary>\n\n| 镜头 | 时长 |\n| --- | --- |\n| S01 | 2.4s |\n\n</details>',
]

const DEMO_THINKING = '先看看目录里已经有哪些镜头，再决定补哪几条。'

const DEMO_IMAGE_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1e8d6'/%3E%3Ccircle cx='160' cy='90' r='48' fill='%23006d42'/%3E%3C/svg%3E"

const DEMO_FRAME_URLS = [
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23e8dfd1'/%3E%3Crect x='96' y='54' width='128' height='72' fill='%23a8742a'/%3E%3C/svg%3E",
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23d1dfe8'/%3E%3Cpolygon points='160,40 240,140 80,140' fill='%232a5f8a'/%3E%3C/svg%3E",
]

const BEAT_MS = 500

const FS_CHANGE_DELAY_MS = 5000

const WORK_DONE_DELAY_MS = 2000

type Batch = unknown[]

type Connection = {
  conversationId: string
  agents: Set<string>
  send: (payload: { agent_id: string; ops: Batch; seq: number }) => void
}

const replayFrom = (
  conversationId: string,
  agentId: string,
  since: number | undefined,
  epoch: string | undefined,
): { ops: Batch; seq: number }[] | null => {
  if (since === undefined || epoch !== MOCK_STREAM_EPOCH) return null
  const key = streamKey(conversationId, agentId)
  const current = seqOf.get(key) ?? HISTORY_SEQ
  if (since < HISTORY_SEQ || since > current) return null
  return (logOf.get(key) ?? []).filter((batch) => batch.seq > since)
}

const connections = new Set<Connection>()

let turns = HISTORY_TURNS

const streamKey = (conversationId: string, agentId: string) => `${conversationId}/${agentId}`
const seqOf = new Map<string, number>()
const logOf = new Map<string, { ops: Batch; seq: number }[]>()

export const MOCK_CHILD_AGENT = 'shot-writer'
export const MOCK_CHILD_TASK = '写第 3 组的三个镜头'
export const MOCK_CHILD_REPLY = 'S3-1 特写：鞋头压过水面；S3-2 中景：起跑；S3-3 全景：冲线。'
export const MOCK_HISTORY_CHILD = 't2-child'
export const MOCK_HISTORY_DELEGATE_CALL = 'call_t2_delegate'

const HISTORY_CHILD = { done: true, text: MOCK_CHILD_REPLY }

const children = new Map<string, { text: string; done: boolean }>([
  [MOCK_HISTORY_CHILD, HISTORY_CHILD],
])

type PromptContent =
  { type: 'text'; text: string } | { type: 'image' | 'video'; source: { kind: 'url'; url: string } }

type Prompt = { promptId: string; text: string; content: PromptContent[] }

type Active = Prompt & { ordinal: number; turnId: string }

const running = new Map<string, Active>()
const queues = new Map<string, Prompt[]>()

const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

const awaitingApproval = new Set<string>()

const justFinished = new Set<MockConversation>()

export type MockShowcase = {
  title: string
  turns: () => (Record<string, unknown> & { turnId: string })[]
  interactions?: readonly unknown[]
  tasks?: () => readonly unknown[]
  activity?: 'idle' | 'turn'
}

const showcases = new Map<string, MockShowcase>()

export const markMockShowcase = (conversationId: string, showcase: MockShowcase) => {
  showcases.set(conversationId, showcase)
}

export type MockScript = (turn: { turnId: string }) => Lazy[]

const scripts = new Map<string, MockScript>()

export const markMockScript = (conversationId: string, script: MockScript) => {
  scripts.set(conversationId, script)
}

export const markMockJustFinished = (conversation: MockConversation) => {
  justFinished.add(conversation)
}

const decisions = new Map<string, boolean>()

export const resetMockTranscript = () => {
  for (const handles of timers.values()) for (const handle of handles) clearTimeout(handle)
  timers.clear()
  connections.clear()
  turns = HISTORY_TURNS
  seqOf.clear()
  logOf.clear()
  children.clear()
  children.set(MOCK_HISTORY_CHILD, HISTORY_CHILD)
  running.clear()
  queues.clear()
  awaitingApproval.clear()
  justFinished.clear()
  showcases.clear()
  scripts.clear()
  decisions.clear()
}

const APPROVAL_TURN_ID = 'ta'
const APPROVAL_STEP_ID = `${APPROVAL_TURN_ID}.1`
const APPROVAL_INTERACTION_ID = 'appr_1'
const APPROVAL_TOOL_CALL_ID = 'call_cover'
const APPROVAL_PROMPT_ID = 'p_cover'
const APPROVAL_PROMPT_TEXT = '把这两张镜头帧拼成封面'

export const markMockAwaitingApproval = (conversationId: string) => {
  awaitingApproval.add(conversationId)
  running.set(conversationId, {
    content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
    ordinal: 3,
    promptId: APPROVAL_PROMPT_ID,
    text: APPROVAL_PROMPT_TEXT,
    turnId: APPROVAL_TURN_ID,
  })
}

const APPROVAL_DOCUMENT = [
  '# 封面',
  '',
  '两张镜头帧拼版，主图在左。',
  '',
  '## 画面',
  '',
  '- 左：镜头 1 的亚麻衬衫袖口特写，占画面三分之二',
  '- 右：镜头 2 的户外全景，压暗两档做衬底',
  '- 品牌字样放在右下角，不压住衬衫',
  '',
  '## 文字',
  '',
  '标题「夏季亚麻」用粗体，副标题写「轻、透、松弛」。',
  '',
  '## 尺寸',
  '',
  '竖版 9:16，导出 1080 × 1920，另存一张 1:1 给商品页。',
].join('\n')

const approvalFrame = (state: 'running' | 'done' | 'error') => ({
  approvalId: APPROVAL_INTERACTION_ID,
  display: {
    content: APPROVAL_DOCUMENT,
    kind: 'file_io',
    operation: 'write',
    path: 'shots/cover.md',
  },
  frameId: `${APPROVAL_STEP_ID}.f4`,
  input: { path: 'shots/cover.md', text: APPROVAL_DOCUMENT },
  kind: 'tool',
  name: 'write_file',
  state,
  toolCallId: APPROVAL_TOOL_CALL_ID,
  ...(state === 'done' ? { output: '已写入 17 行' } : {}),
  ...(state === 'error' ? { error: '你拒绝了这一步' } : {}),
})

const approvalTurn = () => ({
  kind: 'turn',
  ordinal: 3,
  origin: { kind: 'user' },
  content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
  startedAt: '2026-08-31T02:10:00Z',
  state: 'running',
  steps: [
    {
      frames: [
        {
          display: { kind: 'skill_call', skill_name: '分镜脚本', args: '镜头节奏.md' },
          frameId: `${APPROVAL_STEP_ID}.f1`,
          kind: 'tool',
          name: 'get_skill_reference',
          output: '一条镜头一个动作；封面取全片最亮的那一帧。',
          state: 'done',
          toolCallId: 'call_skill',
        },
        {
          frameId: `${APPROVAL_STEP_ID}.f2`,
          kind: 'text',
          role: 'assistant',
          text: '两张镜头帧出好了：',
        },
        {
          display: { detail: '镜头 1、2', kind: 'generic', summary: '生成画面' },
          frameId: `${APPROVAL_STEP_ID}.f3`,
          kind: 'tool',
          metadata: {
            items: [
              { caption: 'S1-1', url: DEMO_FRAME_URLS[0] },
              { caption: 'S2-1', url: DEMO_FRAME_URLS[1] },
            ],
            note: '2 张 · dev 渠道',
          },
          name: 'generate_shot_frames',
          output: '生成完成 2 帧（dev 渠道），版记录见 frames/grids/job-1.json。',
          state: 'done',
          toolCallId: 'call_frames',
          view: 'media_grid',
        },
        approvalFrame('running'),
      ],
      kind: 'step',
      ordinal: 1,
      startedAt: '2026-08-31T02:10:00Z',
      state: 'running',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
  ],
  turnId: APPROVAL_TURN_ID,
})

const pendingApproval = {
  interactionId: APPROVAL_INTERACTION_ID,
  interactionKind: 'approval',
  state: 'pending',
  toolCallId: APPROVAL_TOOL_CALL_ID,
}

const delegateCard = (
  toolCallId: string,
  childId: string,
  stepId: string,
  state: 'running' | 'done',
) => ({
  agentRefs: [{ agentId: childId, role: 'child' }],
  display: { agent_name: MOCK_CHILD_AGENT, kind: 'agent_call', prompt: MOCK_CHILD_TASK },
  frameId: `${stepId}.${toolCallId}`,
  kind: 'tool',
  name: 'delegate_task',
  ...(state === 'done' ? { output: MOCK_CHILD_REPLY } : {}),
  state,
  toolCallId,
})

const childTurn = (childId: string) => {
  const child = children.get(childId) ?? { done: false, text: '' }
  return {
    content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
    kind: 'turn',
    ordinal: 1,
    origin: { kind: 'user' },
    startedAt: '2026-08-31T02:00:00Z',
    state: child.done ? 'completed' : 'running',
    ...(child.done ? { durationMs: 6400, endedAt: '2026-08-31T02:00:06Z' } : {}),
    steps: [
      {
        frames: [
          { frameId: 't1.1.f1', kind: 'thinking', text: '先定每一镜的景别。' },
          ...(child.text === ''
            ? []
            : [{ frameId: 't1.1.f2', kind: 'text', role: 'assistant', text: child.text }]),
        ],
        kind: 'step',
        ordinal: 1,
        startedAt: '2026-08-31T02:00:00Z',
        state: child.done ? 'completed' : 'running',
        stepId: 't1.1',
        turnId: 't1',
      },
    ],
    turnId: 't1',
  }
}

export const mockChildPage = (conversationId: string, childId: string) => ({
  agent_id: childId,
  agents: [
    { agentId: 'main', type: 'main' },
    { agentId: childId, label: MOCK_CHILD_AGENT, parentAgentId: 'main', type: 'sub' },
  ],
  has_more: false,
  interactions: [],
  items: [childTurn(childId)],
  meta: { activity: children.get(childId)?.done === false ? 'turn' : 'idle' },
  owner_user_id: mockConversationOwner(conversationId),
  pending_interactions: [],
  prompts: [],
  seq: seqOf.get(streamKey(conversationId, childId)) ?? HISTORY_SEQ,
  stream_epoch: MOCK_STREAM_EPOCH,
  tasks: [],
  title: '',
  todos: [],
})

const pageOf = <T extends { turnId: string }>(
  turns: readonly T[],
  { beforeTurn, pageSize }: { beforeTurn?: string | null; pageSize?: number },
): { items: T[]; hasMore: boolean } => {
  const end =
    beforeTurn === undefined || beforeTurn === null
      ? turns.length
      : turns.findIndex((item) => item.turnId === beforeTurn)
  const start = Math.max(0, end - (pageSize ?? turns.length))
  return { hasMore: start > 0, items: turns.slice(start, end) }
}

export const mockTranscriptPage = (
  conversationId = '',
  request: { beforeTurn?: string | null; pageSize?: number } = {},
) => {
  const awaiting = awaitingApproval.has(conversationId)
  const showcase = showcases.get(conversationId)
  const history = showcase
    ? showcase.turns()
    : conversationId === MOCK_LONG_CONVERSATION_ID
      ? Array.from({ length: LONG_HISTORY_TURNS }, (_, index) => longTurn(index + 1))
      : Array.from({ length: HISTORY_TURNS }, (_, index) => historyTurn(index + 1))
  const page = pageOf([...history, ...(awaiting ? [approvalTurn()] : [])], request)
  return {
    agent_id: 'main',
    agents: [{ agentId: 'main', type: 'main' }],
    has_more: page.hasMore,
    interactions: awaiting ? [pendingApproval] : (showcase?.interactions ?? []),
    items: page.items,
    meta: {
      activity: awaiting ? 'turn' : (showcase?.activity ?? 'idle'),
      agent: { contextTokens: 32768, contextUsage: 0.03125, maxContextTokens: 1048576 },
    },
    owner_user_id: mockConversationOwner(conversationId),
    pending_interactions: awaiting ? [APPROVAL_INTERACTION_ID] : [],
    prompts: awaiting
      ? [
          {
            content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
            createdAt: '2026-08-31T02:10:00Z',
            promptId: APPROVAL_PROMPT_ID,
            status: 'running',
          },
        ]
      : [],
    seq: HISTORY_SEQ,
    stream_epoch: MOCK_STREAM_EPOCH,
    tasks: showcase?.tasks?.() ?? [],
    title: showcase
      ? showcase.title
      : conversationId === MOCK_LONG_CONVERSATION_ID
        ? '长对话回看'
        : '夜景延时素材生成',
    todos: [],
  }
}

const longTurn = (ordinal: number) => ({
  content: [{ text: `长对话第 ${ordinal} 问`, type: 'text' }],
  durationMs: 1200,
  endedAt: '2026-08-30T01:00:00Z',
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  startedAt: '2026-08-30T01:00:00Z',
  state: 'completed',
  steps: [
    {
      frames: [
        {
          frameId: `t${ordinal}.1.f1`,
          kind: 'text',
          role: 'assistant',
          text: `长对话第 ${ordinal} 轮的回复。`,
        },
      ],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: `t${ordinal}.1`,
      turnId: `t${ordinal}`,
    },
  ],
  triggerPromptId: `p_long_${ordinal}`,
  turnId: `t${ordinal}`,
})

const historyTurn = (ordinal: number) => ({
  durationMs: 4200,
  endedAt: '2026-08-31T02:00:0'.concat(String(ordinal), 'Z'),
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  content:
    ordinal === 1
      ? [
          { text: '参考这张图：', type: 'text' },
          { source: { kind: 'url', url: DEMO_IMAGE_URL }, type: 'image' },
          { text: '\n第 1 个问题', type: 'text' },
        ]
      : [{ text: `第 ${ordinal} 个问题`, type: 'text' }],
  startedAt: '2026-08-31T01:59:5'.concat(String(ordinal), 'Z'),
  state: 'completed',
  triggerPromptId: `p_t${ordinal}`,
  steps: [
    {
      frames: [
        ...(ordinal === HISTORY_TURNS
          ? [
              {
                display: { kind: 'file_io', operation: 'read', path: 'shots/storyboard.md' },
                frameId: `t${ordinal}.1.f2`,
                kind: 'tool',
                metadata: { lines: 3, path: 'shots/storyboard.md', truncated: false },
                name: 'read_file',
                output: '     1\t# 分镜\n     2\t\n     3\t## 镜头 1 · 产品特写 · 2.4s',
                state: 'done',
                toolCallId: `call_${ordinal}`,
                view: 'file_content',
              },
              delegateCard(MOCK_HISTORY_DELEGATE_CALL, MOCK_HISTORY_CHILD, `t${ordinal}.1`, 'done'),
            ]
          : []),
        {
          frameId: `t${ordinal}.1.f3`,
          kind: 'text',
          role: 'assistant',
          text: `这是第 ${ordinal} 轮的回复。`,
        },
      ],
      kind: 'step',
      ordinal: 1,
      state: 'completed',
      stepId: `t${ordinal}.1`,
      turnId: `t${ordinal}`,
    },
  ],
  usage: { cachedTokens: 4910, inputTokens: 12340, outputTokens: 1214 },
  turnId: `t${ordinal}`,
})

const socket = ws.link('*/api/ws')

export const transcriptHandlers = [
  http.get('*/api/conversations/:conversationId/transcript', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const query = new URL(request.url).searchParams
    const agentId = query.get('agent_id') ?? 'main'
    const pageSize = query.get('page_size')
    if (agentId === 'main') {
      return HttpResponse.json(
        mockTranscriptPage(conversationId, {
          beforeTurn: query.get('before_turn'),
          ...(pageSize === null ? {} : { pageSize: Number(pageSize) }),
        }),
      )
    }
    if (!children.has(agentId)) {
      return HttpResponse.json({ detail: '这段对话里没有这个 agent' }, { status: 404 })
    }
    return HttpResponse.json(mockChildPage(conversationId, agentId))
  }),

  http.post(
    '*/api/conversations/:conversationId/interactions/:interactionId',
    async ({ params, request }) => {
      const body = (await request.json()) as { approved: boolean }
      const conversationId = String(params['conversationId'])
      const interactionId = String(params['interactionId'])
      const key = `${conversationId}:${interactionId}`
      const decided = decisions.get(key)
      if (decided !== undefined) {
        return decided === body.approved
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json({ detail: '这张卡已经做过决定了' }, { status: 409 })
      }
      if (!awaitingApproval.has(conversationId) || interactionId !== APPROVAL_INTERACTION_ID) {
        return HttpResponse.json({ detail: '这张卡不在等回应' }, { status: 404 })
      }
      decisions.set(key, body.approved)
      awaitingApproval.delete(conversationId)
      settleApproval(conversationId, body.approved)
      return new HttpResponse(null, { status: 204 })
    },
  ),

  http.post('*/api/conversations/:conversationId/prompts', async ({ params, request }) => {
    const body = (await request.json()) as { content: PromptContent[]; prompt_id: string }
    const conversationId = String(params['conversationId'])
    const prompt = {
      content: body.content,
      promptId: body.prompt_id,
      text: body.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    }
    const busy = running.has(conversationId)
    if (busy) {
      queues.set(conversationId, [...(queues.get(conversationId) ?? []), prompt])
      broadcast(conversationId, [
        {
          op: 'prompt.upsert',
          prompt: {
            content: prompt.content,
            createdAt: new Date().toISOString(),
            promptId: prompt.promptId,
            status: 'queued',
          },
        },
      ])
    } else {
      playTurn(conversationId, prompt)
    }
    return HttpResponse.json({
      createdAt: new Date().toISOString(),
      promptId: prompt.promptId,
      status: busy ? 'queued' : 'running',
    })
  }),

  http.post('*/api/conversations/:conversationId/prompts:steer', async ({ params, request }) => {
    const body = (await request.json()) as { prompt_ids: string[] }
    const conversationId = String(params['conversationId'])
    const queue = queues.get(conversationId) ?? []
    const picked = queue.filter((prompt) => body.prompt_ids.includes(prompt.promptId))
    if (picked.length === 0)
      return HttpResponse.json({ detail: '这条已经不在队列里了' }, { status: 404 })
    queues.set(
      conversationId,
      queue.filter((prompt) => !body.prompt_ids.includes(prompt.promptId)),
    )
    for (const prompt of picked) steerInto(conversationId, prompt)
    return new HttpResponse(null, { status: 204 })
  }),

  // path-to-regexp 不支持 :promptId:abort 语法，需使用通配符路由并手动解析参数。
  http.post('*/api/conversations/:conversationId/prompts/*', ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const tail = new URL(request.url).pathname.split('/').pop() ?? ''
    const promptId = decodeURIComponent(tail).replace(/:abort$/, '')
    const queue = queues.get(conversationId) ?? []
    if (queue.some((prompt) => prompt.promptId === promptId)) {
      queues.set(
        conversationId,
        queue.filter((prompt) => prompt.promptId !== promptId),
      )
      broadcast(conversationId, [
        {
          op: 'prompt.upsert',
          prompt: {
            createdAt: new Date().toISOString(),
            promptId,
            status: 'aborted',
          },
        },
      ])
      return new HttpResponse(null, { status: 204 })
    }
    if (running.get(conversationId)?.promptId !== promptId) {
      return HttpResponse.json({ detail: '这条早就结束了' }, { status: 409 })
    }
    stopTurn(conversationId)
    return new HttpResponse(null, { status: 204 })
  }),

  socket.addEventListener('connection', ({ client }) => {
    client.send(
      JSON.stringify({
        payload: {
          capabilities: { compression: false, event_batching: false },
          heartbeat_ms: 10_000,
          protocol_version: 2,
          ws_connection_id: 'mock',
        },
        timestamp: new Date().toISOString(),
        type: 'server_hello',
      }),
    )

    setTimeout(() => {
      for (const conversation of justFinished) {
        conversation.lastRunId = crypto.randomUUID()
        conversation.completedAt = null
        client.send(
          JSON.stringify({
            ...mockSessionEnvelope(conversation.id),
            payload: { ...conversation },
            session_id: conversation.id,
            type: 'event.session.updated',
          }),
        )
        client.send(
          JSON.stringify({
            ...mockSessionEnvelope(conversation.id),
            payload: { busy: false, last_turn_reason: 'completed', pending_interaction: 'none' },
            session_id: conversation.id,
            type: 'event.session.work_changed',
          }),
        )
      }
    }, WORK_DONE_DELAY_MS)

    const joined = new Map<string, Connection>()
    const fsScheduled = new Set<string>()
    const scheduleShotsChange = (conversationId: string) => {
      if (fsScheduled.has(conversationId)) return
      fsScheduled.add(conversationId)
      setTimeout(() => {
        if (!joined.has(conversationId) || !touchMockShots(conversationId)) return
        client.send(
          JSON.stringify({
            payload: { changes: [{ change: 'modified', path: SHOTS_MOCK_PATH }] },
            session_id: conversationId,
            timestamp: new Date().toISOString(),
            type: 'event.fs.changed',
          }),
        )
      }, FS_CHANGE_DELAY_MS)
    }
    client.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const frame = JSON.parse(event.data) as {
        id?: string
        payload?: {
          agent_ids?: string[]
          session_id?: string
          transcript?: Record<string, string>
          transcript_epoch?: Record<string, string>
          transcript_since?: Record<string, number>
        }
        type?: string
      }

      if (frame.type === 'unsubscribe_v2') {
        const conversationId = frame.payload?.session_id ?? ''
        const connection = joined.get(conversationId)
        const agentIds = frame.payload?.agent_ids ?? []
        if (agentIds.length === 0) connection?.agents.clear()
        for (const agentId of agentIds) connection?.agents.delete(agentId)
        if (connection !== undefined && connection.agents.size === 0) {
          joined.delete(conversationId)
          connections.delete(connection)
        }
        client.send(JSON.stringify({ id: frame.id, type: 'ack' }))
        return
      }

      if (frame.type !== 'subscribe_v2') return
      const conversationId = frame.payload?.session_id ?? ''
      const agentIds = Object.keys(frame.payload?.transcript ?? { main: 'delta' })
      if (agentIds.some((agentId) => agentId !== 'main' && !children.has(agentId))) {
        client.send(
          JSON.stringify({ code: 404, id: frame.id, msg: 'agent not in session', type: 'ack' }),
        )
        return
      }
      for (const agentId of agentIds) {
        const replay = replayFrom(
          conversationId,
          agentId,
          frame.payload?.transcript_since?.[agentId],
          frame.payload?.transcript_epoch?.[agentId],
        )
        if (replay !== null) {
          for (const batch of replay) {
            client.send(
              JSON.stringify({
                payload: {
                  agent_id: agentId,
                  ops: batch.ops,
                  seq: batch.seq,
                  type: 'transcript.ops',
                },
                seq: 1,
                session_id: conversationId,
                stream_epoch: MOCK_STREAM_EPOCH,
                timestamp: new Date().toISOString(),
                type: 'transcript.ops',
              }),
            )
          }
          continue
        }
        client.send(
          JSON.stringify({
            payload: {
              agent_id: agentId,
              has_more_older: true,
              seq: seqOf.get(streamKey(conversationId, agentId)) ?? HISTORY_SEQ,
              snapshot: {
                attachments: [],
                interactions: [],
                items: [],
                meta: {},
                prompts: [],
                tasks: [],
                todos: [],
              },
              type: 'transcript.reset',
            },
            seq: 1,
            session_id: conversationId,
            stream_epoch: MOCK_STREAM_EPOCH,
            timestamp: new Date().toISOString(),
            type: 'transcript.reset',
          }),
        )
      }
      client.send(
        JSON.stringify({ id: frame.id, payload: { accepted: [conversationId] }, type: 'ack' }),
      )
      const existing = joined.get(conversationId)
      const connection: Connection = existing ?? {
        agents: new Set<string>(),
        conversationId,
        send: (payload) =>
          client.send(
            JSON.stringify({
              payload: { ...payload, type: 'transcript.ops' },
              seq: payload.seq,
              session_id: conversationId,
              stream_epoch: MOCK_STREAM_EPOCH,
              timestamp: new Date().toISOString(),
              type: 'transcript.ops',
            }),
          ),
      }
      for (const agentId of agentIds) connection.agents.add(agentId)
      if ((frame.payload?.transcript ?? { main: 'delta' })['main'] === 'delta') {
        scheduleShotsChange(conversationId)
      }
      if (existing !== undefined) return
      joined.set(conversationId, connection)
      connections.add(connection)
      if (
        !awaitingApproval.has(conversationId) &&
        !showcases.has(conversationId) &&
        conversationId !== MOCK_LONG_CONVERSATION_ID
      ) {
        playTurn(conversationId, {
          content: [{ text: '把这段素材拆一下', type: 'text' }],
          promptId: 'demo',
          text: '把这段素材拆一下',
        })
      }
    })

    const unwatchGenerations = watchMockGenerations(({ conversationId, ...payload }) => {
      const envelope =
        conversationId === null
          ? { owner_user_id: mockAuthUser.id, timestamp: new Date().toISOString() }
          : { ...mockSessionEnvelope(conversationId), session_id: conversationId }
      client.send(JSON.stringify({ ...envelope, payload, type: 'event.generation.changed' }))
    })

    client.addEventListener('close', () => {
      unwatchGenerations()
      for (const connection of joined.values()) connections.delete(connection)
    })
  }),
]

const broadcast = (conversationId: string, ops: Batch, agentId = 'main') => {
  const key = streamKey(conversationId, agentId)
  const seq = (seqOf.get(key) ?? HISTORY_SEQ) + 1
  seqOf.set(key, seq)
  logOf.set(key, [...(logOf.get(key) ?? []), { ops, seq }])
  const payload = { agent_id: agentId, ops, seq }
  for (const connection of connections) {
    if (connection.conversationId === conversationId && connection.agents.has(agentId)) {
      connection.send(payload)
    }
  }
}

type Lazy = Batch | (() => Batch)

type Scheduled = Lazy | { agent: string; ops: Lazy }

const resolve = (item: Scheduled): [string, Batch] => {
  if (!Array.isArray(item) && typeof item !== 'function') {
    return [item.agent, typeof item.ops === 'function' ? item.ops() : item.ops]
  }
  return ['main', typeof item === 'function' ? item() : item]
}

const schedule = (conversationId: string, batches: Scheduled[], done?: () => void) => {
  const handles = batches.map((item, index) =>
    setTimeout(
      () => {
        const [agentId, ops] = resolve(item)
        broadcast(conversationId, ops, agentId)
      },
      BEAT_MS * (index + 1),
    ),
  )
  handles.push(setTimeout(() => done?.(), BEAT_MS * (batches.length + 1)))
  timers.set(conversationId, [...(timers.get(conversationId) ?? []), ...handles])
}

const stopTurn = (conversationId: string) => {
  for (const handle of timers.get(conversationId) ?? []) clearTimeout(handle)
  timers.delete(conversationId)
  const active = running.get(conversationId)
  running.delete(conversationId)
  if (active === undefined) return
  const childId = `${active.turnId}-child`
  const child = children.get(childId)
  if (child !== undefined && !child.done) {
    children.set(childId, { ...child, done: true })
    broadcast(
      conversationId,
      [
        {
          op: 'turn.upsert',
          turn: {
            content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
            endedAt: new Date().toISOString(),
            kind: 'turn',
            ordinal: 1,
            origin: { kind: 'user' },
            state: 'cancelled',
            turnId: 't1',
          },
        },
        { meta: { activity: 'idle' }, op: 'meta.merge' },
      ],
      childId,
    )
  }
  broadcast(conversationId, [
    {
      op: 'turn.upsert',
      turn: {
        endedAt: new Date().toISOString(),
        kind: 'turn',
        ordinal: active.ordinal,
        origin: { kind: 'user' },
        content: active.content,
        state: 'cancelled',
        triggerPromptId: active.promptId,
        turnId: active.turnId,
      },
    },
    {
      op: 'prompt.upsert',
      prompt: {
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        promptId: active.promptId,
        status: 'aborted',
      },
    },
    { meta: { activity: 'idle' }, op: 'meta.merge' },
  ])
  drain(conversationId)
}

const settleApproval = (conversationId: string, approved: boolean) => {
  const now = new Date().toISOString()
  broadcast(conversationId, [
    {
      interaction: { ...pendingApproval, state: approved ? 'approved' : 'rejected' },
      op: 'interaction.upsert',
    },
    {
      frame: approvalFrame(approved ? 'done' : 'error'),
      op: 'frame.upsert',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
    {
      frame: {
        frameId: `${APPROVAL_STEP_ID}.f5`,
        kind: 'text',
        role: 'assistant',
        text: approved ? '封面写好了。' : '好，这一步跳过。',
      },
      op: 'frame.upsert',
      stepId: APPROVAL_STEP_ID,
      turnId: APPROVAL_TURN_ID,
    },
    {
      op: 'step.upsert',
      step: {
        endedAt: now,
        kind: 'step',
        ordinal: 1,
        state: 'completed',
        stepId: APPROVAL_STEP_ID,
        turnId: APPROVAL_TURN_ID,
      },
      turnId: APPROVAL_TURN_ID,
    },
    {
      op: 'turn.upsert',
      turn: {
        endedAt: now,
        kind: 'turn',
        ordinal: 3,
        origin: { kind: 'user' },
        content: [{ text: APPROVAL_PROMPT_TEXT, type: 'text' }],
        state: 'completed',
        turnId: APPROVAL_TURN_ID,
      },
    },
    {
      op: 'prompt.upsert',
      prompt: {
        createdAt: '2026-08-31T02:10:00Z',
        finishedAt: now,
        promptId: APPROVAL_PROMPT_ID,
        status: 'completed',
      },
    },
    { meta: { activity: 'idle' }, op: 'meta.merge' },
  ])
  running.delete(conversationId)
  drain(conversationId)
}

const drain = (conversationId: string) => {
  const queue = queues.get(conversationId) ?? []
  const next = queue.shift()
  queues.set(conversationId, queue)
  if (next !== undefined) playTurn(conversationId, next)
}

const steerInto = (conversationId: string, prompt: Prompt) => {
  const active = running.get(conversationId)
  if (active === undefined) {
    playTurn(conversationId, prompt)
    return
  }
  const stepId = `${active.turnId}.1`
  broadcast(conversationId, [
    {
      op: 'prompt.upsert',
      prompt: { createdAt: new Date().toISOString(), promptId: prompt.promptId, status: 'running' },
    },
    {
      op: 'frame.upsert',
      frame: {
        content: prompt.content,
        frameId: `${stepId}.steer`,
        kind: 'text',
        promptIds: [prompt.promptId],
        role: 'user',
        text: prompt.text,
      },
      stepId,
      turnId: active.turnId,
    },
  ])
  schedule(conversationId, [
    [
      {
        op: 'frame.upsert',
        frame: { frameId: `${stepId}.f4`, kind: 'text', role: 'assistant', text: '收到，一起做。' },
        stepId,
        turnId: active.turnId,
      },
    ],
  ])
}

const playTurn = (conversationId: string, prompt: Prompt) => {
  turns += 1
  const turnId = `t${turns}`
  const stepId = `${turnId}.1`
  const ordinal = turns
  const now = new Date().toISOString()
  running.set(conversationId, { ...prompt, ordinal, turnId })

  const matches = [
    { file: 'shots/s01.md', line: 4, text: '运镜：缓推' },
    { file: 'shots/s02.md', line: 9, text: '运镜：横移跟随' },
    { file: 'shots/s03.md', line: 2, text: '运镜幅度小于半个画面' },
  ]
  const tool = (state: 'running' | 'done') => ({
    op: 'frame.upsert',
    frame: {
      display: { kind: 'search', query: '运镜' },
      frameId: `${stepId}.call`,
      kind: 'tool',
      name: 'search_files',
      state,
      toolCallId: `${turnId}-call`,
      view: 'search_results',
      ...(state === 'done'
        ? {
            metadata: { matches, query: '运镜', truncated: false },
            output: matches.map((m) => `${m.file}:${m.line}\t${m.text}`).join('\n'),
          }
        : {}),
    },
    stepId,
    turnId,
  })
  const tool2 = (state: 'running' | 'done') => ({
    op: 'frame.upsert',
    frame: {
      display: { kind: 'file_io', operation: 'write', path: 'shots/storyboard.md' },
      frameId: `${stepId}.call2`,
      kind: 'tool',
      name: 'write_file',
      state,
      toolCallId: `${turnId}-call2`,
      ...(state === 'done'
        ? { metadata: { chip: '1.2 KB' }, output: '已写入 shots/storyboard.md（1234 字节）' }
        : {}),
    },
    stepId,
    turnId,
  })
  const turnHeader = (state: 'running' | 'completed') => ({
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      ordinal,
      origin: { kind: 'user' },
      content: prompt.content,
      startedAt: now,
      state,
      triggerPromptId: prompt.promptId,
      turnId,
      ...(state === 'completed'
        ? {
            endedAt: new Date().toISOString(),
            usage: { cachedTokens: 3080, inputTokens: 8230, outputTokens: 964 },
          }
        : {}),
    },
  })
  const finished = () => {
    timers.delete(conversationId)
    running.delete(conversationId)
    drain(conversationId)
  }

  const script = scripts.get(conversationId)
  if (script !== undefined) {
    broadcast(conversationId, [
      {
        op: 'prompt.upsert',
        prompt: { createdAt: now, promptId: prompt.promptId, status: 'running' },
      },
      turnHeader('running'),
      { meta: { activity: 'turn' }, op: 'meta.merge' },
    ])
    schedule(
      conversationId,
      [
        ...script({ turnId }),
        () => [
          turnHeader('completed'),
          {
            op: 'prompt.upsert',
            prompt: {
              createdAt: now,
              finishedAt: new Date().toISOString(),
              promptId: prompt.promptId,
              status: 'completed',
            },
          },
          { meta: { activity: 'idle' }, op: 'meta.merge' },
        ],
      ],
      finished,
    )
    return
  }

  const childId = `${turnId}-child`
  const delegateCallId = `${turnId}-delegate`
  children.set(childId, { done: false, text: '' })
  const childSays = (text: string, done: boolean) => (): Batch => {
    children.set(childId, { done, text })
    return [
      {
        op: 'frame.upsert',
        frame: { frameId: 't1.1.f2', kind: 'text', role: 'assistant', text },
        stepId: 't1.1',
        turnId: 't1',
      },
      ...(done
        ? [
            {
              op: 'step.upsert',
              step: {
                endedAt: new Date().toISOString(),
                kind: 'step',
                ordinal: 1,
                startedAt: now,
                state: 'completed',
                stepId: 't1.1',
                turnId: 't1',
              },
              turnId: 't1',
            },
            {
              op: 'turn.upsert',
              turn: {
                content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
                durationMs: BEAT_MS * 3,
                endedAt: new Date().toISOString(),
                kind: 'turn',
                ordinal: 1,
                origin: { kind: 'user' },
                startedAt: now,
                state: 'completed',
                turnId: 't1',
              },
            },
            { meta: { activity: 'idle' }, op: 'meta.merge' },
          ]
        : []),
    ]
  }

  broadcast(conversationId, [
    {
      op: 'prompt.upsert',
      prompt: { createdAt: now, promptId: prompt.promptId, status: 'running' },
    },
    turnHeader('running'),
  ])

  schedule(
    conversationId,
    [
      [
        {
          op: 'step.upsert',
          step: { kind: 'step', ordinal: 1, startedAt: now, state: 'running', stepId, turnId },
          turnId,
        },
        {
          op: 'frame.upsert',
          frame: { frameId: `${stepId}.f2`, kind: 'thinking', text: DEMO_THINKING },
          stepId,
          turnId,
        },
        tool('running'),
      ],
      [tool('done'), tool2('running')],
      [
        tool2('done'),
        {
          frame: delegateCard(delegateCallId, childId, stepId, 'running'),
          op: 'frame.upsert',
          stepId,
          turnId,
        },
      ],
      {
        agent: childId,
        ops: [
          {
            op: 'turn.upsert',
            turn: {
              content: [{ text: MOCK_CHILD_TASK, type: 'text' }],
              kind: 'turn',
              ordinal: 1,
              origin: { kind: 'user' },
              startedAt: now,
              state: 'running',
              turnId: 't1',
            },
          },
          { meta: { activity: 'turn' }, op: 'meta.merge' },
          {
            op: 'step.upsert',
            step: {
              kind: 'step',
              ordinal: 1,
              startedAt: now,
              state: 'running',
              stepId: 't1.1',
              turnId: 't1',
            },
            turnId: 't1',
          },
          {
            op: 'frame.upsert',
            frame: { frameId: 't1.1.f1', kind: 'thinking', text: '先定每一镜的景别。' },
            stepId: 't1.1',
            turnId: 't1',
          },
        ],
      },
      { agent: childId, ops: childSays('S3-1 特写：鞋头压过水面；', false) },
      { agent: childId, ops: childSays(MOCK_CHILD_REPLY, true) },
      [
        {
          frame: delegateCard(delegateCallId, childId, stepId, 'done'),
          op: 'frame.upsert',
          stepId,
          turnId,
        },
        {
          op: 'frame.upsert',
          frame: { frameId: `${stepId}.f3`, kind: 'text', role: 'assistant', text: '' },
          stepId,
          turnId,
        },
      ],
      ...DEMO_CHUNKS.map((text, index) => [
        {
          offset: DEMO_CHUNKS.slice(0, index).join('').length,
          op: 'append',
          target: { frameId: `${stepId}.f3`, stepId, turnId, type: 'frame' },
          text,
        },
      ]),
      () => [
        {
          op: 'step.upsert',
          step: {
            endedAt: new Date().toISOString(),
            kind: 'step',
            ordinal: 1,
            state: 'completed',
            stepId,
            turnId,
          },
          turnId,
        },
        turnHeader('completed'),
        {
          op: 'prompt.upsert',
          prompt: {
            createdAt: now,
            finishedAt: new Date().toISOString(),
            promptId: prompt.promptId,
            status: 'completed',
          },
        },
      ],
    ],
    finished,
  )
}

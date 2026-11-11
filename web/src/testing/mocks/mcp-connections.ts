import { http, HttpResponse } from 'msw'
import { zMcpCompleteIn } from '@/shared/api/generated/zod.gen'
import type { MockMcpUserServer } from './mcp-servers'
import type { MockShowcase } from './transcript'

// 「用户的连接」的 Mock（contract/conventions.md §22）。有哪些服务出自 mcp-servers.ts，这里只管各人的连接。
//
// dev:mock 下连接状态存在 localStorage 的 `cue.mock.mcp-connections`，登录弹窗与发起页共用同一份；
// 想看某个状态时直接改这项，例如 {"tester":{"pickfu":{"state":"invalid","account":null}}} 后刷新。
// 回调页的失败分支：state 里含 foreign / expired / fail，或直接带 ?error=access_denied 打开 /mcp/callback。

type ConnectionState = 'connected' | 'invalid' | 'none'

type Connection = { state: ConnectionState; account: string | null; scopes?: readonly string[] }

type Book = Record<string, Record<string, Connection>>

const STORAGE_KEY = 'cue.mock.mcp-connections'
const CONNECTED_AT = '2026-11-09T08:00:00Z'
const DEMO_ACCOUNT = 'demo@example.com'
const SIGN_IN_SCOPES = ['openid', 'email', 'profile', 'offline_access']

// 治理者（配置页的管理员）已经连着 PickFu，配置页打开就能测试连接。
const seedBook = (): Book => ({
  governor: {
    pickfu: {
      account: DEMO_ACCOUNT,
      scopes: [...SIGN_IN_SCOPES, 'read', 'write', 'spend'],
      state: 'connected',
    },
  },
})

let attached: Record<string, readonly string[]> = {}
let attachedDraft: Record<string, readonly string[]> = {}
let book: Book = seedBook()
let listQueries: string[] = []
let storage: Storage | null = null

const load = (): Book => {
  if (storage === null) return book
  const raw = storage.getItem(STORAGE_KEY)
  if (raw === null) return book
  try {
    return { ...book, ...(JSON.parse(raw) as Book) }
  } catch {
    return book
  }
}

const save = (next: Book) => {
  book = next
  storage?.setItem(STORAGE_KEY, JSON.stringify(next))
}

const connectionOf = (username: string, serverId: string): Connection =>
  load()[username]?.[serverId] ?? { account: null, state: 'none' }

const setConnection = (username: string, serverId: string, connection: Connection) => {
  const current = load()
  save({ ...current, [username]: { ...current[username], [serverId]: connection } })
}

/** 这个人在这个服务上的连接状态。 */
export const mockMcpConnectionState = (username: string, serverId: string): ConnectionState =>
  connectionOf(username, serverId).state

const rewrite = (serverId: string, next: (connection: Connection) => Connection | null) => {
  const current = load()
  save(
    Object.fromEntries(
      Object.entries(current).map(([username, connections]) => {
        const { [serverId]: mine, ...others } = connections
        const changed = mine === undefined ? null : next(mine)
        return [username, changed === null ? others : { ...others, [serverId]: changed }]
      }),
    ),
  )
}

/** 所有人在这个服务上的连接都没了。 */
export const endMockMcpConnections = (serverId: string) => rewrite(serverId, () => null)

/** 所有连着这个服务的人都要重新连接。 */
export const invalidateMockMcpConnections = (serverId: string) =>
  rewrite(serverId, (connection) =>
    connection.state === 'connected' ? { ...connection, state: 'invalid' } : connection,
  )

const conflict = (code: string, detail: string) =>
  HttpResponse.json({ code, detail }, { status: 409 })

/** 列表请求带的查询串，按收到的先后。 */
export const mockMcpConnectionQueries = (): readonly string[] => [...listQueries]

export const resetMockMcpConnections = () => {
  listQueries = []
  attached = {}
  attachedDraft = {}
  book = seedBook()
  storage = null
}

/** 设定各 Agent（当前版本与草稿）挂着的服务与各用户的连接；没给的那项保持原样。 */
export const setMockMcpConnections = ({
  agents,
  drafts,
  users,
}: {
  agents?: Record<string, readonly string[]>
  drafts?: Record<string, readonly string[]>
  users?: Book
}) => {
  if (agents !== undefined) attached = agents
  if (drafts !== undefined) attachedDraft = drafts
  if (users !== undefined) book = users
}

/** dev:mock 的演示数据；`persistIn` 让登录弹窗与发起连接的页面看到同一份连接状态。 */
export const seedMockMcpConnections = (persistIn: Storage) => {
  setMockMcpConnections({
    agents: { replica: ['pickfu', 'user-insights'], storyboard: ['pickfu'] },
    drafts: { director: ['pickfu'] },
  })
  storage = persistIn
}

/** 一次因连接已失效而失败的 MCP 工具调用（服务名 · 工具显示名 + 失败原因）。 */
export const mcpExpiredShowcase: MockShowcase = {
  title: '首帧吸引力调研',
  turns: () => [
    {
      content: [{ text: '拿这两版首帧做个调研，看哪版更吸引人', type: 'text' }],
      durationMs: 6_000,
      endedAt: '2026-11-10T02:00:06Z',
      kind: 'turn',
      ordinal: 1,
      origin: { kind: 'user' },
      startedAt: '2026-11-10T02:00:00Z',
      state: 'completed',
      steps: [
        {
          endedAt: '2026-11-10T02:00:06Z',
          frames: [
            {
              display: { kind: 'generic', summary: 'PickFu · 查看调研' },
              error: 'PickFu 连接已失效，请重新连接',
              frameId: 't1.1.f1',
              input: { survey_id: 'svy_demo' },
              kind: 'tool',
              name: 'mcp_pickfu_get_survey',
              state: 'error',
              toolCallId: 'call_mcp_pickfu_1',
            },
            {
              frameId: 't1.1.f2',
              kind: 'text',
              role: 'assistant',
              text: 'PickFu 的连接已失效，重新连接后我再继续。',
            },
          ],
          kind: 'step',
          ordinal: 1,
          startedAt: '2026-11-10T02:00:00Z',
          state: 'completed',
          stepId: 't1.1',
          turnId: 't1',
        },
      ],
      triggerPromptId: 'p_mcp_showcase_1',
      turnId: 't1',
    },
  ],
}

/** 已有的对话（含测试预览）按哪个 Agent、是否草稿算；不是当前用户能发消息的对话时为 `undefined`。 */
type ConversationScope = (conversationId: string) => { agentId: string; draft: boolean } | undefined

const servicesOf = (agentId: string, draft: boolean) => (draft ? attachedDraft : attached)[agentId]

export const mcpConnectionHandlers = (
  username: () => string,
  conversationScope: ConversationScope,
  services: () => readonly MockMcpUserServer[],
) => [
  http.get('*/api/mcp-connections', ({ request }) => {
    const url = new URL(request.url)
    listQueries.push(url.search)
    const query = url.searchParams
    const conversationId = query.get('conversationId')
    const agentId = query.get('agentId')
    const draft = query.get('draft') === 'true'
    let ids: readonly string[] | null
    if (conversationId !== null) {
      if (agentId !== null || draft)
        return HttpResponse.json(
          { detail: 'conversationId 不能与 agentId 或 draft 一起给' },
          { status: 422 },
        )
      const scope = conversationScope(conversationId)
      if (scope === undefined) return HttpResponse.json({ detail: '没有这段对话' }, { status: 404 })
      ids = servicesOf(scope.agentId, scope.draft) ?? []
    } else if (agentId !== null) {
      const found = servicesOf(agentId, draft)
      if (found === undefined)
        return HttpResponse.json({ detail: '没有这个 Agent' }, { status: 404 })
      ids = found
    } else {
      ids = null
    }
    const items = services()
      .filter((service) => ids === null || ids.includes(service.id))
      .map((service) => {
        const { account, scopes, state } = connectionOf(username(), service.id)
        return {
          account,
          connectedAt: state === 'none' ? null : CONNECTED_AT,
          description: service.description,
          name: service.name,
          scopes: state === 'none' ? null : (scopes ?? null),
          serverId: service.id,
          state,
        }
      })
    return HttpResponse.json({ items })
  }),

  http.post('*/api/mcp-connections/complete', async ({ request }) => {
    const body = zMcpCompleteIn.parse(await request.json())
    if (body.state.includes('foreign'))
      return conflict('mcp_sign_in_foreign', '这次登录是别人发起的')
    if (body.state.includes('expired')) return conflict('mcp_sign_in_expired', '这次登录已失效')
    if (body.state.includes('fail')) return conflict('mcp_oauth_rejected', '授权服务器拒绝了')
    const service = services().find((item) => body.state.startsWith(`mock.${item.id}.`))
    if (service === undefined) return conflict('mcp_sign_in_expired', '这次登录已失效')
    setConnection(username(), service.id, {
      account: DEMO_ACCOUNT,
      scopes: service.oauth.requestedScopes ?? SIGN_IN_SCOPES,
      state: 'connected',
    })
    return HttpResponse.json({ account: DEMO_ACCOUNT, name: service.name, serverId: service.id })
  }),

  http.post('*/api/mcp-connections/:serverId/authorize', ({ params, request }) => {
    const serverId = String(params['serverId'])
    const service = services().find((item) => item.id === serverId)
    if (service === undefined) return HttpResponse.json({ detail: '没有这个服务' }, { status: 404 })
    if (service.oauth.client === 'required')
      return conflict(
        'mcp_client_required',
        '该服务不支持自动注册客户端，需要管理员先填写客户端 ID',
      )
    const origin = new URL(request.url).origin
    const state = `mock.${serverId}.${crypto.randomUUID()}`
    return HttpResponse.json({
      authorizationUrl: `${origin}/mcp/callback?state=${state}&code=mock-code`,
    })
  }),

  http.delete('*/api/mcp-connections/:serverId', ({ params }) => {
    setConnection(username(), String(params['serverId']), { account: null, state: 'none' })
    return new HttpResponse(null, { status: 204 })
  }),
]

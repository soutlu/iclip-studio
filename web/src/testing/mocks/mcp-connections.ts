import { http, HttpResponse } from 'msw'
import { zMcpCompleteIn } from '@/shared/api/generated/zod.gen'
import type { MockShowcase } from './transcript'

// 「用户的连接」的 Mock（contract/conventions.md §22）。服务清单暂时独立于 mcp-servers.ts，后续合并。
//
// dev:mock 下连接状态存在 localStorage 的 `cue.mock.mcp-connections`，登录弹窗与发起页共用同一份；
// 想看某个状态时直接改这项，例如 {"tester":{"pickfu":{"state":"invalid","account":null}}} 后刷新。
// 回调页的失败分支：state 里含 foreign / expired / fail，或直接带 ?error=access_denied 打开 /mcp/callback。

type ConnectionState = 'connected' | 'invalid' | 'none'

type Connection = { state: ConnectionState; account: string | null }

type Book = Record<string, Record<string, Connection>>

const SERVICES = [
  { description: '消费者调研', name: 'PickFu', serverId: 'pickfu' },
  { description: '查阅团队文档与创作资料', name: '飞书文档', serverId: 'feishu-docs' },
  { description: '品牌规范、Logo 与产品图', name: '品牌资产库', serverId: 'brand-assets' },
] as const

const STORAGE_KEY = 'cue.mock.mcp-connections'
const CONNECTED_AT = '2026-11-09T08:00:00Z'
const DEMO_ACCOUNT = 'demo@example.com'

let attached: Record<string, readonly string[]> = {}
let attachedDraft: Record<string, readonly string[]> = {}
let book: Book = {}
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

const conflict = (code: string, detail: string) =>
  HttpResponse.json({ code, detail }, { status: 409 })

/** 列表请求带的查询串，按收到的先后。 */
export const mockMcpConnectionQueries = (): readonly string[] => [...listQueries]

export const resetMockMcpConnections = () => {
  listQueries = []
  attached = {}
  attachedDraft = {}
  book = {}
  storage = null
}

/** 设定各 Agent（当前版本与草稿）挂着的服务与各用户的连接。 */
export const setMockMcpConnections = ({
  agents = {},
  drafts = {},
  users = {},
}: {
  agents?: Record<string, readonly string[]>
  drafts?: Record<string, readonly string[]>
  users?: Book
}) => {
  attached = agents
  attachedDraft = drafts
  book = users
}

/** dev:mock 的演示数据；`persistIn` 让登录弹窗与发起连接的页面看到同一份连接状态。 */
export const seedMockMcpConnections = (persistIn: Storage) => {
  setMockMcpConnections({
    agents: { replica: ['pickfu', 'feishu-docs', 'brand-assets'], storyboard: ['pickfu'] },
    drafts: { director: ['pickfu'] },
    users: {
      governor: { 'feishu-docs': { account: 'governor@example.com', state: 'connected' } },
      tester: { 'brand-assets': { account: DEMO_ACCOUNT, state: 'connected' } },
    },
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
) => [
  http.get('*/api/mcp-connections', ({ request }) => {
    const url = new URL(request.url)
    listQueries.push(url.search)
    const query = url.searchParams
    const conversationId = query.get('conversationId')
    const agentId = query.get('agentId')
    const draft = query.get('draft') === 'true'
    let ids: readonly string[] | undefined
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
      ids = servicesOf(agentId, draft)
      if (ids === undefined) return HttpResponse.json({ detail: '没有这个 Agent' }, { status: 404 })
    } else {
      ids = SERVICES.map((service) => service.serverId)
    }
    const items = SERVICES.filter((service) => ids.includes(service.serverId)).map((service) => {
      const { account, state } = connectionOf(username(), service.serverId)
      return {
        ...service,
        account,
        connectedAt: state === 'none' ? null : CONNECTED_AT,
        scopes: state === 'none' ? null : ['read', 'write'],
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
    const service = SERVICES.find((item) => body.state.startsWith(`mock.${item.serverId}.`))
    if (service === undefined) return conflict('mcp_sign_in_expired', '这次登录已失效')
    setConnection(username(), service.serverId, { account: DEMO_ACCOUNT, state: 'connected' })
    return HttpResponse.json({
      account: DEMO_ACCOUNT,
      name: service.name,
      serverId: service.serverId,
    })
  }),

  http.post('*/api/mcp-connections/:serverId/authorize', ({ params, request }) => {
    const serverId = String(params['serverId'])
    if (!SERVICES.some((service) => service.serverId === serverId))
      return HttpResponse.json({ detail: '没有这个服务' }, { status: 404 })
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
